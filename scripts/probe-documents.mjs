/**
 * Probe SureLC's documents API for Demetrius. Find:
 * 1. What "linking" means in the API
 * 2. How to clean up duplicates
 * 3. What the FIX button actually does
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, pino())
let bearer = null
const allRequests = []
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (!bearer && req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
    const b = a.replace("Bearer ", "")
    if (b.split(".").length === 3) bearer = b
  }
  if (req.url().includes("/surecrm/") && (req.url().includes("document") || req.url().includes("attachment") || req.url().includes("eno"))) {
    allRequests.push({ method: req.method(), url: req.url().replace("https://surelc.surancebay.com",""), body: (req.postData() || "").slice(0,200) })
  }
})

// Navigate to Demetrius's Documents tab in BGA admin
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/7533541/documents"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(6000)
console.log("Loaded Documents page, requests so far:", allRequests.length)
for (const r of allRequests.slice(0, 15)) console.log(`  ${r.method} ${r.url}`)

// Try fetching documents API
console.log("\n=== Listing documents ===")
for (const path of [
  "/surecrm/documents/producer/7533541",
  "/surecrm/attachments/producer/7533541",
  "/surecrm/profile-documents/7533541",
  "/surecrm/eno-documents/7533541",
  "/surecrm/attachments/7533541/all",
  "/surecrm/attachments/7533541/eno",
  "/surecrm/attachments/7533541/unlinked",
  "/surecrm/attachments/7533541/unlinked-eno",
]) {
  const r = await fetch(`https://surelc.surancebay.com${path}`, { headers: { Authorization: `Bearer ${bearer}` } })
  if (r.status === 200) {
    const t = await r.text()
    const data = JSON.parse(t)
    const count = Array.isArray(data) ? data.length : Object.keys(data).length
    console.log(`  ${path} → ${r.status} (${count} items)`)
    if (count > 0 && count < 20) console.log(`    sample: ${JSON.stringify(Array.isArray(data) ? data[0] : data).slice(0, 400)}`)
  } else if (r.status !== 404) {
    console.log(`  ${path} → ${r.status}: ${(await r.text()).slice(0, 100)}`)
  }
}

await browser.close()
