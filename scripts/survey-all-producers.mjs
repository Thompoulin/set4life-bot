// API-based survey: pull all S4L producers + their validation flags.
// Reports counts per flag-code + the exact list per category.
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"

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
await gotoBga(page, "https://surelc.surancebay.com/bga/producers", logger)
await page.waitForTimeout(4000)
if (!bearer) { console.error("no bearer"); process.exit(1) }

// Pull producer list for agency 1322
const listRes = await fetch(`https://surelc.surancebay.com/validation/producers/byGaId/1322`, {
  method: "POST",
  headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  body: JSON.stringify({ lookupType: "all", producerIds: [] }),
})
const list = await listRes.json()
const producers = list.data || []
console.error(`fetched ${producers.length} producers in agency`)

// Get all producer IDs
const ids = producers.map((p) => p.producerId)

// Bulk validation
const valRes = await fetch(`https://surelc.surancebay.com/surecrm/validation/list`, {
  method: "POST",
  headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  body: JSON.stringify(ids),
})
const warnings = await valRes.json()

// Group warnings per producer
const byProducer = new Map()
for (const w of warnings) {
  const pid = w.producerId
  if (!byProducer.has(pid)) byProducer.set(pid, [])
  byProducer.get(pid).push(w.code)
}

// Build report
const codeCount = {}
const producerSummary = producers.map((p) => {
  const codes = byProducer.get(p.producerId) || []
  for (const c of codes) codeCount[c] = (codeCount[c] || 0) + 1
  return {
    id: p.producerId,
    name: `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim(),
    flags: codes,
    clean: codes.length === 0,
  }
})

console.log(JSON.stringify({
  totalProducers: producers.length,
  clean: producerSummary.filter((p) => p.clean).length,
  flagged: producerSummary.filter((p) => !p.clean).length,
  codeCount,
  flaggedDetail: producerSummary.filter((p) => !p.clean).sort((a, b) => a.name.localeCompare(b.name)),
}, null, 2))

await browser.close()
