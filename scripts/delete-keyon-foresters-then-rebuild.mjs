/**
 * Hard reset Keyon's Foresters appointment:
 * 1. DELETE the stuck Producer-stage appointment-request (goes to Discarded).
 * 2. Then we need to fire Phase A (Fastlane) so it re-submits Foresters.
 *
 * Step 1 is done here. Step 2 is a separate /api/debug/surelc-run-bot
 * call (full pipeline) — Fastlane will see no active Foresters and
 * re-submit it from scratch with current rep state.
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
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/5331616"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)

const id = 116935372 // Keyon Foresters Producer-stage
const r = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${id}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${bearer}` },
})
console.log(`DELETE Foresters ${id} → ${r.status}: ${(await r.text()).slice(0, 200)}`)
await browser.close()
