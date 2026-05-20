import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
const APPT_ID = process.argv[2]
if (!APPT_ID) { console.error("usage: <appointmentRequestId>"); process.exit(1) }
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, pino())
console.log("LOGGED IN, url:", page.url())
let bearer = null
const handler = (req) => {
  const a = req.headers()["authorization"]
  if (req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
    const b = a.replace("Bearer ", "")
    if (!bearer && b.split(".").length === 3) {
      bearer = b
      console.log("captured Bearer with len", b.length, "and 3 segments ✓")
      page.off("request", handler)
    }
  }
}
page.on("request", handler)
// Trigger a real /surecrm/ request by navigating to producer profile
await page.evaluate(() => {
  history.pushState({}, "", `/bga/producers/11474830/profile`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(6000)
if (!bearer) { console.error("no valid 3-segment Bearer captured"); await browser.close(); process.exit(1) }

// Try the DELETE
const url = `https://surelc.surancebay.com/surecrm/appointments-requests/${APPT_ID}`
const r = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${bearer}` } })
console.log(`DELETE ${url} → HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`)
await browser.close()
