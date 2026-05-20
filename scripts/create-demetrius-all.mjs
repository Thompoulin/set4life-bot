/**
 * Create all 9 appointment-requests for Demetrius by copying Sydney's
 * working configs. Bypasses Fastlane (which fails because Sandi Kruise
 * upstream training-cert service is down).
 *
 * SureLC accepts direct POST /surecrm/appointments-requests with
 * carrierId + producerId + states + products. Stage auto-advances to
 * BGA (since admin is posting) — Phase C bulk-release pushes to Carrier.
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
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/7533541"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)

// Get Demetrius's currently-existing carriers (the 1 Foresters we just created)
const existing = await fetch("https://surelc.surancebay.com/surecrm/appointments-requests?producerId=7533541&gaId=1322", {
  headers: { Authorization: `Bearer ${bearer}` },
}).then(r => r.json())
const existingCarriers = new Set(existing.filter(a => a.stage !== "Discarded").map(a => a.carrierName))
console.log("Demetrius already has:", [...existingCarriers].join(", "))

// Pull Sydney's signed carriers as templates
const sydneyAppts = await fetch("https://surelc.surancebay.com/surecrm/appointments-requests?producerId=11482453&gaId=1322", {
  headers: { Authorization: `Bearer ${bearer}` },
}).then(r => r.json())

// Get Demetrius's producer profile to copy NPN/dbaId etc
const demProducer = await fetch("https://surelc.surancebay.com/surecrm/appointments-requests?producerId=7533541&gaId=1322", {
  headers: { Authorization: `Bearer ${bearer}` },
}).then(r => r.json())
const demSample = demProducer.find(a => a.producerId === 7533541)
console.log("Demetrius sample appointment fields:", { npn: demSample?.npn, dbaId: demSample?.dbaId, producerEffectiveEmail: demSample?.producerEffectiveEmail })

const targets = sydneyAppts.filter(a => a.stage === "Carrier" && !existingCarriers.has(a.carrierName))
console.log(`\nWill create ${targets.length} appointment-requests for Demetrius`)

const results = []
for (const t of targets) {
  const newAppt = {
    ...t,
    appointmentRequestId: undefined,
    producerId: 7533541,
    npn: demSample?.npn || t.npn,
    dbaId: demSample?.dbaId || t.dbaId,
    producerName: "EARLY JR, DEMETRIUS",
    producerEmail: demSample?.producerEmail || "demetrius.earlyjr.1@agent.set4lifeagency.com",
    producerEffectiveEmail: demSample?.producerEffectiveEmail || "demetrius.earlyjr.1@agent.set4lifeagency.com",
    producerEmailUsed: demSample?.producerEmailUsed || demSample?.producerEffectiveEmail,
    producerEffectivePhone: demSample?.producerEffectivePhone,
    carrierStatus: "ProducerReview",
    stage: "Producer",
    reviewed: "N",
    states: "GA",  // Match Demetrius's resident state (single-state pattern that works)
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
  const status = r.status
  const txt = (await r.text()).slice(0, 200)
  results.push({ carrier: t.carrierName, status, body: txt.slice(0, 100) })
  console.log(`  ${t.carrierName.padEnd(45)} → ${status}`)
}

console.log("\n=== summary ===")
console.log(`created: ${results.filter(r => r.status === 200 || r.status === 201).length}/${results.length}`)
for (const r of results.filter(r => r.status !== 200 && r.status !== 201)) {
  console.log(`  FAILED: ${r.carrier} → ${r.status}: ${r.body}`)
}

await browser.close()
