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

const ids = {
  "Sydney (signed)": 116798741,
  "Josue (signed)": 116930290,
  "Keyon (stuck)": 116935372,
}
for (const [name, id] of Object.entries(ids)) {
  const r = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${id}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  }).then(r => r.json())
  console.log(`\n=== ${name} (id=${id}) ===`)
  for (const k of Object.keys(r).sort()) {
    if (k === "comments" || k === "statesInfo" || k === "carrierProducts") continue
    const v = r[k]
    if (typeof v === "object") continue
    console.log(`  ${k}: ${String(v).slice(0, 120)}`)
  }
}
await browser.close()
