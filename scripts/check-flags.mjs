import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
let bearer = ""
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (a?.startsWith("Bearer ") && req.url().includes("/surecrm/")) bearer = a.replace("Bearer ", "")
})
const logger = pino({ level: "info" })
await loginAdmin(page, { email: process.env.SURELC_ADMIN_EMAIL, password: process.env.SURELC_ADMIN_PASSWORD }, logger)
await gotoBga(page, `https://surelc.surancebay.com/bga/producers/3351482/signature`, logger)
await page.waitForTimeout(3000)
for (const pid of [3351482, 8068174, 11751656, 11458374, 7422166, 10313835, 11756914, 2157902, 5081756, 7533541]) {
  const r = await fetch(`https://surelc.surancebay.com/surecrm/validation/list`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify([pid]),
  })
  const list = await r.json()
  console.log(`${pid}: ${JSON.stringify(list.map(w => w.code))}`)
}
await browser.close()
