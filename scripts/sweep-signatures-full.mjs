// Full signature sweep: POST /uploadForm + PUT /confirmImage for each
// producer. Verified flow against Perrion 2026-05-26.

import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"

// Map: producerId → { pdfUrl, pngUrl }
const TARGETS = JSON.parse(process.env.TARGETS_JSON || "{}")
const producerIds = Object.keys(TARGETS)
if (!producerIds.length || !process.env.SURELC_ADMIN_EMAIL) {
  console.error("usage: TARGETS_JSON='{\"3351482\":{\"pdf\":\"...\",\"png\":\"...\"}}' SURELC_ADMIN_EMAIL=... SURELC_ADMIN_PASSWORD=... node sweep-signatures-full.mjs")
  process.exit(1)
}

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
page.setDefaultTimeout(60_000)
let bearer = ""
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (a?.startsWith("Bearer ") && req.url().includes("/surecrm/")) bearer = a.replace("Bearer ", "")
})

const logger = pino({ level: "info" })
const login = await loginAdmin(page, { email: process.env.SURELC_ADMIN_EMAIL, password: process.env.SURELC_ADMIN_PASSWORD }, logger)
if (!login.ok) {
  console.error("login failed:", login)
  process.exit(2)
}

const results = []

for (const producerId of producerIds) {
  const { pdf: pdfUrl, png: pngUrl } = TARGETS[producerId]
  const result = { producerId, status: "unknown" }
  console.error(`\n[${producerId}] fixing…`)
  try {
    // Navigate so we have a fresh bearer
    await gotoBga(page, `https://surelc.surancebay.com/bga/producers/${producerId}/signature`, logger)
    await page.waitForTimeout(3000)
    if (!bearer) {
      result.status = "skipped"; result.reason = "no bearer"
      results.push(result)
      continue
    }

    // Pre-check: already clean?
    const pre = await fetch(`https://surelc.surancebay.com/surecrm/validation/list`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify([Number(producerId)]),
    })
    const preList = await pre.json()
    const hasMissingSig = preList.some((w) => w.code === "SIGNATURE:MISSING_SIGNATURE_AUTHORIZATION")
    if (!hasMissingSig) {
      result.status = "skipped"; result.reason = "signature already on file"
      console.error(`  ${producerId}: skipped (no missing-sig warning)`)
      results.push(result)
      continue
    }

    const pdfBuf = Buffer.from(await (await fetch(pdfUrl)).arrayBuffer())
    const pngBuf = Buffer.from(await (await fetch(pngUrl)).arrayBuffer())
    const sharp = (await import("sharp")).default
    const meta = await sharp(pngBuf).metadata()
    const width = meta.width || 491
    const height = meta.height || 200

    // Step 1: upload PDF
    const fd = new FormData()
    fd.append("file", new Blob([pdfBuf], { type: "application/pdf" }), "signature-authorization.pdf")
    const up = await fetch(`https://surelc.surancebay.com/surecrm/signature/${producerId}/uploadForm`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}` },
      body: fd,
    })
    if (!up.ok) {
      const t = await up.text().catch(() => "")
      result.status = "error"; result.reason = `uploadForm HTTP ${up.status}: ${t.slice(0, 200)}`
      console.error(`  ${producerId}: ${result.reason}`)
      results.push(result)
      continue
    }
    const upJson = await up.json()
    const formId = upJson.uid || upJson.id
    if (!formId) {
      result.status = "error"; result.reason = "no formId returned"
      results.push(result); continue
    }

    // Step 2: confirm image
    const payload = `data:image/png;base64,${pngBuf.toString("base64")}`
    const conf = await fetch(`https://surelc.surancebay.com/surecrm/signature/${producerId}/${formId}/confirmImage`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ payload, width, height }),
    })
    if (!conf.ok) {
      const t = await conf.text().catch(() => "")
      result.status = "error"; result.reason = `confirmImage HTTP ${conf.status}: ${t.slice(0, 200)}`
      console.error(`  ${producerId}: ${result.reason}`)
      results.push(result); continue
    }

    // Step 3: verify
    const post = await fetch(`https://surelc.surancebay.com/surecrm/validation/list`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify([Number(producerId)]),
    })
    const postList = await post.json()
    const stillMissing = postList.some((w) => w.code === "SIGNATURE:MISSING_SIGNATURE_AUTHORIZATION")
    result.status = stillMissing ? "fixed_but_flag_remains" : "fixed"
    result.formId = formId
    result.pngBytes = pngBuf.length
    console.error(`  ${producerId}: ${result.status}, formId=${formId}`)
    results.push(result)
  } catch (e) {
    result.status = "error"; result.reason = e.message || String(e)
    console.error(`  ${producerId}: ERROR ${result.reason}`)
    results.push(result)
  }
}

console.log(JSON.stringify({ results, summary: {
  total: results.length,
  fixed: results.filter((r) => r.status === "fixed").length,
  skipped: results.filter((r) => r.status === "skipped").length,
  error: results.filter((r) => r.status === "error").length,
  flag_remains: results.filter((r) => r.status === "fixed_but_flag_remains").length,
}}, null, 2))

await browser.close()
