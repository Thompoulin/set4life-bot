// Dump producer attachments + look for signature-form id
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"

const producerId = process.argv[2] || "3351482"

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
await gotoBga(page, `https://surelc.surancebay.com/bga/producers/${producerId}/signature`, logger)
await page.waitForTimeout(4000)

const r = await fetch(`https://surelc.surancebay.com/surecrm/attachments/${producerId}`, {
  headers: { Authorization: `Bearer ${bearer}` },
})
const list = await r.json()
console.error(`${list.length} attachments`)
for (const att of list) {
  // Print key fields only
  console.error(JSON.stringify({
    id: att.id,
    receivedFormId: att.receivedFormId,
    description: att.description?.slice(0, 80),
    modifiedOn: att.modifiedOn,
    category: att.category,
    type: att.type,
    formCategory: att.formCategory,
    keys: Object.keys(att).filter((k) => !["ocrText","content"].includes(k)),
  }))
}
await browser.close()
