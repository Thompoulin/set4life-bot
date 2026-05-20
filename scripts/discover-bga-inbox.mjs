import { chromium } from "playwright"
import pino from "pino"
import fs from "node:fs/promises"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"

const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)
const logger = pino({ name: "discover" })

await loginAdmin(page, { email: "thomas@thompoulin.com", password: "Exit-31$" }, logger)

// Navigate directly to the Phase C wizard for Sydney's Americo appointment.
const wizardUrl = "https://surelc.surancebay.com/bga/producers/11482453/appointments/wizard/guard/116798697"
const r = await gotoBga(page, wizardUrl, logger)
await page.waitForTimeout(6000)
console.log("Phase C wizard URL:", page.url())
console.log("Title:", await page.title())

const out = `/tmp/discover-bga-${Date.now()}`
await fs.mkdir(out, { recursive: true })
await page.screenshot({ path: `${out}/phaseC-step1.png`, fullPage: true })
await fs.writeFile(`${out}/phaseC-step1.html`, await page.content())

// Find step indicator + buttons.
const stepText = await page.$$eval('[class*="step"], [class*="navigator-header"]', (els) => 
  els.filter(e => e.offsetParent !== null).map(e => e.textContent?.trim().slice(0, 100)).filter(t => t).slice(0, 10)
)
console.log("\nStep-related text:")
for (const t of stepText) console.log(`  ${t}`)

const btns = await page.$$eval("button", (els) =>
  els.filter(e => e.offsetParent !== null && !e.disabled)
    .map(e => e.textContent?.trim().slice(0, 50))
    .filter(t => t)
    .slice(0, 25)
)
console.log("\nVisible enabled buttons:")
for (const b of btns) console.log(`  [${b}]`)

const comps = await page.$$eval("body", (els) => {
  const html = els[0]?.outerHTML || ""
  const tags = new Set()
  for (const m of html.matchAll(/<(sb-[a-z-]+|bga-[a-z-]+|app-[a-z-]+)\b/g)) tags.add(m[1])
  return [...tags].sort()
})
console.log("\nCustom components on page:", comps.slice(0, 20))

console.log(`\nDUMP → ${out}/`)
await browser.close()
