// Find SureLC's "form" concept — the PUT endpoint requires a formId.
// Probe everything that might list or return forms for a producer.
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
if (!bearer) { console.error("no bearer"); process.exit(1) }

const paths = [
  `/surecrm/signature/${producerId}`,
  `/surecrm/signatures/${producerId}`,
  `/surecrm/forms/${producerId}`,
  `/surecrm/forms?producerId=${producerId}`,
  `/surecrm/forms?producerId=${producerId}&category=signature`,
  `/surecrm/forms?producerId=${producerId}&category=Signature`,
  `/surecrm/forms?producerId=${producerId}&type=signature`,
  `/surecrm/producer/${producerId}/forms`,
  `/surecrm/producers/${producerId}/forms`,
  `/surecrm/forms`,
  `/surecrm/documents/${producerId}`,
  `/surecrm/documents?producerId=${producerId}`,
  `/surecrm/attachments/${producerId}`,
  `/surecrm/attachments?producerId=${producerId}`,
]
console.error("=== GET probes ===")
for (const path of paths) {
  try {
    const r = await fetch(`https://surelc.surancebay.com${path}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    if (r.status === 404) continue
    const ct = r.headers.get("content-type") || ""
    const text = (await r.text().catch(() => "")).slice(0, 600)
    console.error(`GET ${path} → ${r.status} ${ct}: ${text.replace(/\s+/g, " ")}`)
  } catch (e) {
    console.error(`GET ${path} ERR ${e.message}`)
  }
}

// Also try common /forms with POST to create a new one (signature category)
console.error("\n=== POST to create form ===")
const createAttempts = [
  { path: `/surecrm/forms`, body: { producerId: Number(producerId), category: "Signature" } },
  { path: `/surecrm/forms`, body: { producerId: Number(producerId), formCategory: "Signature" } },
  { path: `/surecrm/forms`, body: { producerId: Number(producerId), type: "signature" } },
  { path: `/surecrm/signature/${producerId}/form`, body: {} },
  { path: `/surecrm/signature/${producerId}/forms`, body: {} },
]
for (const a of createAttempts) {
  try {
    const r = await fetch(`https://surelc.surancebay.com${a.path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(a.body),
    })
    const text = (await r.text().catch(() => "")).slice(0, 400)
    if (r.status !== 404) console.error(`POST ${a.path} → ${r.status}: ${text.replace(/\s+/g, " ")}`)
  } catch (e) {
    console.error(`POST ${a.path} ERR ${e.message}`)
  }
}

await browser.close()
