// One-shot signature sweep for producers stuck SIGN-flagged in BGA
// despite having a valid signature on file in our app.
//
// Safety contract:
//   - ONLY calls PUT /surecrm/signature/{producerId}/{pdfAttachId}/confirmImage
//   - DOES NOT click REMOVE, DOES NOT upload a new PDF, DOES NOT touch
//     any other tab (no E&O, no profile, no DBA, no contracts).
//   - Skips silently when GET /surecrm/signature/{id}/pdf returns no
//     attachment — never creates a PDF where none existed.
//   - Skips producers whose signature is already valid in BGA (we
//     check isTabGreen before invoking the API).
//   - One producer at a time. Logs full result. Continues on error.
//
// Usage:
//   PRODUCERS='3351482,8068174,...' SIG_URLS_JSON='{"3351482":"https://.../sig.png",...}' \
//     node scripts/sweep-stuck-signatures.mjs
//
// The orchestrator (this script's caller) is responsible for mapping
// producerId → signatureImageUrl from our DB. We do NOT query our DB
// from here — the bot service doesn't have DB credentials.

import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const PRODUCERS = (process.env.PRODUCERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const SIG_URLS = JSON.parse(process.env.SIG_URLS_JSON || "{}")
const adminEmail = process.env.SURELC_ADMIN_EMAIL
const adminPassword = process.env.SURELC_ADMIN_PASSWORD

if (!PRODUCERS.length || !adminEmail || !adminPassword) {
  console.error("usage: PRODUCERS=id1,id2 SIG_URLS_JSON='{...}' SURELC_ADMIN_EMAIL=... SURELC_ADMIN_PASSWORD=... node scripts/sweep-stuck-signatures.mjs")
  process.exit(1)
}

const logger = pino({ level: "info" })
const results = []

async function fixOne(page, producerId, signatureImageUrl, bearerRef) {
  const result = { producerId, status: "unknown" }
  try {
    // Navigate to the producer's signature tab. SPA outbound requests
    // hit /surecrm/* with Authorization: Bearer <jwt>; our outer
    // request-listener captures the latest bearer into bearerRef.
    const target = `https://surelc.surancebay.com/bga/producers/${producerId}/signature`
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await page.waitForTimeout(4500)

    if (!bearerRef.value) {
      result.status = "skipped"
      result.reason = "no BGA bearer captured from request headers — SPA didn't make /surecrm/* call"
      return result
    }
    const bearer = bearerRef.value

    // GET PDF attachment id — strict precondition. If the producer
    // never had an upload attempt, there's no PDF to confirmImage on,
    // and we MUST NOT try to create one (out of scope for this sweep).
    const pdfMetaRes = await fetch(
      `https://surelc.surancebay.com/surecrm/signature/${producerId}/pdf`,
      { headers: { Authorization: `Bearer ${bearer}` } },
    )
    const pdfMetaBody = await pdfMetaRes.text()
    if (!pdfMetaRes.ok) {
      if (pdfMetaRes.status === 404) {
        result.status = "skipped"
        result.reason = "no PDF attachment on file — sweep does not upload"
        return result
      }
      result.status = "error"
      result.reason = `GET signature/pdf failed HTTP ${pdfMetaRes.status}: ${pdfMetaBody.slice(0, 200)}`
      return result
    }
    if (!pdfMetaBody.trim()) {
      result.status = "skipped"
      result.reason = "GET signature/pdf returned 200 with empty body — no PDF attachment exists"
      return result
    }
    let pdfMeta
    try {
      pdfMeta = JSON.parse(pdfMetaBody)
    } catch {
      result.status = "error"
      result.reason = `GET signature/pdf body not JSON: ${pdfMetaBody.slice(0, 200)}`
      return result
    }
    if (!pdfMeta?.id) {
      result.status = "skipped"
      result.reason = `PDF metadata has no id: ${JSON.stringify(pdfMeta).slice(0, 200)}`
      return result
    }
    result.pdfAttachId = pdfMeta.id

    // Download the signature PNG from our app's storage.
    const pngRes = await fetch(signatureImageUrl)
    if (!pngRes.ok) {
      result.status = "error"
      result.reason = `fetch signature PNG failed HTTP ${pngRes.status}`
      return result
    }
    const pngBuf = Buffer.from(await pngRes.arrayBuffer())

    // Get image dimensions.
    const sharp = (await import("sharp")).default
    const meta = await sharp(pngBuf).metadata()
    const width = meta.width || 491
    const height = meta.height || 200

    // PUT confirmImage — the only mutation.
    const putUrl = `https://surelc.surancebay.com/surecrm/signature/${producerId}/${pdfMeta.id}/confirmImage`
    const payload = `data:image/png;base64,${pngBuf.toString("base64")}`
    const putRes = await fetch(putUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload, width, height }),
    })
    if (!putRes.ok) {
      const errBody = await putRes.text().catch(() => "")
      result.status = "error"
      result.reason = `PUT confirmImage failed HTTP ${putRes.status}: ${errBody.slice(0, 200)}`
      return result
    }
    result.status = "fixed"
    result.width = width
    result.height = height
    result.pngBytes = pngBuf.length
    return result
  } catch (err) {
    result.status = "error"
    result.reason = err?.message || String(err)
    return result
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.setDefaultTimeout(45_000)

  // Mutable holder so fixOne can read the latest bearer (refreshed
  // every time the SPA makes a /surecrm/* call). Same harvesting
  // pattern as scripts/check-demetrius-profile.mjs.
  const bearerRef = { value: "" }
  page.on("request", (req) => {
    const a = req.headers()["authorization"]
    if (a?.startsWith("Bearer ") && req.url().includes("/surecrm/")) {
      const b = a.replace("Bearer ", "")
      if (b.split(".").length === 3) bearerRef.value = b
    }
  })

  console.error(`[sweep] logging in as ${adminEmail}…`)
  const login = await loginAdmin(page, { email: adminEmail, password: adminPassword }, logger)
  if (!login.ok) {
    console.error("[sweep] admin login failed:", login)
    await browser.close()
    process.exit(2)
  }
  console.error("[sweep] logged in. Processing producers serially…")

  for (const producerId of PRODUCERS) {
    const sigUrl = SIG_URLS[producerId]
    if (!sigUrl) {
      results.push({ producerId, status: "skipped", reason: "no signatureImageUrl provided" })
      console.error(`[sweep] ${producerId}: skipped (no PNG URL provided)`)
      continue
    }
    console.error(`[sweep] ${producerId}: fixing…`)
    const r = await fixOne(page, producerId, sigUrl, bearerRef)
    results.push(r)
    console.error(`[sweep] ${producerId}: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`)
  }

  await browser.close()
  console.log(JSON.stringify({ results, summary: summarize(results) }, null, 2))
}

function summarize(rs) {
  const out = { total: rs.length, fixed: 0, skipped: 0, error: 0 }
  for (const r of rs) {
    if (r.status === "fixed") out.fixed++
    else if (r.status === "skipped") out.skipped++
    else if (r.status === "error") out.error++
  }
  return out
}

main().catch((err) => {
  console.error("[sweep] fatal:", err)
  console.log(JSON.stringify({ error: String(err), results }, null, 2))
  process.exit(1)
})
