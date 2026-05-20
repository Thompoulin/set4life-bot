/**
 * Inspect Carrier-stage shells (reviewed!=Y or carrierStatus!=ProducerConfirmed,
 * no agentNo) for Sydney, Paul, Deborah — verify each before discard.
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
  ["Sydney DeSilva", 11482453],
  ["Paul Magistri", 11338188],
  ["Deborah Nabors", 11473444],
]
for (const [name, pid] of agents) {
  console.log(`\n== ${name} (${pid}) ==`)
  const list = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${pid}&gaId=1322`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
  const shells = list.filter(a => a.stage === "Carrier" && (!a.reviewed || a.carrierStatus !== "ProducerConfirmed") && !a.agentNo)
  for (const s of shells) {
    console.log(`  id=${s.appointmentRequestId}  carrier=${s.carrierName}  reviewed=${s.reviewed || "(null)"}  status=${s.carrierStatus || "(null)"}  paperwork=${s.paperworkDate?.slice(0, 10) || "-"}  stageChange=${s.stageChangeDate?.slice(0, 10) || "-"}`)
  }
  if (shells.length === 0) console.log("  (no shells)")
}
await browser.close()
