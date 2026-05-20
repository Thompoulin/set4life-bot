/**
 * Drive the Foresters review wizard for Keyon as the rep, capture
 * the EXACT red-notice content on /wizard/welcome. Auth uses last 6
 * of SSN + DOB.
 */
import { chromium } from "playwright"
import { readFileSync } from "node:fs"
import https from "node:https"

const ACTIVATION_URL = "https://surelc.surancebay.com/sbweb/login.jsp?appointmentId=116935372&sec=1778331955817"

// Get Keyon's SSN/DOB from production DB (we'll fetch via the existing
// activation pipeline secret).  Actually we need the rep's last 6 SSN
// + DOB which are stored in applications.governmentIdentifier (encrypted)
// + applications.birthDate. For this probe we'll let the user enter
// them via env if needed, or just observe what auth fields exist.

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)

console.log("Loading activation URL...")
await page.goto(ACTIVATION_URL, { waitUntil: "networkidle" })
console.log("Final URL:", page.url())
await page.waitForTimeout(3000)

// Look at what's on screen
const initial = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  body: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 800),
  inputs: Array.from(document.querySelectorAll("input")).slice(0, 8).map(i => ({
    type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, ariaLabel: i.getAttribute("aria-label"),
  })),
}))
console.log("\n=== Initial page ===")
console.log("URL:", initial.url)
console.log("Title:", initial.title)
console.log("Body[:500]:", initial.body.slice(0, 500))
console.log("Inputs:", JSON.stringify(initial.inputs, null, 2))

// If on auth page, fill it (we'd need real SSN+DOB; for now just observe)
const ssn = process.env.KEYON_SSN_LAST6 || ""
const dob = process.env.KEYON_DOB || ""

if (ssn && dob && initial.inputs.length >= 2) {
  console.log("\n=== Filling auth ===")
  const inputs = await page.$$('input:visible')
  if (inputs.length >= 2) {
    await inputs[0].fill(ssn)
    await inputs[1].fill(dob)
    const submit = await page.$('button:has-text("Sign In"), button:has-text("Continue"), button[type=submit]')
    if (submit) {
      await submit.click()
      await page.waitForTimeout(5000)
      console.log("After auth URL:", page.url())
    }
  }

  // Now we should be on the wizard
  await page.waitForTimeout(3000)
  const wizardState = await page.evaluate(() => {
    const allClasses = Array.from(document.querySelectorAll("[class]"))
      .map(e => e.className)
      .filter(c => typeof c === "string")
      .join(" ")
    // Find anything that looks like a red notice
    const reds = []
    const candidates = document.querySelectorAll("*")
    const seen = new Set()
    for (const el of candidates) {
      const cls = String(el.className || "")
      const txt = (el.innerText || "").replace(/\s+/g, " ").trim()
      if (!txt || txt.length > 300 || seen.has(txt)) continue
      const isRed = /red|warn|danger|required|notice|error|alert/i.test(cls)
      const hasRedColor = window.getComputedStyle(el).color.includes("rgb(220") ||
                          window.getComputedStyle(el).color.includes("rgb(200")
      if (isRed || hasRedColor) {
        // Filter out trivial parents that contain too much
        if (txt.length > 5 && txt.length < 150) {
          seen.add(txt)
          reds.push({ cls: cls.slice(0, 80), txt })
          if (reds.length >= 20) break
        }
      }
    }
    return {
      url: location.href,
      title: document.title,
      bodyExcerpt: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 1500),
      reds,
    }
  })
  console.log("\n=== Wizard state ===")
  console.log("URL:", wizardState.url)
  console.log("Title:", wizardState.title)
  console.log("\n--- BODY EXCERPT ---")
  console.log(wizardState.bodyExcerpt)
  console.log("\n--- RED NOTICES ---")
  for (const r of wizardState.reds) {
    console.log(`  [${r.cls}] → ${r.txt}`)
  }
}

await page.screenshot({ path: "/tmp/foresters-wizard.png", fullPage: true })
console.log("\nScreenshot saved to /tmp/foresters-wizard.png")
await browser.close()
