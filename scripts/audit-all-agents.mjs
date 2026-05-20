/**
 * Audit ALL active agents with SureLC producerIds — show their carrier
 * stage breakdown. Identifies who's NOT yet 9/9 ready-to-sell.
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
  ["Holton Buggs",   11096584],
  ["Sydney DeSilva", 11482453],
  ["Demetrius Early Jr", 7533541],
  ["Keyon Edwards", 5331616],
  ["Terrence Gray",  11168051],
  ["Zachary Love",   11474885],
  ["Paul Magistri",  11338188],
  ["Deborah Nabors", 11473444],
  ["Josue Trigueros", 11474830],
  ["Brandon Sims",   11474775],
]

console.log("Agent                       | Carrier | BGA | Producer | Disc | Status")
console.log("-".repeat(85))
for (const [name, pid] of agents) {
  const list = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${pid}&gaId=1322`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
  const counts = { Carrier: 0, BGA: 0, Producer: 0, Discarded: 0 }
  for (const r of list) counts[r.stage] = (counts[r.stage] || 0) + 1
  const carrier = counts.Carrier
  const status = carrier >= 9 ? "READY ✅" : carrier >= 7 ? "MOSTLY (carrier-issues)" : carrier > 0 ? "PARTIAL" : "NONE"
  console.log(`${name.padEnd(28)}| ${String(carrier).padStart(7)} | ${String(counts.BGA).padStart(3)} | ${String(counts.Producer).padStart(8)} | ${String(counts.Discarded).padStart(4)} | ${status}`)
}
await browser.close()
