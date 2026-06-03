// Search exhaustively for the SureLC PDF upload endpoint. Probe with
// OPTIONS first (cheap, reveals allowed methods), then attempt the
// allowed method with multipart/form-data PDF body.
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
  if (a?.startsWith("Bearer ") && req.url().includes("/surecrm/")) bearer = a.replace("Bearer ", "")
})
const logger = pino({ level: "info" })
await loginAdmin(page, { email: process.env.SURELC_ADMIN_EMAIL, password: process.env.SURELC_ADMIN_PASSWORD }, logger)
await page.goto(`https://surelc.surancebay.com/bga/producers/${producerId}/signature`, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(4000)
if (!bearer) { console.error("no bearer"); process.exit(1) }

const pdfBuf = Buffer.from(await (await fetch(pdfUrl)).arrayBuffer())

const paths = [
  `/surecrm/signature/${producerId}/pdf`,
  `/surecrm/signature/${producerId}/upload`,
  `/surecrm/signature/${producerId}/file`,
  `/surecrm/signature/${producerId}`,
  `/surecrm/signature/upload/${producerId}`,
  `/surecrm/producer/${producerId}/signature`,
  `/surecrm/producer/${producerId}/signature/upload`,
  `/surecrm/producer/${producerId}/signature/pdf`,
  `/surecrm/attachments`,
  `/surecrm/attachments/upload`,
  `/surecrm/attachment/upload`,
  `/surecrm/file/upload`,
  `/surecrm/upload`,
]

console.error("=== OPTIONS preflight scan ===")
for (const p of paths) {
  try {
    const res = await fetch(`https://surelc.surancebay.com${p}`, {
      method: "OPTIONS",
      headers: { Authorization: `Bearer ${bearer}`, "Access-Control-Request-Method": "POST" },
    })
    const allow = res.headers.get("allow") || res.headers.get("access-control-allow-methods") || ""
    if (res.status !== 404 || allow) {
      console.error(`OPTIONS ${p} → ${res.status} allow=${allow || "(none)"}`)
    }
  } catch (e) {
    console.error(`OPTIONS ${p} ERR ${e.message}`)
  }
}

console.error("\n=== Multipart POST attempts ===")
const blob = new Blob([pdfBuf], { type: "application/pdf" })
for (const p of paths) {
  try {
    const fd = new FormData()
    fd.append("file", blob, "signature-authorization.pdf")
    const res = await fetch(`https://surelc.surancebay.com${p}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}` },
      body: fd,
    })
    const body = (await res.text().catch(() => "")).slice(0, 300)
    if (res.status < 500) {
      console.error(`POST ${p} → ${res.status}: ${body.replace(/\s+/g, " ").slice(0, 200)}`)
    }
  } catch (e) {
    console.error(`POST ${p} ERR ${e.message}`)
  }
}

console.error("\n=== Multipart PUT attempts ===")
for (const p of paths) {
  try {
    const fd = new FormData()
    fd.append("file", blob, "signature-authorization.pdf")
    const res = await fetch(`https://surelc.surancebay.com${p}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${bearer}` },
      body: fd,
    })
    const body = (await res.text().catch(() => "")).slice(0, 300)
    if (res.status < 500) {
      console.error(`PUT  ${p} → ${res.status}: ${body.replace(/\s+/g, " ").slice(0, 200)}`)
    }
  } catch (e) {
    console.error(`PUT  ${p} ERR ${e.message}`)
  }
}

await browser.close()
