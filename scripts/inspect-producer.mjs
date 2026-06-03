import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"
const target = Number(process.env.PRODUCER_ID)
const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext()).newPage()
let bearer = ""
page.on("request", (r) => { const a = r.headers()["authorization"]; if (a?.startsWith("Bearer ") && r.url().includes("/surecrm/")) bearer = a.replace("Bearer ", "") })
const logger = pino({ level: "info" })
await loginAdmin(page, { email: process.env.SURELC_ADMIN_EMAIL, password: process.env.SURELC_ADMIN_PASSWORD }, logger)
await gotoBga(page, "https://surelc.surancebay.com/bga/producers", logger)
await page.waitForTimeout(3000)
const listRes = await fetch(`https://surelc.surancebay.com/validation/producers/byGaId/1322`, {
  method: "POST",
  headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  body: JSON.stringify({ lookupType: "all", producerIds: [] }),
})
const list = await listRes.json()
const found = (list.data || []).find((p) => p.producerId === target)
console.log(JSON.stringify(found, null, 2))
await browser.close()
