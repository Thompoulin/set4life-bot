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
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/5331616"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)

// All Keyon appointments with state lists
const list = await fetch(
  "https://surelc.surancebay.com/surecrm/appointments-requests?producerId=5331616&gaId=1322",
  { headers: { Authorization: `Bearer ${bearer}` } },
).then(r => r.json())

console.log("=== Keyon ALL appointments — states by carrier ===")
for (const r of list) {
  console.log(`  ${r.stage.padEnd(10)} ${r.carrierName.padEnd(45)} states=${r.states}`)
}

// Get Keyon's actual licensed states via public API
console.log("\n=== Probing Keyon's actual licenses ===")
for (const path of [
  "/api/v2/producers/5331616/licenses",
  "/surecrm/licenses/producer/5331616",
  "/surecrm/license?producerId=5331616",
  "/surecrm/producer-licenses/5331616",
]) {
  const r = await fetch(`https://surelc.surancebay.com${path}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  if (r.status !== 404) {
    const t = (await r.text()).slice(0, 600)
    console.log(`  ${path} → ${r.status}: ${t}`)
  }
}

await browser.close()
