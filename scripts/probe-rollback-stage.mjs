/**
 * Test if SureLC accepts a stage rollback (Carrier → Producer) so
 * the rep-review wizard can re-trigger for an appointment that was
 * created via direct POST (skipping the rep-review step).
 *
 * Target: Demetrius's Foresters appointment (created via direct POST,
 * stage=Carrier but reviewed=undefined).
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
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/7533541"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)

// Find one of Demetrius's Carrier-stage (unsigned) appointments
const list = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests?producerId=7533541&gaId=1322`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
const unsigned = list.find((a) => a.stage === "Carrier" && !a.reviewed)
if (!unsigned) { console.log("no unsigned Carrier appointments found"); await browser.close(); process.exit(0) }
console.log(`Target: ${unsigned.carrierName} id=${unsigned.appointmentRequestId} stage=${unsigned.stage} reviewed=${unsigned.reviewed} carrierStatus=${unsigned.carrierStatus}`)

// Try stage rollback via PUT /stage
console.log("\nTrying PUT /stage with stage=Producer (rollback)")
const r1 = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${unsigned.appointmentRequestId}/stage`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  body: JSON.stringify({ stage: "Producer", comment: "Admin rollback - appointment needs rep signature", isPrivate: false }),
})
console.log(`  → ${r1.status}: ${(await r1.text()).slice(0, 300)}`)

// Check state after
const check = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${unsigned.appointmentRequestId}`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
console.log(`\nAfter PUT: stage=${check.stage} reviewed=${check.reviewed} carrierStatus=${check.carrierStatus}`)

// Try POST /email to trigger rep-review email
console.log("\nTrying POST .../email to trigger rep-review email")
const r2 = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${unsigned.appointmentRequestId}/email`, {
  method: "POST",
  headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  body: "{}",
})
console.log(`  → ${r2.status}: ${(await r2.text()).slice(0, 200)}`)

await browser.close()
