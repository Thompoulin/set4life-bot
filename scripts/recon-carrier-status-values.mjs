/**
 * Recon: enumerate every distinct carrierStatus value across all
 * appointment-requests for active agents. Need to identify which
 * values indicate approval vs rejection vs in-progress.
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

const producerIds = [11096584, 11482453, 7533541, 5331616, 11168051, 11474885, 11338188, 11473444, 11474830, 11474775]
const statusFreq = new Map()
const sampleByStatus = new Map()
let totalSeen = 0
for (const pid of producerIds) {
  const list = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${pid}&gaId=1322`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
  for (const a of Array.isArray(list) ? list : []) {
    totalSeen++
    const key = `stage=${a.stage} carrierStatus=${a.carrierStatus || "(null)"} reviewed=${a.reviewed || "(null)"} agentNo=${a.agentNo ? "set" : "null"}`
    statusFreq.set(key, (statusFreq.get(key) || 0) + 1)
    if (!sampleByStatus.has(key)) {
      sampleByStatus.set(key, { carrier: a.carrierName, id: a.appointmentRequestId, paperworkDate: a.paperworkDate?.slice(0,10), stageChangeDate: a.stageChangeDate?.slice(0,10) })
    }
  }
}
console.log(`Total appointments scanned: ${totalSeen}\n`)
const sorted = [...statusFreq.entries()].sort((a, b) => b[1] - a[1])
console.log("Distinct (stage, carrierStatus, reviewed, agentNo) combos by frequency:")
for (const [k, n] of sorted) {
  const s = sampleByStatus.get(k)
  console.log(`  ${n.toString().padStart(3)}x  ${k}`)
  console.log(`         e.g. ${s.carrier} id=${s.id} paperwork=${s.paperworkDate}`)
}
await browser.close()
