import { chromium } from "playwright"
import pino from "pino"
import fs from "node:fs/promises"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"

const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } })
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)
const logger = pino({ name: "verify" })
await loginAdmin(page, { email: "thomas@thompoulin.com", password: "Exit-31$" }, logger)

// Show ALL stages to see where each appointment landed.
await gotoBga(
  page,
  "https://surelc.surancebay.com/bga/producers/11482453/appointments?stage=BGA,BGA-EW,Upline,Upline%20Signer,Carrier,Carrier-TPA,Carrier-EW,Producer,Producer-EW,Pending,Pending%20NB",
  logger,
)
await page.waitForTimeout(5000)

const out = `/tmp/verify-bga-${Date.now()}`
await fs.mkdir(out, { recursive: true })
await page.screenshot({ path: `${out}/all-appointments.png`, fullPage: true })

const rows = await page.$$eval('[role="row"][row-id]', (els) => {
  const seen = new Map()
  for (const e of els) {
    const id = e.getAttribute("row-id")
    if (!id || seen.has(id)) continue
    // Find col-id="stage" cell
    const stageCell = e.querySelector('[col-id="stage"]')
    const carrierCell = e.querySelector('[col-id="carrierName"]')
    const dateCell = e.querySelector('[col-id="stageChangeDate"]')
    seen.set(id, {
      id,
      stage: stageCell?.textContent?.trim() || "",
      carrier: carrierCell?.textContent?.trim().slice(0, 50) || "",
      date: dateCell?.textContent?.trim() || "",
    })
  }
  return [...seen.values()]
})
console.log("=== Sydney's appointments by stage ===")
for (const r of rows) {
  if (!r.stage && !r.carrier) continue
  console.log(`  ${r.id}  stage=${r.stage}  date=${r.date}  carrier=${r.carrier.slice(0, 50)}`)
}
const today = rows.filter(r => /05\/07\/2026/.test(r.date))
console.log(`\nToday's batch (9 from Phase B this morning):`)
for (const r of today) console.log(`  ${r.id}  stage=${r.stage}  ${r.carrier.slice(0, 50)}`)

await browser.close()
console.log(`\nDUMP → ${out}/`)
