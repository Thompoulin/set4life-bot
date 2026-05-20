import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
const APPT_ID = process.argv[2]
if (!APPT_ID) { console.error("usage: <appointmentRequestId>"); process.exit(1) }
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, pino())
let bearer = null
const handler = (req) => {
  const a = req.headers()["authorization"]
  if (req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) { bearer = a.replace("Bearer ",""); page.off("request", handler) }
}
page.on("request", handler)
await page.evaluate(() => { history.pushState({}, "", `/bga/producers/11474830/appointments`); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)
console.log("bearer captured")
// Try several DELETE endpoints
for (const path of [
  `/surecrm/appointments-requests/${APPT_ID}`,
  `/surecrm/appointment-requests/${APPT_ID}`,
  `/surecrm/appointmentsRequests/${APPT_ID}`,
  `/surecrm/appointments/${APPT_ID}`,
]) {
  const url = `https://surelc.surancebay.com${path}`
  const r = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${bearer}` } })
  console.log(`DELETE ${path} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  if (r.ok) break
}
await browser.close()
