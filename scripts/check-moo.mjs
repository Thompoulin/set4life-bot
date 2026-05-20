import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "./dist/admin/login.js"
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
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/11474830"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)
const r = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/116935218`, { headers: { Authorization: `Bearer ${bearer}` } }).then(r => r.json())
console.log("MoO now:", "states=", r.states, "products=", r.products, "stage=", r.stage)
await browser.close()
