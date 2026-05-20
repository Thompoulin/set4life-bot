/**
 * Check actual SureLC appointment stages for the 3 agents Thom
 * flagged: Demetrius, Keyon, Josue. Reports per-carrier stage so
 * we know if they're "done" (CARRIER) or still pending Phase B/C.
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, pino())
let bearer = null
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (!bearer && req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
    const b = a.replace("Bearer ", "")
    if (b.split(".").length === 3) bearer = b
  }
})
await page.evaluate(() => {
  history.pushState({}, "", `/bga/producers/7533541`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(4000)
if (!bearer) { console.error("no bearer"); process.exit(1) }

const targets = [
  { name: "Demetrius EARLY JR", producerId: 7533541 },
  { name: "Keyon EDWARDS", producerId: 5331616 },
  { name: "Josue TRIGUEROS", producerId: 11474830 },
  { name: "Sydney DESILVA", producerId: 11482453 },
]

for (const t of targets) {
  const r = await fetch(
    `https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${t.producerId}&gaId=1322`,
    { headers: { Authorization: `Bearer ${bearer}` } },
  )
  const data = await r.json()
  const reqs = Array.isArray(data) ? data : data.content || data.items || []
  console.log(`\n=== ${t.name} (producer ${t.producerId}) — ${reqs.length} requests ===`)
  const byStage = new Map()
  const byCarrier = new Map()
  for (const req of reqs) {
    const stage = req.stage || req.requestStage || req.status || "?"
    const carrier = req.carrierName || req.carrier?.name || req.carrier || "?"
    byStage.set(stage, (byStage.get(stage) || 0) + 1)
    if (!byCarrier.has(carrier) || stageOrder(stage) > stageOrder(byCarrier.get(carrier))) {
      byCarrier.set(carrier, stage)
    }
  }
  console.log("  by stage:", [...byStage.entries()].map(([s, n]) => `${s}=${n}`).join(", "))
  console.log("  unique carriers:", byCarrier.size)
  if (byCarrier.size <= 12) {
    for (const [c, s] of byCarrier) console.log(`    ${s.padEnd(15)} ${c}`)
  }
}

function stageOrder(s) {
  const order = ["Discarded", "Producer", "BGA", "Carrier"]
  return order.indexOf(s)
}

await browser.close()
