/**
 * Inspect in-flight (stage=BGA or Producer) appointment-requests for
 * Holton + Terrence — show carrier + stage age so we can decide if
 * Phase B needs a manual nudge.
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
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/11096584"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)
const agents = [
  ["Holton Buggs", 11096584],
  ["Terrence Gray", 11168051],
]
const now = Date.now()
for (const [name, pid] of agents) {
  console.log(`\n== ${name} (${pid}) ==`)
  const list = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${pid}&gaId=1322`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
  const inFlight = list.filter(a => a.stage === "BGA" || a.stage === "Producer")
  for (const r of inFlight) {
    const ageDays = r.stageChangeDate ? Math.floor((now - Date.parse(r.stageChangeDate)) / 86_400_000) : "?"
    console.log(`  id=${r.appointmentRequestId}  ${r.carrierName.padEnd(45)} stage=${r.stage}  reviewed=${r.reviewed || "-"}  status=${r.carrierStatus || "-"}  stageChange=${r.stageChangeDate?.slice(0, 10) || "-"} (${ageDays}d)`)
  }
  if (inFlight.length === 0) console.log("  (none in flight)")
}
await browser.close()
