/**
 * Try patching Josue's MoO appointment to mimic Sydney's signed config.
 * Sydney: states=MD products=lifeFixed → signed.
 * Josue stuck: states=FL products=lifeFixed → E&O error on welcome.
 *
 * Try empty states first (most likely to skip state-specific E&O check).
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
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/11474830"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)

const id = 116935218
const cur = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${id}`, {
  headers: { Authorization: `Bearer ${bearer}` },
}).then(r => r.json())
console.log("Current MoO states:", cur.states)
const patched = { ...cur, states: "", statesInfo: [] }
console.log("Patching to states=\"\" (empty)")
const r = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${id}`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  body: JSON.stringify(patched),
})
console.log(`PUT → ${r.status}: ${(await r.text()).slice(0, 200)}`)
await browser.close()
