/**
 * Recon round 4c — actually trigger a document upload through the
 * BGA UI's hidden file input and watch ALL network traffic so we can
 * see the POST URL + payload shape.
 *
 * Uses Holton's producer page, uploads a tiny dummy PDF, captures the
 * network call, then deletes the uploaded test doc via the UI if
 * possible (or leaves it for manual cleanup).
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const log = pino()
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, log)

// Create a tiny valid PDF file.
const pdfPath = join(tmpdir(), `lor-recon-${Date.now()}.pdf`)
const minimalPdf = Buffer.from(
  "%PDF-1.1\n%¥±ë\n\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] >>\nendobj\n\nxref\n0 4\n0000000000 65535 f\n0000000018 00000 n\n0000000065 00000 n\n0000000118 00000 n\ntrailer << /Root 1 0 R /Size 4 >>\nstartxref\n179\n%%EOF",
)
writeFileSync(pdfPath, minimalPdf)

const captured = []
page.on("request", async (req) => {
  const url = req.url()
  if (!url.startsWith("https://surelc.surancebay.com/")) return
  if (req.method() === "GET") return // skip noise
  captured.push({
    method: req.method(),
    url,
    headers: req.headers(),
    postData: req.postData()?.slice(0, 500),
  })
})
page.on("response", async (resp) => {
  // Track responses that look like upload acknowledgements
  const url = resp.url()
  if (!url.startsWith("https://surelc.surancebay.com/")) return
  if (resp.request().method() === "GET") return
  const status = resp.status()
  if (status >= 200 && status < 400) {
    try {
      const body = await resp.text()
      if (body.length < 2000 && (body.includes("documentId") || body.includes("fileId") || body.includes("uploaded") || /\.pdf/i.test(body))) {
        console.log(`\n  RESP ${status} ${resp.request().method()} ${url}`)
        console.log(`    body: ${body.slice(0, 500)}`)
      }
    } catch {}
  }
})

await page.evaluate(() => {
  history.pushState({}, "", "/bga/producers/11096584/documents?status=Active&types=ALL_TAGS&sort=By-newer-date")
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(4000)

// Find the hidden file input and trigger setInputFiles
const fileInput = await page.$('input[type="file"]')
if (!fileInput) {
  console.log("no file input found, aborting")
} else {
  console.log("uploading dummy PDF via hidden input…")
  await fileInput.setInputFiles(pdfPath).catch((e) => console.log(`setInputFiles err: ${e.message}`))
  // Wait for any uploads to finish.
  await page.waitForTimeout(5000)

  // Try to handle any modal that might appear asking for document type / metadata
  const dialogButtons = await page.$$eval("button", (els) =>
    els.map((e) => (e.textContent || "").trim()).filter((t) => t),
  )
  console.log(`\nbuttons visible after upload: ${dialogButtons.slice(0, 25).join(" | ")}`)

  // Look for a document type selector (combobox or select)
  const selects = await page.$$eval("select, [role='combobox']", (els) =>
    els.map((e) => ({
      tag: e.tagName.toLowerCase(),
      name: e.getAttribute("name"),
      role: e.getAttribute("role"),
      text: (e.textContent || "").trim().slice(0, 120),
    })),
  )
  console.log(`\ndocument type selectors:`)
  for (const s of selects.slice(0, 8)) console.log(`  ${s.tag} role=${s.role} name=${s.name}  text="${s.text}"`)
  // List options if it's a Material/Antd autocomplete: look at li role=option
  const opts = await page.$$eval("li[role='option'], [role='option']", (els) =>
    els.map((e) => (e.textContent || "").trim()).filter((t) => t).slice(0, 50),
  )
  console.log(`\noption list (combobox items): ${opts.length}`)
  for (const o of opts) console.log(`  ${o}`)
}

console.log(`\n─── Captured non-GET requests (${captured.length}):`)
for (const c of captured.slice(0, 30)) {
  console.log(`  ${c.method} ${c.url}`)
  if (c.postData) console.log(`    postData[0..400]: ${c.postData}`)
}

await browser.close()
