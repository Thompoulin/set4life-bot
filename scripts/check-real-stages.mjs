/**
 * Query the BGA SPA's /surecrm/appointments-requests endpoint with
 * Bearer JWT auth to get ground-truth stage breakdown for a producer.
 * Public x-api-key API filters out some stages — this is the real one.
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const PRODUCER_IDS = process.argv.slice(2)
if (PRODUCER_IDS.length === 0) {
  console.error("usage: check-real-stages.mjs <producerId> [<producerId>...]")
  process.exit(1)
}

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)
const logger = pino({ name: "real-stages" })

await loginAdmin(
  page,
  { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" },
  logger,
)

// Capture Bearer JWT
let bearer = null
const handler = (req) => {
  const a = req.headers()["authorization"]
  if (req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
    bearer = a.replace("Bearer ", "")
    page.off("request", handler)
  }
}
page.on("request", handler)
await page.evaluate((id) => {
  history.pushState({}, "", `/bga/producers/${id}/profile`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
}, PRODUCER_IDS[0])
await page.waitForTimeout(4000)

if (!bearer) {
  console.error("FAIL: no Bearer captured")
  await browser.close()
  process.exit(1)
}

for (const PRODUCER_ID of PRODUCER_IDS) {
  console.log(`\n=== Producer ${PRODUCER_ID} ===`)
  const url = `https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${PRODUCER_ID}&gaId=1322`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } })
  if (!res.ok) {
    console.log(`  FAIL ${res.status}`)
    continue
  }
  const data = await res.json()
  const rows = Array.isArray(data) ? data : data.content || []
  console.log(`  total: ${rows.length}`)
  const stages = {}
  const subs = {}
  for (const r of rows) {
    const stage = r.stage || "?"
    const sub = r.subStatus || "?"
    stages[stage] = (stages[stage] || 0) + 1
    subs[`${stage}/${sub}`] = (subs[`${stage}/${sub}`] || 0) + 1
  }
  console.log("  stages:", stages)
  console.log("  stage/subStatus:", subs)
  console.log("  agent numbers:")
  for (const r of rows) {
    if (r.agentNumber) {
      console.log(`    - ${r.carrierName || "?"} → ${r.agentNumber}`)
    }
  }
}

await browser.close()
