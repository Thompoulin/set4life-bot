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

// Find Sydney's Foresters appointment
const list = await fetch(
  "https://surelc.surancebay.com/surecrm/appointments-requests?producerId=11482453&gaId=1322",
  { headers: { Authorization: `Bearer ${bearer}` } },
).then(r => r.json())
const sydneyForesters = list.find(x => /Foresters/i.test(x.carrierName) && x.stage === "Carrier")
console.log("Sydney Foresters:", sydneyForesters?.appointmentRequestId, sydneyForesters?.products, JSON.stringify(sydneyForesters?.carrierProducts))

// Compare Josue's stuck ones too
const josue = await fetch(
  "https://surelc.surancebay.com/surecrm/appointments-requests?producerId=11474830&gaId=1322",
  { headers: { Authorization: `Bearer ${bearer}` } },
).then(r => r.json())
console.log("\n=== Josue stuck Producer-stage ===")
for (const r of josue.filter(x => x.stage === "Producer")) {
  console.log(`  ${r.carrierName} (id=${r.appointmentRequestId}) products=${r.products}`)
}
console.log("\n=== Josue signed Carrier-stage ===")
for (const r of josue.filter(x => x.stage === "Carrier")) {
  console.log(`  ${r.carrierName} (id=${r.appointmentRequestId}) products=${r.products}`)
}

await browser.close()
