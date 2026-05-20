/**
 * Delete a producer's E&O policy via the BGA SPA's authenticated
 * /surecrm/eno endpoint. Captures a Bearer JWT via Playwright
 * (admin login → BGA SPA navigate → first /surecrm/* request's
 * Authorization header).
 *
 * Usage:
 *   node scripts/delete-eno-policy.mjs <producerId>
 *
 * GETs /surecrm/eno/producer/{producerId} first to see policies,
 * then DELETEs each one (or just the first if only one exists).
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const PRODUCER_ID = process.argv[2]
if (!PRODUCER_ID) {
  console.error("usage: delete-eno-policy.mjs <producerId>")
  process.exit(1)
}

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)
const logger = pino({ name: "del-eno" })

await loginAdmin(
  page,
  { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" },
  logger,
)

// Capture Bearer JWT from the first /surecrm/ request
let bearer = null
const handler = (req) => {
  const a = req.headers()["authorization"]
  if (req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
    bearer = a.replace("Bearer ", "")
    page.off("request", handler)
  }
}
page.on("request", handler)
await page.evaluate((id) => {
  history.pushState({}, "", `/bga/producers/${id}/eno`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
}, PRODUCER_ID)
await page.waitForTimeout(4000)

if (!bearer) {
  console.error("FAIL: no Bearer captured")
  await browser.close()
  process.exit(1)
}
console.log("Bearer captured (len=" + bearer.length + ")")

// GET existing policies
const getRes = await fetch(
  `https://surelc.surancebay.com/surecrm/eno/producer/${PRODUCER_ID}`,
  { headers: { Authorization: `Bearer ${bearer}` } },
)
const policies = await getRes.json()
console.log("\n=== current E&O policies ===")
console.log(JSON.stringify(policies, null, 2))

// Look for policies array (response shape varies)
let policyList = []
if (Array.isArray(policies)) policyList = policies
else if (policies?.policies) policyList = policies.policies
else if (policies?.individualPolicies) policyList = policies.individualPolicies
else if (policies?.id) policyList = [policies]

console.log(`\n=== ${policyList.length} policies found ===`)

for (const p of policyList) {
  const id = p.id || p.policyId || p.policyNumber
  console.log(`Policy id=${id} caseLimit=${p.caseLimit} totalLimit=${p.totalLimit}`)
  if (process.argv[3] === "--delete" && id) {
    console.log(`Sending DELETE /surecrm/eno/${id}`)
    const delRes = await fetch(
      `https://surelc.surancebay.com/surecrm/eno/${id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bearer}` },
      },
    )
    console.log(`  → HTTP ${delRes.status}: ${await delRes.text()}`)
  }
}

await browser.close()
