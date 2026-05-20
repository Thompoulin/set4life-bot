/**
 * Navigate to Demetrius's producer page directly and look at:
 * - Tab badges (red dots / counts) indicating issues
 * - Profile-completion banner
 * - Any validation/error UI
 * - Network calls to validation endpoints
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, pino())

const apiCalls = []
page.on("request", (req) => {
  const u = req.url()
  if (u.includes("/surecrm/")) {
    apiCalls.push({ method: req.method(), url: u.replace("https://surelc.surancebay.com",""), post: (req.postData()||"").slice(0,150) })
  }
})

// Visit Demetrius producer page
await page.goto("https://surelc.surancebay.com/bga/producers/7533541")
await page.waitForTimeout(6000)

// Tab list with badges
const tabs = await page.$$eval('mat-tab-link, .mat-tab-label, sb-producer-tabs *, [role=tab]', (els) =>
  els.slice(0, 30).map((el) => ({
    text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
    classes: el.className,
    hasError: !!el.querySelector(".mat-badge, .error, .red, .warning, mat-icon[color=warn]"),
  })),
)
console.log(`tabs: ${tabs.length}`)
for (const t of tabs) {
  if (t.text.length > 0) console.log(`  ${t.hasError ? "[!]" : "[ ]"} ${t.text} | ${t.classes.slice(0,80)}`)
}

// Page-level error banners
const banners = await page.$$eval('.alert, .warning, .error, mat-error, [class*=banner], [class*=alert]', (els) =>
  els.map(e => (e.textContent||"").replace(/\s+/g," ").trim()).filter(t => t.length > 5),
)
console.log("\nbanners:", banners.length)
banners.slice(0, 10).forEach(b => console.log(`  ${b.slice(0, 200)}`))

// Look for any "issue" / "error" / "missing" text on the page
const allErrorText = await page.evaluate(() => {
  const matches = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let n
  while ((n = walker.nextNode())) {
    const t = (n.textContent || "").trim()
    if (/issue|missing|invalid|incomplete|expired|required|warning|red/i.test(t) && t.length < 200 && t.length > 5) {
      matches.push(t)
    }
  }
  return matches.slice(0, 20)
})
console.log("\nerror-keyword text matches:", allErrorText.length)
allErrorText.forEach(t => console.log(`  ${t}`))

console.log("\n=== unique API endpoints hit ===")
const uniq = new Set(apiCalls.map(c => c.method + " " + c.url.split("?")[0]))
console.log([...uniq].slice(0, 40).join("\n"))

await browser.close()
