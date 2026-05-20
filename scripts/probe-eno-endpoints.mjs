/**
 * Probe BGA SPA for the actual /surecrm/ endpoints used by the E&O
 * tab. Logs into admin, navigates to a producer's E&O page, captures
 * every outbound API request, prints them. Use the output to write
 * the actual DELETE / PATCH calls needed to clear a wrong-Recognition
 * policy.
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const PRODUCER_ID = process.argv[2] || "7533541" // Demetrius

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)
const logger = pino({ name: "probe-eno" })

await loginAdmin(
  page,
  { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" },
  logger,
)

const calls = []
page.on("request", (req) => {
  const u = req.url()
  if (
    u.includes("/surecrm/") ||
    u.includes("/sbweb/") ||
    u.includes("/api/")
  ) {
    calls.push({
      method: req.method(),
      url: u.replace("https://surelc.surancebay.com", ""),
      postPreview: (req.postData() || "").slice(0, 400),
    })
  }
})

// Navigate to producer E&O tab via SPA pushState
await page.evaluate(
  (id) => {
    history.pushState({}, "", `/bga/producers/${id}/eno`)
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
  },
  PRODUCER_ID,
)
await page.waitForTimeout(8000)

console.log("\n=== outbound calls when loading producer E&O tab ===")
for (const c of calls) {
  console.log(
    `  ${c.method.padEnd(6)} ${c.url}${c.postPreview ? " — post: " + c.postPreview : ""}`,
  )
}

await browser.close()
