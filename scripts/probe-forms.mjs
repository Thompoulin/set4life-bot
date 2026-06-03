// Find the form-creation endpoint. Perrion has 5 attachments already
// uploaded; we need to bind one to a signature form + confirm.
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"

const producerId = process.argv[2] || "3351482"
// One of Perrion's existing uploaded attachments (most recent)
const attachmentId = 209650863

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

// GET /surecrm/attachment/{attachmentId} — might reveal form linking
console.error("\n=== Attachment detail probes ===")
for (const url of [
  `/surecrm/attachment/${attachmentId}`,
  `/surecrm/attachments/${attachmentId}`,
  `/surecrm/attachments/${attachmentId}/forms`,
  `/surecrm/attachments/${attachmentId}/form`,
  `/surecrm/forms?attachmentId=${attachmentId}`,
  `/surecrm/forms?producerId=${producerId}&category=Signature`,
  `/surecrm/forms?producerId=${producerId}`,
  `/surecrm/forms/list?producerId=${producerId}`,
  `/surecrm/categorize/${attachmentId}`,
  `/surecrm/attachment/${attachmentId}/categorize`,
  `/surecrm/attachment/${attachmentId}/link`,
  `/surecrm/signature/${producerId}/pdf/${attachmentId}`,
]) {
  try {
    const r = await fetch(`https://surelc.surancebay.com${url}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    if (r.status === 404) continue
    const text = (await r.text().catch(() => "")).slice(0, 600)
    console.error(`GET ${url} → ${r.status}: ${text.replace(/\s+/g, " ")}`)
  } catch (e) {}
}

// POST attempts to link attachment → signature form
console.error("\n=== POST link/form-create attempts ===")
for (const t of [
  { url: `/surecrm/signature/${producerId}/pdf`, body: { attachmentId } },
  { url: `/surecrm/signature/${producerId}/pdf`, body: { id: attachmentId } },
  { url: `/surecrm/signature/${producerId}/pdf`, body: attachmentId },
  { url: `/surecrm/signature/${producerId}/pdf`, body: { receivedFormId: attachmentId } },
  { url: `/surecrm/signature/${producerId}/link/${attachmentId}`, body: {} },
  { url: `/surecrm/categorize`, body: { producerId: Number(producerId), attachmentId, category: "Signature" } },
]) {
  try {
    const r = await fetch(`https://surelc.surancebay.com${t.url}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(t.body),
    })
    if (r.status === 404) { console.error(`POST ${t.url} → 404`); continue }
    const text = (await r.text().catch(() => "")).slice(0, 400)
    console.error(`POST ${t.url} body=${JSON.stringify(t.body).slice(0,60)} → ${r.status}: ${text.replace(/\s+/g, " ")}`)
  } catch (e) {}
}

// PUT signature/pdf with attachment id reference
console.error("\n=== PUT link attempts ===")
for (const t of [
  { url: `/surecrm/signature/${producerId}/pdf`, body: { attachmentId } },
  { url: `/surecrm/signature/${producerId}/pdf`, body: { id: attachmentId } },
  { url: `/surecrm/signature/${producerId}/pdf`, body: { formId: attachmentId } },
]) {
  try {
    const r = await fetch(`https://surelc.surancebay.com${t.url}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(t.body),
    })
    if (r.status === 404) { console.error(`PUT ${t.url} → 404`); continue }
    const text = (await r.text().catch(() => "")).slice(0, 400)
    console.error(`PUT ${t.url} body=${JSON.stringify(t.body).slice(0,60)} → ${r.status}: ${text.replace(/\s+/g, " ")}`)
  } catch (e) {}
}

await browser.close()
