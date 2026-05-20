/**
 * For each producer with Producer-stage appointment-requests, POST to
 * /surecrm/appointments-requests/{id}/email to re-trigger SureLC's
 * rep-review email. Then runRepReviewAndProcess will find a fresh
 * email instead of "no email arrived in time".
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
  history.pushState({}, "", `/bga/producers/5331616`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(4000)
if (!bearer) { console.error("no bearer"); process.exit(1) }

const targets = [
  { name: "Keyon", producerId: 5331616 },
  { name: "Josue", producerId: 11474830 },
]
for (const t of targets) {
  const r = await fetch(
    `https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${t.producerId}&gaId=1322`,
    { headers: { Authorization: `Bearer ${bearer}` } },
  )
  const reqs = await r.json()
  const stuck = (Array.isArray(reqs) ? reqs : []).filter(x => x.stage === "Producer")
  console.log(`\n=== ${t.name}: ${stuck.length} Producer-stage appts ===`)
  for (const a of stuck) {
    const id = a.appointmentRequestId
    console.log(`  ${a.carrierName} (id=${id})`)
    const res = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${id}/email`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: "{}",
    })
    console.log(`    POST .../email → ${res.status}`)
  }
}

await browser.close()
