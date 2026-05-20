/**
 * Recon round 4b — the appointment-request page has zero file inputs.
 * The "DOCUMENTS" link points to /bga/producers/{id}/documents. Inspect
 * that page for a release-form / LOR upload affordance + capture any
 * POST endpoint hit during a real (dummy) upload there.
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
import { writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const log = pino()
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, log)

let bearer = ""
const networkLog = []
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (!bearer && req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
    const tok = a.replace("Bearer ", "")
    if (tok.split(".").length === 3) bearer = tok
  }
  const url = req.url()
  if (url.includes("surancebay.com") && (url.includes("/upload") || url.includes("/document") || url.includes("/file") || url.includes("/release") || url.includes("/lor"))) {
    networkLog.push({ method: req.method(), url, hasBody: !!req.postData() })
  }
})

async function navTo(p) {
  await page.evaluate((path) => {
    history.pushState({}, "", path)
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
  }, p)
  await page.waitForTimeout(3500)
}

await navTo("/bga/producers/11096584/documents")
await page.waitForTimeout(2500)

console.log("─── Producer Documents page DOM survey")
console.log(`current url: ${page.url()}`)

// Buttons / links / dropdowns
const headings = await page.$$eval("h1, h2, h3, h4", (els) =>
  els.map((e) => (e.textContent || "").trim()).filter((t) => t),
)
console.log(`\nheadings: ${headings.slice(0, 15).join(" | ")}`)

const fileInputs = await page.$$('input[type="file"]')
console.log(`\nfile inputs: ${fileInputs.length}`)
for (let i = 0; i < fileInputs.length; i++) {
  const el = fileInputs[i]
  const id = await el.getAttribute("id").catch(() => null)
  const name = await el.getAttribute("name").catch(() => null)
  const accept = await el.getAttribute("accept").catch(() => null)
  const hidden = await el.evaluate((n) => {
    const s = window.getComputedStyle(n)
    return s.display === "none" || s.visibility === "hidden"
  }).catch(() => null)
  // Walk up to find nearest label/text
  const ctxText = await el.evaluate((n) => {
    let p = n.parentElement
    while (p && p.textContent && p.textContent.trim().length > 200) p = p.parentElement
    return p?.textContent?.trim().slice(0, 200) || ""
  })
  console.log(`  [${i}] id=${id} name=${name} accept=${accept} hidden=${hidden}`)
  console.log(`       context: "${ctxText.slice(0, 180)}"`)
}

// Look for dropdown / select that picks a document type
const selects = await page.$$eval("select", (els) =>
  els.map((e) => ({
    name: e.getAttribute("name"),
    id: e.id,
    options: Array.from(e.options).map((o) => o.textContent?.trim()).filter((t) => t),
  })),
)
console.log(`\nselects: ${selects.length}`)
for (const s of selects.slice(0, 8)) {
  console.log(`  name=${s.name} id=${s.id}`)
  console.log(`    options: ${(s.options || []).slice(0, 30).join(" / ")}`)
}

// Text mentions of relevant keywords on this page
const mentions = await page.$$eval("*", (els) =>
  els
    .filter((e) => {
      if (e.children.length > 0) return false
      const t = (e.textContent || "").trim()
      return t.length > 0 && t.length < 100 && /release|letter\s+of\s+release|\bLOR\b|transfer|prior|previous broker/i.test(t)
    })
    .map((e) => ({ tag: e.tagName.toLowerCase(), text: (e.textContent || "").trim().slice(0, 100) }))
    .slice(0, 30),
)
console.log(`\ntext mentions: ${mentions.length}`)
for (const m of mentions) console.log(`  ${m.tag}: "${m.text}"`)

// Try clicking "+ Add" / "Upload" / "+ Document" buttons to see what dialog appears
console.log("\n─── Trying to open Add/Upload dialog")
const addBtn = await page.$('button:has-text("Add"), button:has-text("Upload"), button:has-text("New"), button:has-text("+")')
if (addBtn) {
  console.log(`  found add button: "${await addBtn.textContent()}"`)
  await addBtn.click().catch(() => undefined)
  await page.waitForTimeout(2000)
  // Re-survey for new file inputs / selects
  const filesAfter = await page.$$('input[type="file"]')
  console.log(`  file inputs after click: ${filesAfter.length}`)
  const selectsAfter = await page.$$eval("select", (els) =>
    els.map((e) => ({
      name: e.getAttribute("name"),
      options: Array.from(e.options).map((o) => o.textContent?.trim()).filter((t) => t).slice(0, 30),
    })),
  )
  console.log(`  selects after click: ${selectsAfter.length}`)
  for (const s of selectsAfter.slice(0, 5)) {
    console.log(`    name=${s.name}  opts: ${(s.options || []).join(" / ")}`)
  }
}

// Final: any network requests we noticed?
console.log(`\n─── Network log (upload-ish URLs hit during this session):`)
for (const n of networkLog.slice(0, 20)) console.log(`  ${n.method} ${n.url} ${n.hasBody ? "(with body)" : ""}`)

await browser.close()
