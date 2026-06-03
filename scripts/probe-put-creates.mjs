// SureLC's cropper renders the PDF client-side via PDF.js and only
// uploads the CROPPED IMAGE on CONFIRM click. So there's no "upload
// PDF" endpoint — the persisted attachment is the cropped image,
// created during CONFIRM. The PUT endpoint d78647c found
// (/surecrm/signature/{id}/{attachId}/confirmImage) might create the
// attachment on first write. Test that.

import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"

const producerId = process.argv[2] || "3351482"
const pngUrl = process.argv[3] || "https://ewr1.vultrobjects.com/s4l-storage/signatures/pending-perrionhopkinson95-yahoo-com-66/signature-1778769526442.png"

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

const pngBuf = Buffer.from(await (await fetch(pngUrl)).arrayBuffer())
const sharp = (await import("sharp")).default
const meta = await sharp(pngBuf).metadata()
const width = meta.width || 491
const height = meta.height || 200
const payload = `data:image/png;base64,${pngBuf.toString("base64")}`
console.error(`PNG: ${pngBuf.length} bytes, ${width}x${height}`)

// Try multiple attachId values to see what creates the record
const attemptIds = [
  "new",        // common create-on-write keyword
  "0",          // server-side autogen with 0/null
  "null",
  String(Date.now()), // client-generated id
  "auto",
]

console.error("\n=== Trying PUT confirmImage with synthesized attachIds ===")
for (const aid of attemptIds) {
  const url = `https://surelc.surancebay.com/surecrm/signature/${producerId}/${aid}/confirmImage`
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ payload, width, height }),
    })
    const body = (await res.text().catch(() => "")).slice(0, 400)
    console.error(`PUT ${aid.padEnd(20)} → ${res.status}: ${body.replace(/\s+/g, " ")}`)
    if (res.status === 200 || res.status === 201) {
      // Check if it worked
      const check = await fetch(`https://surelc.surancebay.com/surecrm/signature/${producerId}/pdf`, {
        headers: { Authorization: `Bearer ${bearer}` },
      })
      const ck = (await check.text().catch(() => "")).slice(0, 200)
      console.error(`   FOLLOWUP GET /pdf → ${check.status}: ${ck}`)
      if (check.status === 200 && ck.trim()) console.error(`   *** SUCCESS with attachId="${aid}"`)
    }
  } catch (e) {
    console.error(`PUT ${aid} ERR ${e.message}`)
  }
}

// Also try a POST creating a new signature attachment
console.error("\n=== Trying POST to create signature attachment ===")
const postPaths = [
  `/surecrm/signature/${producerId}`,
  `/surecrm/signature/${producerId}/confirmImage`,
  `/surecrm/signature`,
]
for (const path of postPaths) {
  try {
    const res = await fetch(`https://surelc.surancebay.com${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ producerId: Number(producerId), payload, width, height }),
    })
    const body = (await res.text().catch(() => "")).slice(0, 400)
    console.error(`POST ${path} → ${res.status}: ${body.replace(/\s+/g, " ").slice(0, 300)}`)
  } catch (e) {
    console.error(`POST ${path} ERR ${e.message}`)
  }
}

await browser.close()
