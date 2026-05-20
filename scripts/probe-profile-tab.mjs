import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const PRODUCER_ID = process.argv[2] || "11474830"

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)
const logger = pino({ name: "probe-profile" })

await loginAdmin(
  page,
  { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" },
  logger,
)

await page.goto(`https://surelc.surancebay.com/bga/producers/${PRODUCER_ID}/profile`)
await page.waitForTimeout(4000)

// Dump all mat-form-field labels + their input values
const fields = await page.$$eval("mat-form-field", (els) =>
  els.map((ff) => {
    const label = ff.querySelector("mat-label, label")?.textContent?.trim() || ""
    const input = ff.querySelector("input, textarea, select")
    return {
      label,
      tag: input?.tagName || "?",
      formControlName: input?.getAttribute("formcontrolname") || "",
      value: input?.value || "",
      type: input?.getAttribute("type") || "",
      required: input?.required || false,
      invalid: input?.classList?.contains("ng-invalid") || false,
    }
  }),
)

console.log(JSON.stringify(fields, null, 2))

// Also dump any visible "Resident" text on the page
const residentLines = await page
  .$$eval("body", (els) =>
    (els[0]?.innerText || "")
      .split("\n")
      .filter((l) => /resident/i.test(l))
      .slice(0, 20),
  )
  .catch(() => [])
console.log("\n=== Resident-related lines ===")
console.log(residentLines.join("\n"))

await page.screenshot({ path: `/tmp/profile-${PRODUCER_ID}.png`, fullPage: true })
console.log(`\nScreenshot: /tmp/profile-${PRODUCER_ID}.png`)

await browser.close()
