/**
 * Find the BGA SPA's WRITE endpoint for E&O policies. Tries POST/PUT
 * on common paths with a stub policy body. We're testing on Demetrius
 * (7533541) who has no policies yet — successful writes here would
 * unblock him without bypassing the form's ngx-mask Case Limit.
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
  history.pushState({}, "", `/bga/producers/7533541/eno`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(4000)
if (!bearer) { console.error("no bearer"); process.exit(1) }

// First, fetch Demetrius's unlinked attachments to find an image ID
console.log("=== unlinked-eno attachments for Demetrius ===")
const unlinkedRes = await fetch(
  "https://surelc.surancebay.com/surecrm/attachments/7533541/unlinked-eno",
  { headers: { Authorization: `Bearer ${bearer}` } },
)
const unlinked = await unlinkedRes.json()
console.log("count:", Array.isArray(unlinked) ? unlinked.length : "non-array")
if (Array.isArray(unlinked) && unlinked[0]) {
  console.log("sample:", JSON.stringify(unlinked[0], null, 2).slice(0, 600))
}

// Construct a Demetrius E&O policy from the BIBERK cert data
const stubPolicy = {
  carrier: "Berkshire Hathaway Direct Insurance Company",
  policyNo: "N8PL469675",
  caseLimit: 1000000,
  totalLimit: 1000000,
  deductible: 0,
  startedOn: "2026-05-01T00:00:00.000",
  expiresOn: "2027-05-01T00:00:00.000",
  parentId: 7533541,
  entityType: "producer",
  policyType: "I",
  status: "active",
  imagesList: Array.isArray(unlinked) && unlinked[0]
    ? String(unlinked[0].id || unlinked[0].attachmentId || "")
    : "",
  policyNoNorm: "N8PL469675",
  notAffiliated: "N",
  sureAppProvided: "N",
  parentEnoId: 0,
  bgaId: 0,
  broker: "",
}

console.log("\nstub policy to write:")
console.log(JSON.stringify(stubPolicy, null, 2))

// Try several write endpoints
const candidates = [
  { method: "POST", path: "/surecrm/eno/producer/7533541" },
  { method: "POST", path: "/surecrm/eno" },
  { method: "POST", path: "/surecrm/eno/individual" },
  { method: "POST", path: "/surecrm/eno-policies" },
  { method: "POST", path: "/surecrm/producers/7533541/eno-policies" },
  { method: "PUT",  path: "/surecrm/eno/producer/7533541" },
  { method: "PUT",  path: "/surecrm/eno" },
]
for (const c of candidates) {
  try {
    const r = await fetch(`https://surelc.surancebay.com${c.path}`, {
      method: c.method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(stubPolicy),
    })
    const txt = (await r.text()).slice(0, 300)
    console.log(`\n${c.method} ${c.path} → HTTP ${r.status}: ${txt}`)
  } catch (e) {
    console.log(`\n${c.method} ${c.path} → threw ${e.message}`)
  }
}

await browser.close()
