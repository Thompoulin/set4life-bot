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
await page.evaluate(() => { history.pushState({}, "", "/bga/producers/11474830"); window.dispatchEvent(new PopStateEvent("popstate", { state: {} })) })
await page.waitForTimeout(4000)

for (const [name, pid] of [["Sydney signed", 11482453], ["Josue stuck", 11474830], ["Keyon signed", 5331616]]) {
  console.log(`\n=== ${name} (${pid}) E&O policies ===`)
  for (const path of [
    `/surecrm/eno?producerId=${pid}&entityType=producer`,
    `/surecrm/eno/list/${pid}`,
    `/surecrm/eno/producer/${pid}`,
  ]) {
    const r = await fetch(`https://surelc.surancebay.com${path}`, { headers: { Authorization: `Bearer ${bearer}` } })
    if (r.ok) {
      const t = await r.text()
      const data = JSON.parse(t)
      console.log(`  ${path} → ${r.status}: ${t.slice(0, 800)}`)
      break
    }
  }
}
await browser.close()
