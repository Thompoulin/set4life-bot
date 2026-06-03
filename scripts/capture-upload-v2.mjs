// V2: instead of setInputFiles (which apparently doesn't fire Angular's
// change handler in some states), try clicking the UPLOAD button which
// triggers the SPA's own file picker, and also try dispatching a
// programmatic change event after setInputFiles. Capture everything.
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const producerId = process.argv[2] || "3351482"
const pdfUrl = process.argv[3] || "https://ewr1.vultrobjects.com/s4l-storage/signatures/pending-perrionhopkinson95-yahoo-com-66/signature-authorization-1778769526442.pdf"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
let bearer = ""
const captures = []
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (a?.startsWith("Bearer ") && req.url().includes("/surecrm/")) bearer = a.replace("Bearer ", "")
  const url = req.url()
  if (!url.includes("surancebay.com")) return
  if (/\.(js|css|svg|woff|ico|map)/.test(url)) return
  if (req.method() === "GET" || req.method() === "OPTIONS") return
  captures.push({
    phase: "request",
    method: req.method(),
    url,
    contentType: req.headers()["content-type"],
    postBytes: req.postDataBuffer()?.length,
    postPreview: req.postData()?.slice(0, 200),
  })
})
page.on("response", async (res) => {
  const url = res.url()
  if (!url.includes("surancebay.com")) return
  if (/\.(js|css|svg|woff|ico|map)/.test(url)) return
  const req = res.request()
  if (req.method() === "GET" || req.method() === "OPTIONS") return
  const ct = res.headers()["content-type"] || ""
  let body = ""
  if (ct.includes("json") || ct.includes("text")) body = (await res.text().catch(() => "")).slice(0, 400)
  captures.push({ phase: "response", status: res.status(), url, method: req.method(), body })
})

const logger = pino({ level: "info" })
await loginAdmin(page, { email: process.env.SURELC_ADMIN_EMAIL, password: process.env.SURELC_ADMIN_PASSWORD }, logger)
await gotoBga(page, `https://surelc.surancebay.com/bga/producers/${producerId}/signature`, logger)
await page.waitForTimeout(5000)

// Find ALL inputs (including hidden)
console.error("=== Page inspection ===")
const inputInfo = await page.$$eval("input", (els) =>
  els.map((e, i) => ({
    idx: i,
    type: e.type,
    name: e.name,
    accept: e.accept,
    hidden: e.hidden,
    offsetParent: e.offsetParent !== null,
    multiple: e.multiple,
  })),
)
console.error("inputs:", JSON.stringify(inputInfo))

// Try setting all file inputs (could be one or multiple)
const pdfBuf = Buffer.from(await (await fetch(pdfUrl)).arrayBuffer())
const local = path.join(tmpdir(), `cap2-${Date.now()}.pdf`)
await fs.writeFile(local, pdfBuf)

const fileInputs = await page.$$('input[type="file"]')
console.error(`found ${fileInputs.length} file inputs`)

const beforeUpload = captures.length

// Method 1: setInputFiles + dispatch change explicitly via JS
console.error("\n=== Method 1: setInputFiles + manual change dispatch ===")
for (const inp of fileInputs) {
  await inp.setInputFiles(local).catch((e) => console.error("setInputFiles err:", e.message))
  await inp.evaluate((el) => {
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
  })
}
await page.waitForTimeout(10_000)

const m1 = captures.length - beforeUpload
console.error(`Method 1: ${m1} new requests captured`)

const afterM1 = captures.length
// Method 2: click the label/button that wraps the file input
console.error("\n=== Method 2: click visible UPLOAD button to open native picker ===")
// We can't actually upload via native picker headless, but maybe the
// SureLC SPA has a "Click here to upload" handler we can intercept.
const labels = await page.$$('label, [for], button')
let foundUploadHandler = false
for (const el of labels) {
  const text = await el.textContent().catch(() => "") || ""
  if (/upload it now|upload/i.test(text)) {
    console.error(`clicking "${text.trim().slice(0, 60)}"`)
    // We can't intercept the native picker, but we can fire-and-forget.
    // BEFORE clicking, set up an input-files for the next file chooser.
    page.once("filechooser", async (fc) => {
      console.error(`filechooser intercepted: ${fc.element ? "ok" : "noop"}`)
      await fc.setFiles(local).catch((e) => console.error("filechooser setFiles err:", e.message))
      foundUploadHandler = true
    })
    await el.click().catch((e) => console.error("click err:", e.message))
    break
  }
}
await page.waitForTimeout(15_000)

const m2 = captures.length - afterM1
console.error(`Method 2: ${m2} new requests captured`)

console.error("\n=== ALL POST/PUT captures ===")
console.log(JSON.stringify({ inputInfo, captures }, null, 2))

await browser.close()
