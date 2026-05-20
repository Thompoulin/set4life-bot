/**
 * Seed appointment-requests for any producer via Playwright admin login.
 * Replicates what /create-appointment-requests does but bypasses the bot's
 * HTTP endpoint (which the public URL doesn't route to).
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const TARGETS = [
  { producerId: 11096584, name: "Holton Buggs" },
  { producerId: 11168051, name: "Terrence Gray" },
  { producerId: 11474775, name: "Brandon Sims" },
]
const TEMPLATE_PRODUCER_ID = 11482453 // Sydney

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
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/11482453"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)

const templates = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${TEMPLATE_PRODUCER_ID}&gaId=1322`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
const carrierTemplates = templates.filter((t) => t.stage === "Carrier")
console.log(`Found ${carrierTemplates.length} carrier templates from Sydney`)

for (const tgt of TARGETS) {
  console.log(`\n=== ${tgt.name} (${tgt.producerId}) ===`)
  // Get producer info for npn/dbaId
  const prodInfo = await fetch(`https://surelc.surancebay.com/api/v2/producers/${tgt.producerId}`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  // Get resident state from licenses
  const lic = await fetch(`https://surelc.surancebay.com/surecrm/licenses/producer/${tgt.producerId}`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => (r.ok ? r.json() : []))
  const resident = (Array.isArray(lic) ? lic : []).find((l) => l.isResidentLicense === "Y" && l.status === "Active")
  if (!resident) { console.log(`  no resident license — SKIPPING`); continue }
  console.log(`  resident state: ${resident.state}`)

  // Existing carriers (skip)
  const existing = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${tgt.producerId}&gaId=1322`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
  const existingCarriers = new Set((Array.isArray(existing) ? existing : []).filter((a) => a.stage !== "Discarded").map((a) => a.carrierName))
  const repSample = (Array.isArray(existing) ? existing : [])[0]

  let created = 0, failed = 0
  for (const t of carrierTemplates) {
    if (existingCarriers.has(t.carrierName)) continue
    const newAppt = {
      ...t,
      appointmentRequestId: undefined,
      producerId: tgt.producerId,
      npn: repSample?.npn,
      dbaId: repSample?.dbaId,
      producerName: repSample?.producerName,
      producerEmail: repSample?.producerEmail,
      producerEffectiveEmail: repSample?.producerEffectiveEmail,
      producerEmailUsed: repSample?.producerEmailUsed,
      producerEffectivePhone: repSample?.producerEffectivePhone,
      carrierStatus: "ProducerReview",
      stage: "Producer",
      reviewed: "N",
      states: resident.state,
      statesInfo: [],
      digitalSignature: false,
    }
    delete newAppt.appointmentRequestId
    delete newAppt.ts
    delete newAppt.paperworkDate
    delete newAppt.requestReviewDate
    delete newAppt.stageChangeDate
    delete newAppt.confirmationDate
    delete newAppt.confirmationIP
    delete newAppt.comments

    const r = await fetch("https://surelc.surancebay.com/surecrm/appointments-requests", {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(newAppt),
    })
    if (r.status === 200 || r.status === 201) {
      created += 1
    } else {
      failed += 1
      console.log(`  FAIL ${t.carrierName}: ${r.status} ${(await r.text()).slice(0, 150)}`)
    }
  }
  console.log(`  created=${created} failed=${failed}`)
}

await browser.close()
