// Capture network during a real signature upload: click UPLOAD IT NOW,
// set file input, watch every POST/PUT for 25 seconds. The SPA's
// actual upload endpoint should fire and we'll see it.
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const producerId = process.argv[2]
const sigUrl = process.argv[3]
if (!producerId || !sigUrl) {
  console.error("usage: node capture-upload-flow.mjs <producerId> <pdfOrPngUrl>")
  process.exit(1)
}

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
page.setDefaultTimeout(60_000)

let bearer = ""
const captures = []
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (a?.startsWith("Bearer ") && req.url().includes("/surecrm/")) {
    const b = a.replace("Bearer ", "")
    if (b.split(".").length === 3) bearer = b
  }
  const url = req.url()
  if (!url.includes("surancebay.com")) return
  if (/\.(js|css|svg|png|woff|ico|map)/.test(url)) return
  const method = req.method()
  if (method === "GET" || method === "OPTIONS") return
  captures.push({
    phase: "request",
    ts: Date.now(),
    method,
    url,
    headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => !k.startsWith("sec-"))),
    postDataPreview: req.postData()?.slice(0, 300),
    postBytes: req.postDataBuffer()?.length,
  })
})
page.on("response", async (res) => {
  const url = res.url()
  if (!url.includes("surancebay.com")) return
  if (/\.(js|css|svg|png|woff|ico|map)/.test(url)) return
  const req = res.request()
  if (req.method() === "GET" || req.method() === "OPTIONS") return
  const ct = res.headers()["content-type"] || ""
  let body = ""
  if (ct.includes("json") || ct.includes("text")) {
    body = (await res.text().catch(() => "")).slice(0, 800)
  }
  captures.push({
    phase: "response",
    ts: Date.now(),
    status: res.status(),
    url,
    method: req.method(),
    body,
  })
})

const logger = pino({ level: "info" })
await loginAdmin(page, { email: process.env.SURELC_ADMIN_EMAIL, password: process.env.SURELC_ADMIN_PASSWORD }, logger)

const target = `https://surelc.surancebay.com/bga/producers/${producerId}/signature`
await gotoBga(page, target, logger)
await page.waitForTimeout(4000)
console.error(`bearer captured: ${!!bearer}`)

// Click UPLOAD IT NOW so the file input is rendered.
const upBtn =
  (await page.$('button:has-text("UPLOAD IT NOW")').catch(() => null)) ||
  (await page.$('button:has-text("Upload it now")').catch(() => null)) ||
  (await page.$('button:has-text("Upload")').catch(() => null))
if (upBtn) {
  await upBtn.click().catch(() => {})
  await page.waitForTimeout(1500)
  console.error("clicked UPLOAD IT NOW")
} else {
  console.error("UPLOAD IT NOW button not found — file input may already be present")
}

// Download the file locally + setInputFiles
const r = await fetch(sigUrl)
const buf = Buffer.from(await r.arrayBuffer())
const local = path.join(tmpdir(), `cap-upload-${Date.now()}.pdf`)
await fs.writeFile(local, buf)
console.error(`downloaded ${buf.length} bytes from ${sigUrl}`)

const captureStartTs = Date.now()
const fileInput = await page.$('input[type="file"]')
if (!fileInput) {
  console.error("no file input found")
  await browser.close()
  process.exit(2)
}
await fileInput.setInputFiles(local)
console.error("file set; capturing 25s of network traffic…")
await page.waitForTimeout(25_000)

const interesting = captures.filter((c) => c.ts >= captureStartTs - 1000)
console.error(`total captures: ${captures.length}, since upload: ${interesting.length}`)
console.log(JSON.stringify({ bearer: bearer.slice(0, 40) + "…", interesting }, null, 2))
await browser.close()
