/**
 * Inspect ALL fields on each agent's Carrier-stage appointments to see
 * what "Docs" state Thom is referring to.
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

// Compare Sydney (legitimately signed) vs Demetrius (created via direct POST)
for (const [name, pid] of [["Sydney (signed)", 11482453], ["Demetrius (created)", 7533541], ["Keyon (mix)", 5331616]]) {
  console.log(`\n=== ${name} ===`)
  const list = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${pid}&gaId=1322`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
  const at = list.filter((x) => x.stage === "Carrier")
  console.log(`Carrier-stage count: ${at.length}`)
  for (const a of at.slice(0, 2)) {
    console.log(`  --- ${a.carrierName} ---`)
    console.log(`  stage=${a.stage} reviewed=${a.reviewed} carrierStatus=${a.carrierStatus} stageChangeDate=${a.stageChangeDate?.slice(0,10)} confirmationDate=${a.confirmationDate?.slice(0,10)} paperworkDate=${a.paperworkDate?.slice(0,10)}`)
    console.log(`  carrierFreshContracts=${a.carrierFreshContracts} digitalSignature=${a.digitalSignature} moveToCompleted=${a.moveToCompleted} onboardDecisionEmailHasBeenSent=${a.onboardDecisionEmailHasBeenSent}`)
    const keys = Object.keys(a).filter(k => /status|stage|sub|state|phase|step|status/i.test(k))
    for (const k of keys) console.log(`  ${k}=${JSON.stringify(a[k]).slice(0,80)}`)
  }
}
await browser.close()
