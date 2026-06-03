// Hit the real endpoint: POST /surecrm/signature/{producerId}/uploadForm
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"

const producerId = process.argv[2] || "3351482"
const pdfUrl = process.argv[3] || "https://ewr1.vultrobjects.com/s4l-storage/signatures/pending-perrionhopkinson95-yahoo-com-66/signature-authorization-1778769526442.pdf"

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

const pdfBuf = Buffer.from(await (await fetch(pdfUrl)).arrayBuffer())
console.error(`PDF: ${pdfBuf.length} bytes`)

// Build multipart FormData
const fd = new FormData()
fd.append("file", new Blob([pdfBuf], { type: "application/pdf" }), "signature-authorization.pdf")

const url = `https://surelc.surancebay.com/surecrm/signature/${producerId}/uploadForm`
console.error(`\nPOST ${url}`)
const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${bearer}` },
  body: fd,
})
const ct = res.headers.get("content-type") || ""
const body = (await res.text().catch(() => "")).slice(0, 800)
console.error(`→ ${res.status} ${ct}: ${body}`)

if (res.ok) {
  let formId = null
  try {
    const json = JSON.parse(body)
    formId = json?.id || json?.formId || json?.receivedFormId || null
  } catch {}
  console.error(`\n=== formId returned: ${formId} ===`)

  // Verify the upload landed
  const check = await fetch(`https://surelc.surancebay.com/surecrm/signature/${producerId}/pdf`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  console.error(`GET /signature/${producerId}/pdf → ${check.status}`)
  const ckBody = (await check.text().catch(() => "")).slice(0, 400)
  console.error(`body: ${ckBody}`)
}
await browser.close()
