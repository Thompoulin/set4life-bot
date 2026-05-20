/**
 * Release Holton's 9 BGA appointments → Carrier directly via API.
 * PUT /surecrm/appointments-requests/{id}/stage with stage=Carrier.
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
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/11096584"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)
const list = await fetch("https://surelc.surancebay.com/surecrm/appointments-requests?producerId=11096584&gaId=1322", { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
const atBga = list.filter((x) => x.stage === "BGA")
console.log(`At-BGA: ${atBga.length}`)
for (const r of atBga) {
  const res = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${r.appointmentRequestId}/stage`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ stage: "Carrier", comment: "Set4Life bot — release to carrier", isPrivate: false }),
  })
  console.log(`  ${r.carrierName.padEnd(45)} → ${res.status}`)
}
await browser.close()
