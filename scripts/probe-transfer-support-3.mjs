/**
 * Recon round 3 — pull the full swagger index, then scan all groups
 * for transfer / release / attachment / document endpoints. Also
 * probe producer-level document upload routes.
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
const log = pino()
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, log)

const bearerByRealm = {}
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (!a?.startsWith("Bearer ")) return
  const tok = a.replace("Bearer ", "")
  if (tok.split(".").length !== 3) return
  const realm = req.url().match(/surancebay\.com\/([^/]+)\//)?.[1]
  if (realm && !bearerByRealm[realm]) bearerByRealm[realm] = tok
})

async function navTo(p) {
  await page.evaluate((path) => {
    history.pushState({}, "", path)
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
  }, p)
  await page.waitForTimeout(3000)
}
await navTo("/bga/producers/11096584")
await navTo("/bga/producers/11096584/contracts")
await navTo("/bga/producers/11096584/profile")
await navTo("/bga/producers/11096584/documents")

const bearer = bearerByRealm.surecrm

// ─── 1) Full swagger index ────────────────────────────────────────
const idx = await fetch("https://surelc.surancebay.com/swagger-resources").then((r) => r.json())
console.log("─── Swagger groups:")
for (const g of idx) console.log(`  ${g.name.padEnd(35)}  ${g.location}`)

// ─── 2) For each group, dump only the paths matching the keywords. ────
const keywords = /transfer|release|recontract|lor|attach|document|file|upload|appointment-request|priorBroker/i
for (const g of idx) {
  try {
    const yamlText = await fetch(`https://surelc.surancebay.com${g.location}`).then((r) => r.text())
    // Crude grep on yaml — we only need the route lines and the method right below them.
    const lines = yamlText.split("\n")
    const hits = []
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (trimmed.startsWith("/") && trimmed.endsWith(":") && keywords.test(trimmed)) {
        // capture this route and the methods until the next route line
        let block = [trimmed]
        for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
          const nxt = lines[j]
          if (nxt.match(/^  \//)) break
          // capture method lines (4-space indented like "    get:" or "    put:")
          if (/^    (get|put|post|patch|delete):/.test(nxt)) block.push(nxt.trim())
        }
        hits.push(block.join("  "))
      }
    }
    if (hits.length) {
      console.log(`\n  [${g.name}]`)
      hits.forEach((h) => console.log(`    ${h}`))
    }
  } catch (err) {
    console.log(`  [${g.name}] swagger fetch failed: ${err.message}`)
  }
}

// ─── 3) Probe producer-level document endpoints ───────────────────────
if (bearer) {
  console.log("\n─── Probing producer document endpoints (Holton, 11096584):")
  const docPaths = [
    "/surecrm/producers/11096584/documents",
    "/surecrm/producers/11096584/files",
    "/surecrm/producers/11096584/attachments",
    "/surecrm/producers/11096584/release-forms",
    "/surecrm/producers/11096584/lor",
    "/surecrm/producers/11096584/lors",
  ]
  for (const p of docPaths) {
    const r = await fetch(`https://surelc.surancebay.com${p}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    console.log(`  GET ${p}  → HTTP ${r.status}`)
    if (r.ok) {
      const body = await r.text()
      console.log(`    body: ${body.slice(0, 500)}`)
    }
  }
}

await browser.close()
