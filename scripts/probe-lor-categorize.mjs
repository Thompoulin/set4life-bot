/**
 * Recon round 4d — now that we know the upload endpoint, figure out:
 *   - How to categorize the upload as an LOR (formType value)
 *   - How to link it to a specific carrier appointment
 *   - Delete the test PDF we just uploaded (id=208362367)
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const log = pino()
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, log)

let bearer = ""
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (!bearer && req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
    const tok = a.replace("Bearer ", "")
    if (tok.split(".").length === 3) bearer = tok
  }
})

await page.evaluate(() => {
  history.pushState({}, "", "/bga/producers/11096584/documents")
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(3500)

console.log(`[bearer] ${bearer ? "captured" : "MISSING"}`)
if (!bearer) { await browser.close(); process.exit(1) }

// ── 1) List all attachments to find both the dummy + look at formType values used in real attachments
console.log("\n─── 1) List attachments — what formType values exist?")
const list = await fetch(
  `https://surelc.surancebay.com/surecrm/attachments?producerId=11096584`,
  { headers: { Authorization: `Bearer ${bearer}` } },
)
console.log(`  GET /surecrm/attachments?producerId=11096584 → HTTP ${list.status}`)
if (list.ok) {
  const arr = await list.json()
  console.log(`  count: ${Array.isArray(arr) ? arr.length : "?"}`)
  if (Array.isArray(arr)) {
    const byType = {}
    for (const a of arr) {
      const key = `${a.formType}`
      if (!byType[key]) byType[key] = []
      byType[key].push({ id: a.id, name: a.uploadedFileName, carrierId: a.carrierId, entityId: a.entityId, status: a.status, isLinked: a.isLinked })
    }
    for (const [type, rows] of Object.entries(byType)) {
      console.log(`\n  formType="${type}" — ${rows.length} files:`)
      for (const r of rows.slice(0, 5)) console.log(`    id=${r.id} carrier=${r.carrierId} entity=${r.entityId} linked=${r.isLinked} "${r.name}"`)
    }
  }
}

// ── 2) Probe alternate list endpoint
console.log("\n─── 2) Try /surecrm/producers/{id}/attachments")
const alt = await fetch(
  `https://surelc.surancebay.com/surecrm/producers/11096584/attachments`,
  { headers: { Authorization: `Bearer ${bearer}` } },
)
console.log(`  HTTP ${alt.status}`)

// ── 3) Find form types enum (might be in a separate endpoint)
console.log("\n─── 3) Probe form-types enum")
const tries = [
  "/surecrm/form-types",
  "/surecrm/document-types",
  "/surecrm/attachment-types",
  "/surecrm/attachments/types",
  "/surecrm/attachments/form-types",
  "/surecrm/enums/formType",
]
for (const t of tries) {
  const r = await fetch(`https://surelc.surancebay.com${t}`, { headers: { Authorization: `Bearer ${bearer}` } })
  console.log(`  GET ${t} → ${r.status}`)
  if (r.ok) {
    const body = await r.text()
    console.log(`    body[0..400]: ${body.slice(0, 400)}`)
  }
}

// ── 4) Delete the test PDF
console.log("\n─── 4) Cleanup: delete test upload id=208362367")
const del = await fetch(
  `https://surelc.surancebay.com/surecrm/attachments/208362367`,
  { method: "DELETE", headers: { Authorization: `Bearer ${bearer}` } },
)
console.log(`  DELETE /surecrm/attachments/208362367 → HTTP ${del.status}`)
if (!del.ok) console.log(`    body: ${(await del.text()).slice(0, 200)}`)

// Also try variants
const delVariants = [
  `/surecrm/attachments/208362367`,
  `/surecrm/producers/11096584/attachments/208362367`,
  `/surecrm/attachments/11096584/208362367`,
]
for (const v of delVariants) {
  const r = await fetch(`https://surelc.surancebay.com${v}`, { method: "DELETE", headers: { Authorization: `Bearer ${bearer}` } })
  console.log(`  DELETE ${v} → ${r.status}`)
}

// ── 5) Look at the JS bundle for the upload form data field names / formType enum
console.log("\n─── 5) JS bundle keyword search")
const scripts = await page.$$eval("script[src]", (els) =>
  els.map((e) => e.src).filter((s) => /surancebay/.test(s)),
)
console.log(`  ${scripts.length} scripts loaded`)
for (const s of scripts) {
  try {
    const body = await fetch(s).then((r) => r.text())
    const hits = []
    const patterns = [/formType\s*[:=]\s*["'`]([^"'`]+)["'`]/g, /LOR|letterOfRelease|releaseForm/g]
    for (const p of patterns) {
      let m
      while ((m = p.exec(body)) && hits.length < 40) {
        hits.push(m[0])
      }
    }
    if (hits.length) {
      console.log(`\n  ${s.split("/").pop()}:`)
      for (const h of new Set(hits)) console.log(`    ${h}`)
    }
  } catch {}
}

await browser.close()
