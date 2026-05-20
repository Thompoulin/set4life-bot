/**
 * Audit document linkage state across all active agents.
 * Identifies how many unlinked attachments each has (the FIX-button items).
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

const agents = [
  ["Holton Buggs", 11096584],
  ["Sydney DeSilva", 11482453],
  ["Demetrius Early Jr", 7533541],
  ["Keyon Edwards", 5331616],
  ["Terrence Gray", 11168051],
  ["Zachary Love", 11474885],
  ["Paul Magistri", 11338188],
  ["Deborah Nabors", 11473444],
  ["Josue Trigueros", 11474830],
  ["Brandon Sims", 11474775],
]

console.log("Agent                       | All docs | Unlinked E&O | OK?")
console.log("-".repeat(75))
for (const [name, pid] of agents) {
  const all = await fetch(`https://surelc.surancebay.com/surecrm/attachments/${pid}?withUndefined=true&withUnlinkedBusinessChecks=false`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => (r.ok ? r.json() : []))
  const unlinkedEno = await fetch(`https://surelc.surancebay.com/surecrm/attachments/${pid}/unlinked-eno`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => (r.ok ? r.json() : []))
  const allCount = Array.isArray(all) ? all.length : 0
  const unlinkedCount = Array.isArray(unlinkedEno) ? unlinkedEno.length : 0
  const status = unlinkedCount === 0 ? "OK ✅" : "DOCS issue"
  console.log(`${name.padEnd(28)}| ${String(allCount).padStart(8)} | ${String(unlinkedCount).padStart(12)} | ${status}`)
}
await browser.close()
