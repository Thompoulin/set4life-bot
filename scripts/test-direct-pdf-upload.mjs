// Try uploading the signature-authorization PDF directly to SureLC's
// signature endpoint, bypassing the SPA entirely. Test several HTTP
// method + content-type permutations against Perrion (currently has
// 204 No-Content on both /pdf and /image — clean slate for testing).
//
// Strict safety: we only mutate signature endpoints. If the server
// rejects, no change. If it accepts, we then GET /pdf to confirm a
// resource was created.

import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const producerId = process.argv[2] || "3351482"
const pdfUrl = process.argv[3] || "https://ewr1.vultrobjects.com/s4l-storage/signatures/pending-perrionhopkinson95-yahoo-com-66/signature-authorization-1778769526442.pdf"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
let bearer = ""
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (a?.startsWith("Bearer ") && req.url().includes("/surecrm/")) {
    bearer = a.replace("Bearer ", "")
  }
})

const logger = pino({ level: "info" })
await loginAdmin(page, { email: process.env.SURELC_ADMIN_EMAIL, password: process.env.SURELC_ADMIN_PASSWORD }, logger)
await page.goto(`https://surelc.surancebay.com/bga/producers/${producerId}/signature`, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(4000)
console.error("bearer captured:", !!bearer)
if (!bearer) { await browser.close(); process.exit(1) }

const pdfBuf = Buffer.from(await (await fetch(pdfUrl)).arrayBuffer())
console.error(`PDF: ${pdfBuf.length} bytes`)

const base64 = pdfBuf.toString("base64")
const dataUrl = `data:application/pdf;base64,${base64}`

// Try a battery of upload attempts
const attempts = [
  { name: "POST /signature/{id}/pdf raw binary", method: "POST", path: `/surecrm/signature/${producerId}/pdf`, contentType: "application/pdf", body: pdfBuf },
  { name: "PUT  /signature/{id}/pdf raw binary", method: "PUT", path: `/surecrm/signature/${producerId}/pdf`, contentType: "application/pdf", body: pdfBuf },
  { name: "POST /signature/{id}/pdf json payload", method: "POST", path: `/surecrm/signature/${producerId}/pdf`, contentType: "application/json", body: JSON.stringify({ payload: dataUrl }) },
  { name: "PUT  /signature/{id}/pdf json payload", method: "PUT", path: `/surecrm/signature/${producerId}/pdf`, contentType: "application/json", body: JSON.stringify({ payload: dataUrl }) },
]

for (const a of attempts) {
  console.error(`\n→ ${a.name}`)
  try {
    const res = await fetch(`https://surelc.surancebay.com${a.path}`, {
      method: a.method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": a.contentType,
      },
      body: a.body,
    })
    const ct = res.headers.get("content-type") || ""
    let body
    if (ct.includes("json") || ct.includes("text") || ct === "") {
      body = (await res.text().catch(() => "")).slice(0, 500)
    } else {
      body = `(binary ${ct})`
    }
    console.error(`   ${res.status} ${ct} → ${body}`)
    if (res.status >= 200 && res.status < 300) {
      // Check if a PDF now exists
      const check = await fetch(`https://surelc.surancebay.com/surecrm/signature/${producerId}/pdf`, {
        headers: { Authorization: `Bearer ${bearer}` },
      })
      const cb = (await check.text().catch(() => "")).slice(0, 400)
      console.error(`   FOLLOWUP GET /pdf → ${check.status} ${check.headers.get("content-type")}: ${cb}`)
      if (check.status === 200 && cb.trim()) {
        console.error(`   *** SUCCESS: PDF now persisted via ${a.name}`)
        break
      }
    }
  } catch (e) {
    console.error(`   ERR ${e.message}`)
  }
}

await browser.close()
