/**
 * Get Demetrius's full producer profile from BGA SPA + public API to
 * find what's missing/invalid that Fastlane is flagging.
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
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (!bearer && req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
    const b = a.replace("Bearer ", "")
    if (b.split(".").length === 3) bearer = b
  }
})
await page.evaluate(() => {
  history.pushState({}, "", `/bga/producers/7533541`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(4000)
if (!bearer) { console.error("no bearer"); process.exit(1) }

// Try common producer-facing endpoints (BGA SPA must use SOMETHING)
const endpoints = [
  "/surecrm/producer/7533541",
  "/surecrm/producers/7533541",
  "/surecrm/producer-profile/7533541",
  "/surecrm/producer/7533541/profile",
  "/surecrm/producer/7533541/details",
  "/surecrm/profile/7533541",
  "/surecrm/eno/producer/7533541",
  "/surecrm/finra/producer/7533541",
  "/surecrm/dba/producer/7533541",
  "/surecrm/license/producer/7533541",
  "/surecrm/training/producer/7533541",
  "/surecrm/signature/producer/7533541",
  "/surecrm/questions/producer/7533541",
]
for (const path of endpoints) {
  const r = await fetch(`https://surelc.surancebay.com${path}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  if (r.status !== 404) {
    const t = (await r.text()).slice(0, 800)
    console.log(`\nGET ${path} → ${r.status}:\n  ${t}`)
  }
}

// Now try Fastlane-specific submit/preview endpoints
console.log("\n\n=== Fastlane endpoints ===")
const fastlaneEnd = [
  "/surecrm/fastlane",
  "/surecrm/fastlane/producer/7533541",
  "/surecrm/fastlane/preview/7533541",
  "/surecrm/fastlane/submit/7533541",
  "/surecrm/fastlane/eligibility/7533541",
  "/surecrm/fastlane/check/7533541",
  "/surecrm/fastlane/validate/7533541",
  "/surecrm/fastlane/carriers",
  "/surecrm/fastlane/agencies",
]
for (const path of fastlaneEnd) {
  const r = await fetch(`https://surelc.surancebay.com${path}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  if (r.status !== 404) {
    const t = (await r.text()).slice(0, 400)
    console.log(`GET ${path} → ${r.status}: ${t}`)
  }
}

await browser.close()
