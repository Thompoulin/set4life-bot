/**
 * Create an E&O policy for a producer via the BGA SPA's authenticated
 * endpoint, bypassing the form's ngx-mask Case Limit lock.
 *
 * Demetrius (7533541) discovered case: BIBERK Recognition pre-filled
 * Case Limit to $5M (wrong) and the form's mat-autocomplete-trigger
 * + ngx-mask combo wouldn't accept programmatic overrides. Direct
 * API write is the only path.
 *
 * Usage:
 *   node eno-create-policy.mjs --execute
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const EXECUTE = process.argv.includes("--execute")
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
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
await page.evaluate(() => {
  history.pushState({}, "", `/bga/producers/7533541/eno`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(4000)
if (!bearer) { console.error("no bearer"); process.exit(1) }

// Get an unlinked attachment ID to use as imagesList
const unlinkedRes = await fetch(
  "https://surelc.surancebay.com/surecrm/attachments/7533541/unlinked-eno",
  { headers: { Authorization: `Bearer ${bearer}` } },
)
const unlinked = await unlinkedRes.json()
const imageId = Array.isArray(unlinked) && unlinked.length
  ? String(unlinked[0].id || unlinked[0].attachmentId || "")
  : ""
console.log(`Using imagesList: ${imageId} (from ${unlinked.length} unlinked)`)

// Build the policy body matching Sydney's working schema (caseLimit/totalLimit
// are numbers, dates are ISO).
const policy = {
  carrier: "Berkshire Hathaway Direct Insurance Company",
  policyNo: "N8PL469675",
  policyNoNorm: "N8PL469675",
  caseLimit: 1000000,
  totalLimit: 1000000,
  deductible: 0,
  startedOn: "2026-05-01T00:00:00.000",
  expiresOn: "2027-05-01T00:00:00.000",
  parentId: 7533541,
  entityType: "producer",
  policyType: "I",
  status: "active",
  imagesList: imageId,
  notAffiliated: "N",
  sureAppProvided: "N",
  parentEnoId: 0,
  bgaId: 0,
  broker: "",
}
console.log("\nPolicy body:\n", JSON.stringify(policy, null, 2))

if (!EXECUTE) {
  console.log("\n(dry-run; pass --execute to actually create)")
  await browser.close()
  process.exit(0)
}

// Try the candidates
for (const c of [
  { method: "POST", path: "/surecrm/eno/individual" },
  { method: "PUT", path: "/surecrm/eno/individual" },
  { method: "POST", path: "/surecrm/eno" },
  { method: "PUT", path: "/surecrm/eno" },
]) {
  try {
    const r = await fetch(`https://surelc.surancebay.com${c.path}`, {
      method: c.method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(policy),
    })
    const txt = (await r.text()).slice(0, 600)
    console.log(`\n${c.method} ${c.path} → HTTP ${r.status}: ${txt}`)
    if (r.ok) { console.log("\n*** SUCCESS — policy created ***"); break }
  } catch (e) {
    console.log(`\n${c.method} ${c.path} → threw ${e.message}`)
  }
}

await browser.close()
