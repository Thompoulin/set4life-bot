/**
 * Probe whether we can PATCH an appointment-request to change its
 * products. Test on Keyon's Foresters (id=116935372): currently
 * lifeVariable,lifeFixed — try changing to lifeFixed only (same as
 * Sydney's signed Foresters).
 *
 * Run with --execute to actually patch; default is dry-run via OPTIONS
 * + minimal probe payloads.
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const EXECUTE = process.argv.includes("--execute")
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

const id = 116935372 // Keyon Foresters

// First fetch current state
const cur = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${id}`, {
  headers: { Authorization: `Bearer ${bearer}` },
}).then(r => r.json())
console.log("Current Keyon Foresters:")
console.log("  products:", cur.products)
console.log("  carrierProducts:", JSON.stringify(cur.carrierProducts))

// OPTIONS to see allowed methods
const opt = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${id}`, {
  method: "OPTIONS",
  headers: { Authorization: `Bearer ${bearer}` },
})
console.log("\nOPTIONS allows:", opt.headers.get("allow") || opt.headers.get("access-control-allow-methods"))

// Try patching to lifeFixed only
const patched = {
  ...cur,
  products: "lifeFixed",
  carrierProducts: cur.carrierProducts.filter((p) => p.alias === "lifeFixed"),
}

if (!EXECUTE) {
  console.log("\n(dry-run) would PUT/PATCH with:")
  console.log("  products:", patched.products)
  console.log("  carrierProducts:", JSON.stringify(patched.carrierProducts))
  console.log("\nPass --execute to actually patch")
  await browser.close()
  process.exit(0)
}

// Try PUT, then PATCH
for (const method of ["PUT", "PATCH"]) {
  const r = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${id}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(patched),
  })
  const t = (await r.text()).slice(0, 400)
  console.log(`\n${method} → ${r.status}: ${t}`)
  if (r.ok) { console.log("\n*** SUCCESS ***"); break }
}

await browser.close()
