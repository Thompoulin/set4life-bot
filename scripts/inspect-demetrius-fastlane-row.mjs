/**
 * Open Fastlane wizard, find Demetrius's producer card, dump the issues.
 * Uses correct bga-producer-card / viewport__item selectors.
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
page.setDefaultTimeout(45_000)
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, pino())

// Navigate via Fastlane wizard URL
await page.evaluate(() => {
  history.pushState({}, "", `/bga/fastlane`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(5000)

// Click the "One Producer Many Carriers" tile
const tile = await page.$('text=/One Producer.*Multiple Carriers/i') || await page.$('[class*="tile"]:has-text("ONE PRODUCER")')
if (tile) {
  console.log("clicking ONE PRODUCER MANY CARRIERS tile")
  await tile.click().catch(()=>{})
  await page.waitForTimeout(2500)
}

// Dismiss any leftover exit-warning
const noBtn = await page.$('mat-dialog-container:has-text("exit before submitting") button:has-text("NO")')
if (noBtn) await noBtn.click().catch(()=>{})

console.log("URL after tile click:", page.url())

// Search for Demetrius's last name
const search = await page.$('input[matInput]:visible, input[placeholder*="search" i]')
if (search) {
  await search.click().catch(()=>{})
  await search.fill("EARLY").catch(()=>{})
  await page.waitForTimeout(2500)
}

// Look at viewport items
const cards = await page.$$('bga-producer-card, .viewport__item')
console.log(`producer cards: ${cards.length}`)

// Find the Demetrius one
let demCard = null
for (const c of cards) {
  const txt = (await c.evaluate((n) => n.textContent || "")).replace(/\s+/g, " ").trim()
  if (/DEMETRIUS|EARLY/i.test(txt)) {
    demCard = c
    console.log("FOUND DEMETRIUS CARD")
    console.log("  text excerpt:", txt.slice(0, 200))
    console.log("  has SELECT:", !!(await c.$('button:has-text("SELECT")')))
    console.log("  full HTML excerpt:")
    console.log("  " + (await c.evaluate(n => n.outerHTML.slice(0, 1500))))
    break
  }
}

if (!demCard) {
  console.log("\n=== ALL CARD EXCERPTS ===")
  for (const c of cards.slice(0, 5)) {
    console.log("  -", (await c.evaluate((n) => (n.textContent||"").replace(/\s+/g," ").trim())).slice(0, 200))
  }
  await browser.close(); process.exit(0)
}

// Try clicking issue popover with all techniques
const popover = await demCard.$('sb-popover.errors, sb-popover.issues, sb-popover')
console.log("\nsb-popover found:", !!popover)
if (popover) {
  console.log("popover html:", await popover.evaluate(n => n.outerHTML.slice(0,400)))
  await popover.click({ force: true }).catch(e => console.log("click err:", e.message))
  await page.waitForTimeout(1000)
  let overlay = await page.$$eval(".cdk-overlay-pane", els => els.map(e => (e.textContent||"").replace(/\s+/g," ").trim()).filter(t => t))
  console.log("post-click overlay panes:", overlay.length, overlay.slice(0,3))
}

// Hover the entire card to surface tooltip
await demCard.hover()
await page.waitForTimeout(800)
let h = await page.$$eval(".cdk-overlay-pane, .mat-tooltip, .mat-mdc-tooltip, mat-menu, [role=menu]", els => els.map(e => (e.textContent||"").replace(/\s+/g," ").trim()).filter(t => t.length > 5))
console.log("post-hover-card overlays:", h.length, h.slice(0,3))

// Try clicking each child element to find one that opens the tooltip
const allChildren = await demCard.$$('*')
console.log(`\ntrying click on ${allChildren.length} child elements...`)
let clicksFound = 0
for (let i = 0; i < Math.min(allChildren.length, 50); i++) {
  await allChildren[i].click({ force: true, timeout: 1000 }).catch(()=>{})
  await page.waitForTimeout(300)
  const overlay = await page.$$eval(".cdk-overlay-pane, mat-menu", els => els.map(e => (e.textContent||"").replace(/\s+/g," ").trim()).filter(t => t.length > 10))
  if (overlay.length > 0) {
    const tag = await allChildren[i].evaluate((n) => `${n.tagName}.${n.className}`).catch(()=>"")
    console.log(`  click child[${i}] (${tag}) → overlay: ${overlay.join(" | ").slice(0,300)}`)
    clicksFound++
    if (clicksFound > 3) break
    // Dismiss the overlay
    await page.keyboard.press("Escape").catch(()=>{})
    await page.waitForTimeout(300)
  }
}

// Final attempt: render full card HTML for inspection
console.log("\n=== FULL CARD HTML ===")
console.log(await demCard.evaluate(n => n.outerHTML))

await browser.close()
