// FULL signature push: upload PDF → get formId → PUT confirmImage with PNG.
// This is the API equivalent of the cropper UI flow.
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"

const producerId = process.argv[2] || "3351482"
const pdfUrl = process.argv[3] || "https://ewr1.vultrobjects.com/s4l-storage/signatures/pending-perrionhopkinson95-yahoo-com-66/signature-authorization-1778769526442.pdf"
const pngUrl = process.argv[4] || "https://ewr1.vultrobjects.com/s4l-storage/signatures/pending-perrionhopkinson95-yahoo-com-66/signature-1778769526442.png"

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

const pdfBuf = Buffer.from(await (await fetch(pdfUrl)).arrayBuffer())
const pngBuf = Buffer.from(await (await fetch(pngUrl)).arrayBuffer())
const sharp = (await import("sharp")).default
const meta = await sharp(pngBuf).metadata()
const width = meta.width || 491
const height = meta.height || 200

// Step 1: POST /uploadForm
console.error("\nStep 1: POST /uploadForm")
const fd = new FormData()
fd.append("file", new Blob([pdfBuf], { type: "application/pdf" }), "signature-authorization.pdf")
const upRes = await fetch(`https://surelc.surancebay.com/surecrm/signature/${producerId}/uploadForm`, {
  method: "POST",
  headers: { Authorization: `Bearer ${bearer}` },
  body: fd,
})
console.error(`  → ${upRes.status}`)
const upBody = await upRes.json()
const formId = upBody.uid || upBody.id
console.error(`  formId: ${formId}, status: ${upBody.status}`)

if (!formId) {
  console.error("FAIL: no formId returned")
  process.exit(1)
}

// Step 2: PUT confirmImage with the PNG
console.error("\nStep 2: PUT /confirmImage")
const payload = `data:image/png;base64,${pngBuf.toString("base64")}`
const confRes = await fetch(`https://surelc.surancebay.com/surecrm/signature/${producerId}/${formId}/confirmImage`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  body: JSON.stringify({ payload, width, height }),
})
const confBody = (await confRes.text().catch(() => "")).slice(0, 500)
console.error(`  → ${confRes.status}: ${confBody}`)

// Step 3: Verify
console.error("\nStep 3: Verify GET /signature/{id}/pdf")
const verRes = await fetch(`https://surelc.surancebay.com/surecrm/signature/${producerId}/pdf`, {
  headers: { Authorization: `Bearer ${bearer}` },
})
const verBody = (await verRes.text().catch(() => "")).slice(0, 500)
console.error(`  → ${verRes.status}: ${verBody}`)

console.error("\nStep 4: Validation list")
const valRes = await fetch(`https://surelc.surancebay.com/surecrm/validation/list`, {
  method: "POST",
  headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  body: JSON.stringify([Number(producerId)]),
})
const valBody = (await valRes.text().catch(() => "")).slice(0, 500)
console.error(`  → ${valRes.status}: ${valBody}`)
await browser.close()
