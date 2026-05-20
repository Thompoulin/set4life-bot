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
const r = await fetch("https://surelc.surancebay.com/surecrm/appointments-requests/116935372", {
  headers: { Authorization: `Bearer ${bearer}` },
}).then(r => r.json())
console.log("Keyon Foresters NOW:")
console.log("  products:", r.products)
console.log("  carrierProducts:", JSON.stringify(r.carrierProducts))
console.log("  stage:", r.stage)
console.log("  reviewed:", r.reviewed)
console.log("  carrierStatus:", r.carrierStatus)
await browser.close()
