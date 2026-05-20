/**
 * Try DELETE on one unlinked E&O attachment to see if it cleanly removes
 * (and clears the DOCS warning). Target: one of Demetrius's 10 unlinked.
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
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/7533541"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)

const unlinked = await fetch(`https://surelc.surancebay.com/surecrm/attachments/7533541/unlinked-eno`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
console.log(`Demetrius has ${unlinked.length} unlinked E&O documents`)
if (unlinked.length === 0) { await browser.close(); process.exit(0) }

const target = unlinked[unlinked.length - 1]  // oldest one
console.log(`Target: id=${target.id} description=${target.description?.slice(0,80)}`)

// Try DELETE
console.log("\nTrying DELETE /surecrm/attachments/{id}")
const r1 = await fetch(`https://surelc.surancebay.com/surecrm/attachments/${target.id}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${bearer}` },
})
console.log(`  → ${r1.status}: ${(await r1.text()).slice(0, 200)}`)

await browser.close()
