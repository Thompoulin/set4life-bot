/**
 * Test PUT /surecrm/eno/{id} by re-posting Sydney's policy AS-IS
 * (no-op self-update). If it returns 200 we know the write endpoint
 * pattern; if it 4xx's we'll see the validation error.
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
    if (!bearer && b.split(".").length === 3) { bearer = b; page.off("request", handler) }
  }
}
page.on("request", handler)
await page.evaluate(() => { history.pushState({}, "", `/bga/producers/11482453/eno`); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)

// Read Sydney's policy
const r = await fetch(`https://surelc.surancebay.com/surecrm/eno/24993467`, { headers: { Authorization: `Bearer ${bearer}` } })
const policy = await r.json()
console.log("=== Sydney's policy ===")
console.log(JSON.stringify(policy, null, 2))

// Try PUT /surecrm/eno/24993467 with same body (no-op update)
const putR = await fetch(`https://surelc.surancebay.com/surecrm/eno/24993467`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  body: JSON.stringify(policy),
})
console.log(`\nPUT /surecrm/eno/24993467 → HTTP ${putR.status}: ${(await putR.text()).slice(0, 500)}`)

// Try POST /surecrm/eno (without ID) with the same body
const postR = await fetch(`https://surelc.surancebay.com/surecrm/eno`, {
  method: "POST",
  headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  body: JSON.stringify(policy),
})
console.log(`POST /surecrm/eno → HTTP ${postR.status}: ${(await postR.text()).slice(0, 500)}`)

// Try POST /surecrm/eno/individual with the body
const postIndR = await fetch(`https://surelc.surancebay.com/surecrm/eno/individual`, {
  method: "POST",
  headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  body: JSON.stringify(policy),
})
console.log(`POST /surecrm/eno/individual → HTTP ${postIndR.status}: ${(await postIndR.text()).slice(0, 500)}`)

await browser.close()
