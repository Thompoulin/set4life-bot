/**
 * Look for a SureLC "resend rep-review email" endpoint on the BGA SPA.
 * If found, we can re-trigger Phase B for stuck Producer-stage
 * appointments without waiting for the rep to manually request it.
 *
 * Test target: Keyon's Foresters appt-id (Producer stage).
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
  history.pushState({}, "", `/bga/producers/5331616/appointments`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(4000)
console.log("bearer:", !!bearer)

// Find Keyon's Foresters Producer-stage appointment ID
const r = await fetch(
  "https://surelc.surancebay.com/surecrm/appointments-requests?producerId=5331616&gaId=1322",
  { headers: { Authorization: `Bearer ${bearer}` } },
)
const data = await r.json()
const reqs = Array.isArray(data) ? data : data.content || data.items || []
const stuck = reqs.find((x) => /Foresters/i.test(x.carrierName || "") && (x.stage || "") === "Producer")
console.log("Foresters Producer-stage appt:", stuck?.appointmentRequestId || "(not found)")
if (!stuck) {
  // Fall back: any Producer-stage appt for probing
  const anyProducer = reqs.find(x => x.stage === "Producer")
  console.log("falling back to any Producer-stage:", anyProducer?.appointmentRequestId, anyProducer?.carrierName)
  if (!anyProducer) { await browser.close(); process.exit(0) }
  var id = anyProducer.appointmentRequestId
} else var id = stuck.appointmentRequestId

// Try possible "resend" endpoints
const candidates = [
  { method: "POST", path: `/surecrm/appointments-requests/${id}/resend-review` },
  { method: "POST", path: `/surecrm/appointments-requests/${id}/resend-email` },
  { method: "POST", path: `/surecrm/appointments-requests/${id}/resend` },
  { method: "POST", path: `/surecrm/appointments-requests/${id}/notify` },
  { method: "POST", path: `/surecrm/appointments-requests/${id}/email` },
  { method: "POST", path: `/surecrm/appointments-requests/${id}/request-review` },
  { method: "POST", path: `/surecrm/appointments-requests/${id}/send-review-email` },
  { method: "POST", path: `/surecrm/appointments-requests/${id}/sign/resend` },
  { method: "PUT",  path: `/surecrm/appointments-requests/${id}/resend` },
  { method: "POST", path: `/surecrm/email/appointment-request/${id}/resend` },
  { method: "POST", path: `/surecrm/notifications/appointment-request/${id}` },
]
for (const c of candidates) {
  try {
    const res = await fetch(`https://surelc.surancebay.com${c.path}`, {
      method: c.method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: c.method === "POST" || c.method === "PUT" ? "{}" : undefined,
    })
    if (res.status !== 404) {
      const t = (await res.text()).slice(0, 300)
      console.log(`${c.method} ${c.path} → ${res.status}: ${t}`)
    }
  } catch (e) {
    console.log(`${c.method} ${c.path} threw: ${e.message}`)
  }
}

// Also try OPTIONS to see what the server allows
console.log("\n--- OPTIONS probes ---")
for (const path of [
  `/surecrm/appointments-requests/${id}`,
  `/surecrm/appointments-requests/${id}/email`,
]) {
  const res = await fetch(`https://surelc.surancebay.com${path}`, {
    method: "OPTIONS",
    headers: { Authorization: `Bearer ${bearer}` },
  })
  console.log(`OPTIONS ${path} → ${res.status} | Allow: ${res.headers.get("allow")}`)
}

await browser.close()
