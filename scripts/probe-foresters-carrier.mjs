/**
 * Probe Foresters' carrier metadata to see what it requires that other
 * carriers don't (which might be why Keyon's review wizard rejects).
 * Compare with a working carrier (F&G or Banner Life — Keyon signed both).
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, pino())
let bearer = null
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (!bearer && req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
    const b = a.replace("Bearer ", "")
    if (b.split(".").length === 3) bearer = b
  }
})
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/5331616"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)
console.log("bearer:", !!bearer)

// Compare two appointment-requests: Foresters (stuck) vs F&G (signed)
const foresters = 116935372 // Producer-stage stuck
const fng = 116935361        // Carrier-stage signed

for (const id of [foresters, fng]) {
  const r = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${id}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  const data = await r.json()
  console.log(`\n=== Appointment ${id} (${data.carrierName}) — stage=${data.stage} ===`)
  console.log("  states:", data.states)
  console.log("  products:", data.products)
  console.log("  carrierProducts:", JSON.stringify(data.carrierProducts))
  console.log("  reviewed:", data.reviewed)
  console.log("  paperworkDate:", data.paperworkDate)
  console.log("  carrierStatus:", data.carrierStatus)
  console.log("  comments:", (data.comments || "").slice(0, 200))
  console.log("  digitalSignature:", data.digitalSignature)
}

// Also fetch carrier-side info — what does Foresters require?
console.log("\n=== Foresters carrier (id=" + 71412 + " from API) ===")
// Try various carrier endpoints
for (const path of [
  "/surecrm/carriers",
  "/surecrm/carrier/Foresters",
  "/surecrm/carrier-products?carrierId=71412",
  "/surecrm/carriers/71412/products",
  "/api/v2/carriers/71412",
]) {
  const r = await fetch(`https://surelc.surancebay.com${path}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  if (r.status !== 404) {
    const t = (await r.text()).slice(0, 400)
    console.log(`  GET ${path} → ${r.status}: ${t.slice(0, 200)}`)
  }
}

// Check rep producer detail — what's missing in Keyon's profile that matters for Foresters?
console.log("\n=== Keyon producer detail ===")
for (const path of [
  "/surecrm/producer/5331616",
  "/surecrm/producers/5331616",
  "/surecrm/producer/5331616/profile",
  "/surecrm/producer/5331616/licenses",
  "/surecrm/producer/5331616/products",
  "/surecrm/producer/5331616/training",
  "/surecrm/producer/5331616/aml",
  "/surecrm/training/producer/5331616",
  "/surecrm/license/producer/5331616",
]) {
  const r = await fetch(`https://surelc.surancebay.com${path}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  if (r.status !== 404) {
    const t = (await r.text()).slice(0, 800)
    console.log(`  GET ${path} → ${r.status}: ${t}`)
  }
}

await browser.close()
