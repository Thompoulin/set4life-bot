/**
 * Recon round 4e — capture the list endpoint, look at real existing
 * attachments to figure out:
 *   - formType enum values actually used (LOR-equivalent?)
 *   - carrierId / entityId linkage pattern
 *   - PATCH / PUT to set formType after upload
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
const apiGets = []
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (!bearer && req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
    const tok = a.replace("Bearer ", "")
    if (tok.split(".").length === 3) bearer = tok
  }
  if (req.method() === "GET" && req.url().includes("/surecrm/")) apiGets.push(req.url())
})

await page.evaluate(() => {
  history.pushState({}, "", "/bga/producers/11096584/documents")
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(5000)

console.log("─── 1) /surecrm/ GETs while loading Documents page:")
const interesting = apiGets.filter((u) => /attach|document|form/i.test(u))
for (const u of interesting.slice(0, 15)) console.log(`  ${u}`)

// ── 2) For the first attachment-list-ish URL found, fetch + inspect ───
const listUrl = interesting.find((u) => /\/attachments|\/documents|\/forms/i.test(u))
if (listUrl) {
  console.log(`\n─── 2) Fetching list URL: ${listUrl}`)
  const r = await fetch(listUrl, { headers: { Authorization: `Bearer ${bearer}` } })
  console.log(`  HTTP ${r.status}`)
  if (r.ok) {
    const data = await r.json()
    const items = Array.isArray(data) ? data : data?.items || data?.content || data
    if (Array.isArray(items)) {
      console.log(`  ${items.length} items`)
      // Group by formType
      const byType = {}
      for (const a of items) {
        const key = a.formType ?? "(unknown)"
        if (!byType[key]) byType[key] = []
        byType[key].push(a)
      }
      for (const [type, rows] of Object.entries(byType)) {
        console.log(`\n  formType="${type}" — ${rows.length} files:`)
        for (const a of rows.slice(0, 5)) {
          console.log(`    id=${a.id} carrierId=${a.carrierId} entityId=${a.entityId} isLinked=${a.isLinked} "${(a.uploadedFileName || a.description || "").slice(0, 50)}"`)
        }
      }
      // Take one with carrierId set + look at its full row
      const linked = items.find((a) => a.carrierId && a.carrierId !== 0) || items[0]
      if (linked) {
        console.log(`\n  Sample full row (id=${linked.id}):`)
        console.log(JSON.stringify(linked, null, 2).split("\n").slice(0, 30).join("\n"))
      }
    } else {
      console.log(`  unexpected shape: ${JSON.stringify(data).slice(0, 400)}`)
    }
  }
}

// ── 3) Try Sydney (has E&O / signed contracts) for richer attachments ────
console.log("\n─── 3) Sydney attachments (richer producer)")
const altLists = [
  `/surecrm/attachments/list?producerId=11482453`,
  `/surecrm/forms?producerId=11482453`,
  `/surecrm/documents?producerId=11482453`,
]
for (const u of altLists) {
  const r = await fetch(`https://surelc.surancebay.com${u}`, { headers: { Authorization: `Bearer ${bearer}` } })
  console.log(`  GET ${u} → ${r.status}`)
}

await browser.close()
