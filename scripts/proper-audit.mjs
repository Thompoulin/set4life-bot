/**
 * Audit ALL active agents — for EACH carrier appointment, surface:
 *
 *   - "Approved"  = agentNo populated. The only signal the carrier
 *                   actually issued a writing number; rep can sell.
 *   - "Submitted" = stage=Carrier OR Upline, reviewed=Y, NO agentNo.
 *                   Paperwork is past the rep and being processed
 *                   downstream (Upline = Quility forwarding to carrier;
 *                   Carrier = carrier processing).
 *   - "Unsigned"  = stage=Carrier/Upline, reviewed!=Y, NO agentNo.
 *                   Rep hasn't signed yet — Phase B owes a sign attempt.
 *   - "In flight" = stage=BGA or Producer (bot-side workflow).
 *
 * "Submitted" is necessary but NOT sufficient for the rep to sell —
 * conflating the two cost us four false-positive "you're fully
 * contracted" SMSes in 2026-05; see the gate fix in
 * server/services/contractingOrchestrator.ts.
 *
 * Upline note (2026-05-11): missing this stage from the categorization
 * caused appointments to disappear from the audit columns entirely,
 * making it look like Sydney lost 2 appointments overnight when she
 * hadn't.
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
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/11482453"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)
const agents = [
  ["Holton Buggs", 11096584],
  ["Sydney DeSilva", 11482453],
  ["Demetrius Early Jr", 7533541],
  ["Keyon Edwards", 5331616],
  ["Terrence Gray", 11168051],
  ["Zachary Love", 11474885],
  ["Paul Magistri", 11338188],
  ["Deborah Nabors", 11473444],
  ["Josue Trigueros", 11474830],
  ["Brandon Sims", 11474775],
]
console.log("Agent                       | Approved | Submitted | Unsigned | In flight | Status")
console.log("-".repeat(100))
for (const [name, pid] of agents) {
  const list = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${pid}&gaId=1322`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
  const active = list.filter(a => a.stage !== "Discarded")
  const approved = active.filter(a => !!a.agentNo).length
  const submitted = active.filter(a => (a.stage === "Carrier" || a.stage === "Upline") && a.reviewed === "Y" && !a.agentNo).length
  const unsigned = active.filter(a => (a.stage === "Carrier" || a.stage === "Upline") && a.reviewed !== "Y" && !a.agentNo).length
  const inFlight = active.filter(a => a.stage === "BGA" || a.stage === "Producer").length
  const total = active.length
  let status
  if (approved === total && total > 0) status = "READY ✅ (all approved)"
  else if (approved > 0) status = `${approved}/${total} approved`
  else if (unsigned > 0) status = `${unsigned} need sign`
  else if (submitted > 0) status = `awaiting carrier (${submitted}/${total} submitted)`
  else if (inFlight > 0) status = `in flight (${inFlight})`
  else status = "NOT STARTED"
  console.log(`${name.padEnd(28)}| ${String(approved).padStart(8)} | ${String(submitted).padStart(9)} | ${String(unsigned).padStart(8)} | ${String(inFlight).padStart(9)} | ${status}`)
}
await browser.close()
