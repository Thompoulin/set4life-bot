import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
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
const res = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests?producerId=11474830&gaId=1322`, { headers: { Authorization: `Bearer ${bearer}` } })
const data = await res.json()
const rows = Array.isArray(data) ? data : data.content || []
console.log("count:", rows.length)
console.log("sample row keys:", rows[0] ? Object.keys(rows[0]) : "n/a")
console.log("first 2 rows:")
for (const r of rows.slice(0, 2)) console.log(JSON.stringify(r, null, 2))
await browser.close()
