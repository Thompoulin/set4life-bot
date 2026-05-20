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
const list = await fetch("https://surelc.surancebay.com/surecrm/appointments-requests?producerId=5331616&gaId=1322", { headers: { Authorization: `Bearer ${bearer}` } }).then(r => r.json())
console.log("Keyon's Foresters appointments (any stage):")
for (const r of list.filter(x => /Foresters/i.test(x.carrierName))) {
  console.log(`  id=${r.appointmentRequestId} stage=${r.stage} reviewed=${r.reviewed} carrierStatus=${r.carrierStatus} ts=${r.ts}`)
}
await browser.close()
