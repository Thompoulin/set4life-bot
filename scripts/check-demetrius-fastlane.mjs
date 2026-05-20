/**
 * Check what Fastlane validation issues are flagged for Demetrius
 * (producer 7533541). The bot couldn't capture the "N issues" tooltip
 * — let's hit the validation endpoint directly.
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, pino())
let bearer = null
const handler = (req) => {
  const a = req.headers()["authorization"]
  if (req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
    const b = a.replace("Bearer ", "")
    if (!bearer && b.split(".").length === 3) { bearer = b; page.off("request", handler) }
  }
}
page.on("request", handler)
// Visit producer page so SPA fires authenticated calls
await page.evaluate(() => {
  history.pushState({}, "", `/bga/producers/7533541`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(4000)
console.log("bearer:", !!bearer)

// Probe candidate validation endpoints
for (const path of [
  "/surecrm/validation/producer/7533541",
  "/surecrm/validators/producer/7533541",
  "/surecrm/producer/7533541/validation",
  "/surecrm/producer/7533541/issues",
  "/surecrm/producer/7533541/profile-issues",
  "/surecrm/producer/7533541/fastlane-issues",
  "/surecrm/fastlane/validation/7533541",
  "/surecrm/fastlane/producer/7533541/issues",
  "/surecrm/fastlane/issues/7533541",
  "/surecrm/producers/7533541/issues",
  "/surecrm/producers/7533541/validation",
]) {
  try {
    const r = await fetch(`https://surelc.surancebay.com${path}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    const status = r.status
    const txt = (await r.text()).slice(0, 600)
    if (status !== 404) console.log(`GET ${path} → ${status}: ${txt}`)
  } catch (e) { console.log(`${path} threw: ${e.message}`) }
}

// Also navigate to Fastlane page itself and observe its data calls
console.log("\n=== loading Fastlane wizard page ===")
const calls = []
page.on("request", (req) => {
  const u = req.url()
  if (u.includes("/surecrm/") && (u.includes("fastlane") || u.includes("validat") || u.includes("issue") || u.includes("7533541"))) {
    calls.push({ method: req.method(), url: u.replace("https://surelc.surancebay.com",""), post: (req.postData()||"").slice(0,200) })
  }
})
await page.evaluate(() => {
  history.pushState({}, "", `/bga/fastlane`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(5000)
console.log("Fastlane page calls:")
for (const c of calls) console.log(`  ${c.method} ${c.url}${c.post ? " — post: " + c.post : ""}`)

await browser.close()
