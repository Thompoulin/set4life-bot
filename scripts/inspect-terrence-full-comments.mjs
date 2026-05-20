/** Print ALL comments on Terrence's recently-discarded (post-sign) appointments. */
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
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/11168051"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)

// IDs of just-signed-then-discarded appointments
const ids = [116984575, 116984564, 116984498, 116984509, 116984520, 116984531]
for (const id of ids) {
  console.log(`\n── id=${id} ──`)
  const r = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${id}`, { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json())
  console.log(`  carrier=${r.carrierName} stage=${r.stage} reviewed=${r.reviewed} carrierStatus=${r.carrierStatus} type=${r.type}`)
  console.log(`  stageChangeDate=${r.stageChangeDate} paperworkDate=${r.paperworkDate}`)
  if (Array.isArray(r.comments)) {
    console.log(`  ${r.comments.length} comments:`)
    for (const c of r.comments) {
      console.log(`    [${c.ts?.slice(0,16)}] ${c.authorName}: ${c.comment?.slice(0,150)}`)
    }
  }
}
await browser.close()
