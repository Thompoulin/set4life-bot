/**
 * Delete all unlinked E&O attachments for affected agents.
 * These were created by the bot uploading the cert on every retry
 * without checking if a linked one already exists.
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
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/11482453"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)

const targets = [
  { name: "Demetrius", pid: 7533541 },
  { name: "Keyon", pid: 5331616 },
  { name: "Josue", pid: 11474830 },
]
for (const t of targets) {
  const unlinked = await fetch(`https://surelc.surancebay.com/surecrm/attachments/${t.pid}/unlinked-eno`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => (r.ok ? r.json() : []))
  console.log(`\n=== ${t.name}: ${unlinked.length} unlinked E&O ===`)
  for (const d of unlinked) {
    const r = await fetch(`https://surelc.surancebay.com/surecrm/attachments/${d.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${bearer}` },
    })
    console.log(`  DELETE id=${d.id} → ${r.status}`)
  }
}
await browser.close()
