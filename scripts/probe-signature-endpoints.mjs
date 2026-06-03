// Probe every plausible SureLC signature endpoint for a single
// producer to figure out which one returns the PDF attachment id.
// Single producer in, lots of HTTP calls out, dump everything.
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const producerId = process.argv[2]
if (!producerId) {
  console.error("usage: node probe-signature-endpoints.mjs <producerId>")
  process.exit(1)
}
const adminEmail = process.env.SURELC_ADMIN_EMAIL
const adminPassword = process.env.SURELC_ADMIN_PASSWORD

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
page.setDefaultTimeout(60_000)

let bearer = ""
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (a?.startsWith("Bearer ") && req.url().includes("/surecrm/")) {
    const b = a.replace("Bearer ", "")
    if (b.split(".").length === 3) bearer = b
  }
})

const logger = pino({ level: "info" })
const login = await loginAdmin(page, { email: adminEmail, password: adminPassword }, logger)
if (!login.ok) {
  console.error("login failed", login)
  process.exit(2)
}

// Navigate to producer's signature tab to harvest bearer + load the
// SPA's view so we see what SureLC actually calls on its own.
const captures = []
page.on("response", async (res) => {
  const url = res.url()
  if (!url.includes("surancebay.com")) return
  if (!/\/surecrm\/|signature|attachment/i.test(url)) return
  if (/\.(js|css|svg|png|woff|ico)/.test(url)) return
  const ct = res.headers()["content-type"] || ""
  let body = ""
  if (ct.includes("json") || ct.includes("text") || ct === "") {
    body = (await res.text().catch(() => "")).slice(0, 1500)
  } else {
    body = `(binary ${ct})`
  }
  captures.push({ url, status: res.status(), ct, body })
})

const target = `https://surelc.surancebay.com/bga/producers/${producerId}/signature`
await page.goto(target, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(6000)
console.error(`bearer captured: ${bearer ? "yes" : "no"} (${bearer.length} chars)`)
console.error(`captured ${captures.length} signature/attachment responses from SPA traffic`)
console.error("--- SPA-side captures ---")
for (const c of captures) {
  console.error(`${c.status} ${c.url}`)
  if (c.body && !c.body.startsWith("(binary")) console.error(`   body: ${c.body.slice(0, 300)}`)
}

if (!bearer) { await browser.close(); process.exit(3) }

// Now manually probe a wider set of endpoints to find the PDF
const endpoints = [
  `/surecrm/signature/${producerId}/pdf`,
  `/surecrm/signature/${producerId}`,
  `/surecrm/signature/${producerId}/png`,
  `/surecrm/signature/${producerId}/image`,
  `/surecrm/signature/${producerId}/attachments`,
  `/surecrm/signature/${producerId}/files`,
  `/surecrm/producer/${producerId}/signature`,
  `/surecrm/producer/${producerId}/signature/pdf`,
  `/surecrm/producer/${producerId}/signatures`,
  `/surecrm/producer/${producerId}/attachments`,
  `/surecrm/producer/${producerId}`,
  `/surecrm/producers/${producerId}`,
  `/surecrm/producers/${producerId}/signature`,
  `/surecrm/attachments?producerId=${producerId}`,
  `/surecrm/documents?producerId=${producerId}&type=signature`,
]

console.error("\n--- direct endpoint probes ---")
for (const path of endpoints) {
  try {
    const r = await fetch(`https://surelc.surancebay.com${path}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    const t = (await r.text().catch(() => "")).slice(0, 600)
    if (r.status !== 404 || t.length > 0) {
      console.error(`${r.status} ${path}`)
      if (t) console.error(`   body: ${t}`)
    }
  } catch (e) {
    console.error(`ERR ${path}: ${e.message}`)
  }
}

await browser.close()
