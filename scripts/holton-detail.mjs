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
const list = await fetch("https://surelc.surancebay.com/surecrm/appointments-requests?producerId=11096584&gaId=1322", { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
console.log(`Holton total: ${list.length}`)
const byStage = {}
for (const a of list) byStage[a.stage] = (byStage[a.stage] || 0) + 1
console.log("By stage:", byStage)
console.log("\nNon-Discarded:")
for (const a of list.filter(x => x.stage !== "Discarded")) {
  console.log(`  ${a.carrierName.padEnd(45)} stage=${a.stage} reviewed=${a.reviewed} status=${a.carrierStatus} createdDate=${a.createdDate?.slice(0,10)}`)
}
console.log("\nDiscarded (last 5):")
for (const a of list.filter(x => x.stage === "Discarded").slice(0,5)) {
  console.log(`  ${a.carrierName.padEnd(45)} reviewed=${a.reviewed} status=${a.carrierStatus} stageChangeDate=${a.stageChangeDate?.slice(0,10)}`)
}
await browser.close()
