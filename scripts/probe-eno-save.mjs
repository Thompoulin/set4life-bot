/**
 * Find the BGA SPA's E&O save endpoint by:
 * 1. Login as admin → navigate to a producer with a SAVED E&O policy
 *    (Sydney 11482453 — known working)
 * 2. Capture the GET responses for /surecrm/eno/* during page load
 * 3. Print response shapes so we can construct a write request
 *
 * Then test write methods (POST/PUT/PATCH) on a no-policy producer
 * (Demetrius 7533541) to discover which one actually creates a policy.
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, pino())

let bearer = null
const handler = (req) => {
  const a = req.headers()["authorization"]
  if (req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
    const b = a.replace("Bearer ", "")
    if (!bearer && b.split(".").length === 3) {
      bearer = b
      page.off("request", handler)
    }
  }
}
page.on("request", handler)
await page.evaluate(() => {
  history.pushState({}, "", `/bga/producers/11482453/eno`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(4000)
console.log("bearer captured")

// Sydney has a saved policy — fetch its full shape
console.log("\n=== GET /surecrm/eno/producer/11482453 (Sydney - has saved policy) ===")
const sydneyRes = await fetch("https://surelc.surancebay.com/surecrm/eno/producer/11482453", {
  headers: { Authorization: `Bearer ${bearer}` },
})
const sydneyData = await sydneyRes.json()
// Find the actual policy entry (not the template)
const sydneyPolicies = sydneyData.policies || sydneyData.individualPolicies || []
console.log("policies count:", sydneyPolicies.length)
if (sydneyPolicies[0]) {
  console.log("first policy keys:", Object.keys(sydneyPolicies[0]))
  console.log("first policy:", JSON.stringify(sydneyPolicies[0], null, 2).slice(0, 2000))
}

// Look for individual policies in different field names
console.log("\n=== top-level keys on response ===")
console.log(Object.keys(sydneyData))
console.log("policies array length:", (sydneyData.policies || []).length)
console.log("individualPolicies length:", (sydneyData.individualPolicies || []).length)
console.log("savedPolicies length:", (sydneyData.savedPolicies || []).length)

// Maybe there's a different path for saved policies
for (const path of [
  `/surecrm/eno/individual/11482453`,
  `/surecrm/eno-policies?producerId=11482453`,
  `/surecrm/eno/policies/11482453`,
  `/surecrm/producers/11482453/eno-policies`,
]) {
  try {
    const r = await fetch(`https://surelc.surancebay.com${path}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    console.log(`\nGET ${path} → HTTP ${r.status}`)
    if (r.ok) {
      const t = await r.text()
      console.log(`  preview: ${t.slice(0, 400)}`)
    }
  } catch (e) {
    console.log(`GET ${path} → ${e.message}`)
  }
}

await browser.close()
