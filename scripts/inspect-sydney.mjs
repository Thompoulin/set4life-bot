/** Full appointment-request list for Sydney to see what changed. */
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
const list = await fetch("https://surelc.surancebay.com/surecrm/appointments-requests?producerId=11482453&gaId=1322", { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
console.log(`Total: ${list.length}`)
for (const a of list) {
  console.log(`  id=${a.appointmentRequestId.toString().padEnd(10)} stage=${(a.stage||"-").padEnd(10)} reviewed=${a.reviewed||"-"} status=${(a.carrierStatus||"-").padEnd(20)} type=${(a.type||"-").padEnd(10)} agentNo=${a.agentNo||"-"} ${a.carrierName}`)
  if (a.comments && a.comments.length > 0) {
    for (const c of a.comments.slice(-3)) console.log(`     [${c.ts?.slice(0,16)}] ${c.authorName}: ${c.comment?.slice(0,100)}`)
  }
}
await browser.close()
