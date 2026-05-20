/**
 * Probe whether we can POST to /surecrm/appointments-requests to
 * create a new appointment-request directly, bypassing Fastlane.
 * Test target: copy Sydney's signed Foresters config for Demetrius.
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

// First fetch Sydney's signed Foresters as a template
const sydneyForesters = await fetch("https://surelc.surancebay.com/surecrm/appointments-requests/116798741", {
  headers: { Authorization: `Bearer ${bearer}` },
}).then(r => r.json())

const newAppt = {
  ...sydneyForesters,
  appointmentRequestId: undefined,
  producerId: 7533541, // Demetrius
  npn: "8345466",  // Demetrius's NPN — let me look up
  dbaId: undefined,  // will be Demetrius's
  producerName: "EARLY JR, DEMETRIUS",
  producerEmail: "demetrius.earlyjr.1@agent.set4lifeagency.com",
  producerEffectiveEmail: "demetrius.earlyjr.1@agent.set4lifeagency.com",
  carrierStatus: "ProducerReview",
  stage: "Producer",
  reviewed: "N",
  ts: undefined,
  paperworkDate: undefined,
  requestReviewDate: undefined,
  comments: undefined,
  emls: "",
  states: "GA",  // Match Keyon's working pattern
  digitalSignature: false,
}
delete newAppt.appointmentRequestId
delete newAppt.ts
delete newAppt.paperworkDate
delete newAppt.requestReviewDate
delete newAppt.comments
delete newAppt.dbaId

console.log("Probing POST /surecrm/appointments-requests")
const r = await fetch("https://surelc.surancebay.com/surecrm/appointments-requests", {
  method: "POST",
  headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  body: JSON.stringify(newAppt),
})
console.log(`POST → ${r.status}: ${(await r.text()).slice(0, 600)}`)

// Also try OPTIONS to see allowed methods
const opt = await fetch("https://surelc.surancebay.com/surecrm/appointments-requests", {
  method: "OPTIONS",
  headers: { Authorization: `Bearer ${bearer}` },
})
console.log(`OPTIONS → ${opt.status}, Allow: ${opt.headers.get("allow")}`)

await browser.close()
