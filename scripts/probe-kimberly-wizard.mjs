// Walk Kimberly's American Amicable contracting wizard as the rep.
// Auth: SSN last 6 + DOB pulled from SureLC public API.
// Goal: identify the "skip" Ana mentioned that appears in two places.

import { chromium } from "playwright"
import { writeFile, mkdir } from "node:fs/promises"
import path from "node:path"

const SSN_LAST_6 = "707415"      // last 6 of 065707415
const DOB_SLASH = "09/01/1968"   // MM/DD/YYYY for the auth-date-input
const REVIEW_URL =
  "https://surelc.surancebay.com/sbweb/login.jsp?appointmentId=117567421&sec=1779372126000"

const OUT = `/tmp/kimberly-probe-${Date.now()}`
await mkdir(OUT, { recursive: true })
console.log("output dir:", OUT)

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
})
const page = await ctx.newPage()
page.setDefaultTimeout(45_000)

async function snap(label) {
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(OUT, `${label}.png`), fullPage: true })
  const html = await page.content()
  await writeFile(path.join(OUT, `${label}.html`), html)
  const innerText = await page.$$eval("body", (els) => els[0]?.innerText || "")
  await writeFile(path.join(OUT, `${label}.txt`), innerText)
  // Also dump every mat-radio-group's question text + answer state
  const radios = await page
    .evaluate(() => {
      const groups = Array.from(document.querySelectorAll("mat-radio-group"))
      return groups.map((g) => {
        const buttons = Array.from(g.querySelectorAll("mat-radio-button"))
        const checkedBtn = buttons.find((b) => b.classList.contains("mat-radio-checked") || b.classList.contains("mat-mdc-radio-checked"))
        const checkedValue = checkedBtn?.getAttribute("value")
        const container = g.closest("sb-question, .wrap, mat-form-field, mat-card") || g.parentElement
        const label = (container?.querySelector(".question__text, mat-label, label")?.textContent || "").trim().slice(0, 200)
        return { label, checkedValue: checkedValue || null, options: buttons.map((b) => b.getAttribute("value")) }
      })
    })
    .catch(() => [])
  if (radios.length) {
    await writeFile(path.join(OUT, `${label}.radios.json`), JSON.stringify(radios, null, 2))
  }
  console.log(`saved ${label} (${innerText.length} chars text, ${radios.length} radios)`)
}

console.log("navigating to review URL...")
await page.goto(REVIEW_URL, { waitUntil: "domcontentloaded", timeout: 60_000 })

// Wait for Material to mount
await page.waitForSelector('input[matinput], input.mat-mdc-input-element, mat-form-field input', { timeout: 30_000 }).catch(() => {})
await page.waitForTimeout(3000)
await snap("00-auth-page")

// SSN: bot uses keyboard.type — first visible SSN input
console.log("filling SSN...")
const ssnInput = await page.$('input[type="tel"], auth-ssn-input input, mat-form-field input[type="text"]:not(#mat-input-0)')
if (ssnInput) {
  await ssnInput.click()
  await page.keyboard.type(SSN_LAST_6, { delay: 100 })
} else {
  // Fallback: click first input
  const firstInp = await page.$("input:visible")
  if (firstInp) { await firstInp.click(); await page.keyboard.type(SSN_LAST_6, { delay: 100 }) }
}
await page.waitForTimeout(500)

// DOB
console.log("filling DOB...")
const dobInput = await page.$(
  'auth-date-input input#mat-input-0, auth-date-input input[type="text"]:not([readonly]):not([matnativecontrol])',
)
if (dobInput) {
  await dobInput.fill(DOB_SLASH, { force: true })
} else {
  // Try generic
  const inputs = await page.$$("input:visible")
  if (inputs[1]) { await inputs[1].fill(DOB_SLASH) }
}
await page.waitForTimeout(800)
await snap("01-auth-filled")

// Submit
const loginBtn =
  (await page.$('button:has-text("LOGIN")')) ||
  (await page.$('button:has-text("Login")')) ||
  (await page.$('button[type="submit"]'))
if (loginBtn) {
  await loginBtn.click().catch(() => undefined)
  console.log("clicked LOGIN")
} else {
  await page.keyboard.press("Enter")
}

// Wait for wizard
await page.waitForTimeout(10_000)
await snap("02-post-auth")

// Detect policy-accept screen
const acceptBtn = await page.$('button:has-text("ACCEPT")') || await page.$('button:has-text("I Accept")')
if (acceptBtn) {
  console.log("accepting policy...")
  await acceptBtn.click().catch(() => undefined)
  await page.waitForTimeout(5000)
  await snap("02b-post-policy-accept")
}

// Walk steps
for (let i = 1; i <= 10; i++) {
  await snap(`03-step${i}`)
  console.log(`step ${i} URL: ${page.url()}`)

  // Find Next button (don't click sign/apply)
  const nextBtn = await page.evaluateHandle(() => {
    const buttons = Array.from(document.querySelectorAll("button"))
    return (
      buttons.find((b) => /^\s*next\s*$/i.test(b.textContent || "") && !b.disabled) ||
      buttons.find((b) => /^\s*continue\s*$/i.test(b.textContent || "") && !b.disabled) ||
      null
    )
  })
  const nextEl = nextBtn?.asElement?.()
  if (!nextEl) {
    console.log(`step ${i}: no Next button — likely on Review/Sign step. Stopping.`)
    break
  }
  await nextEl.click().catch(() => undefined)
  await page.waitForTimeout(3000)
}

await browser.close()
console.log("DONE. snapshots at:", OUT)
