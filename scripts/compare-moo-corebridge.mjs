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

// Sydney: 11482453, Josue: 11474830
for (const [name, pid] of [["Sydney signed", 11482453], ["Josue stuck", 11474830]]) {
  const list = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${pid}&gaId=1322`, { headers: { Authorization: `Bearer ${bearer}` } }).then(r => r.json())
  console.log(`\n=== ${name} ===`)
  for (const r of list.filter(x => /Mutual Of Omaha|Corebridge/i.test(x.carrierName))) {
    console.log(`  ${r.stage.padEnd(10)} ${r.carrierName.padEnd(25)} states=${r.states} products=${r.products}`)
  }
}
await browser.close()
