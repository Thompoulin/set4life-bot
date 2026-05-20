/**
 * Discard all unsigned Carrier-stage appointments (created via direct
 * POST that bypassed rep-review and forms generation).
 * Targets: Demetrius, Holton, Terrence, Brandon.
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

const targets = [
  { name: "Demetrius", pid: 7533541 },
  { name: "Holton Buggs", pid: 11096584 },
  { name: "Terrence Gray", pid: 11168051 },
  { name: "Brandon Sims", pid: 11474775 },
]
for (const t of targets) {
  console.log(`\n=== ${t.name} (${t.pid}) ===`)
  const list = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${t.pid}&gaId=1322`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
  // Discard any Carrier/BGA/Producer-stage appointment that does NOT have reviewed=Y
  // (those were created via direct POST without forms — broken).
  const broken = list.filter((a) => a.stage !== "Discarded" && a.reviewed !== "Y")
  console.log(`  ${list.length} total, ${broken.length} broken (unreviewed)`)
  for (const a of broken) {
    const r = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${a.appointmentRequestId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${bearer}` },
    })
    console.log(`  DELETE ${a.carrierName.padEnd(45)} (id=${a.appointmentRequestId}) → ${r.status}`)
  }
}
await browser.close()
