// V3: capture ALL outbound traffic during a signature upload attempt
// (not filtered to surancebay.com). The SPA might upload to a CDN /
// pre-signed bucket. Use the filechooser intercept path which gave
// 12 captures last time — clearly the SPA does react to that.
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
const captures = []
page.on("request", (req) => {
  const url = req.url()
  // Skip only the truly noisy — keep EVERYTHING else
  if (/\.(svg|woff2?|ttf|ico)\b/.test(url)) return
  if (/google-analytics|googletagmanager/.test(url)) return
  if (req.method() === "OPTIONS") return
  captures.push({
    phase: "request",
    method: req.method(),
    url,
    contentType: req.headers()["content-type"] || "",
    referer: req.headers()["referer"] || "",
    bytes: req.postDataBuffer()?.length,
    postPreview: req.postData()?.slice(0, 200),
  })
})
page.on("response", async (res) => {
  const url = res.url()
  if (/\.(svg|woff2?|ttf|ico)\b/.test(url)) return
  if (/google-analytics|googletagmanager/.test(url)) return
  const req = res.request()
  if (req.method() === "OPTIONS") return
  const ct = res.headers()["content-type"] || ""
  let body = ""
  if (ct.includes("json") || ct.includes("text") || ct === "") {
    body = (await res.text().catch(() => "")).slice(0, 300)
  } else {
    body = `(${ct} ${res.headers()["content-length"] || "?"} bytes)`
  }
  captures.push({ phase: "response", status: res.status(), url, method: req.method(), contentType: ct, body })
})

const logger = pino({ level: "info" })
await loginAdmin(page, { email: process.env.SURELC_ADMIN_EMAIL, password: process.env.SURELC_ADMIN_PASSWORD }, logger)
await gotoBga(page, `https://surelc.surancebay.com/bga/producers/${producerId}/signature`, logger)
await page.waitForTimeout(5000)

const pdfBuf = Buffer.from(await (await fetch(pdfUrl)).arrayBuffer())
const local = path.join(tmpdir(), `cap3-${Date.now()}.pdf`)
await fs.writeFile(local, pdfBuf)

const beforeMark = captures.length
console.error(`pre-upload captures: ${beforeMark}`)
console.error("clicking 'UPLOAD IT NOW' via filechooser intercept…")

page.once("filechooser", async (fc) => {
  console.error("[filechooser] received — setting file")
  await fc.setFiles(local).catch((e) => console.error("setFiles err:", e.message))
})

// Click the label/button — has to be the actual upload button text
await page.click('button:has-text("UPLOAD IT NOW"), button:has-text("Upload it now")').catch((e) => console.error("click err:", e.message))
await page.waitForTimeout(45_000)
console.error(`total captures: ${captures.length}; new since upload: ${captures.length - beforeMark}`)

// Print every non-noisy capture from the upload window
console.error("\n=== ALL captures during upload window ===")
for (let i = beforeMark; i < captures.length; i++) {
  const c = captures[i]
  if (c.phase === "request") {
    console.error(`>>> ${c.method.padEnd(6)} ${c.url.slice(0, 130)}`)
    if (c.contentType) console.error(`    ct: ${c.contentType}`)
    if (c.bytes) console.error(`    body bytes: ${c.bytes} preview: ${c.postPreview?.slice(0, 80) || ""}`)
  } else {
    console.error(`<<< ${String(c.status).padEnd(3)} ${c.method.padEnd(6)} ${c.url.slice(0, 130)}`)
    if (c.contentType.includes("json") && c.body) console.error(`    resp: ${c.body.slice(0, 200)}`)
  }
}

await browser.close()
