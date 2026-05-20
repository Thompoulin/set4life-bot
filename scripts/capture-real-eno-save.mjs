/**
 * Capture the REAL E&O save endpoint by:
 * 1. Open Demetrius's broken form (Case Limit pre-filled to wrong $5M)
 * 2. Force Total Limit > Case Limit so SAVE button enables
 * 3. Click SAVE — this WILL save a wrong policy, but we capture the
 *    exact endpoint + body shape SureLC's SPA uses
 * 4. After capture, DELETE the wrong policy via /surecrm/eno/{id}
 * 5. Print the captured request so we can replicate with correct values
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, pino())

let bearer = null
const calls = []
page.on("request", (req) => {
  const u = req.url()
  if (!u.includes("/surecrm/")) return
  const a = req.headers()["authorization"]
  if (!bearer && a?.startsWith("Bearer ")) {
    const b = a.replace("Bearer ", "")
    if (b.split(".").length === 3) bearer = b
  }
  // Only capture POST/PUT/PATCH/DELETE eno-related
  if ((u.includes("eno") || u.includes("policy")) && req.method() !== "GET") {
    calls.push({ method: req.method(), url: u.replace("https://surelc.surancebay.com",""), body: req.postData() || "", headers: req.headers() })
  }
})

await page.evaluate(() => {
  history.pushState({}, "", `/bga/producers/7533541/eno`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(5000)
console.log("loaded Demetrius E&O page; bearer:", !!bearer)

// Force Total Limit bigger than Case Limit so SAVE enables.
// Total Limit ngx-mask DID accept fillForce earlier. Use direct DOM
// dispatch: triple-click + Backspace + type.
async function forceFillByLabel(labelText, value) {
  await page.evaluate(({ lbl, v }) => {
    const labels = Array.from(document.querySelectorAll("mat-label"))
    const m = labels.find(l => (l.textContent||"").trim().toLowerCase().replace(/\*$/,"").trim() === lbl.toLowerCase())
    if (!m) return false
    const ff = m.closest("mat-form-field")
    const inp = ff?.querySelector("input")
    if (!inp) return false
    const proto = Object.getPrototypeOf(inp)
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(inp, v)
    inp.dispatchEvent(new Event("input", { bubbles: true }))
    inp.dispatchEvent(new Event("change", { bubbles: true }))
    return true
  }, { lbl: labelText, v: value })
}

// Set Total Limit to 6,000,000 so it's > the auto-filled $5M Case Limit
await forceFillByLabel("Total Limit", "6000000")
await page.waitForTimeout(800)

// Click SAVE & EXIT (force, ignore disabled state)
const saveBtn = await page.$('button:has-text("SAVE & EXIT"), button:has-text("Save & Exit")')
console.log("SAVE button found:", !!saveBtn)
if (saveBtn) {
  console.log("clicking SAVE & EXIT")
  await saveBtn.click({ force: true }).catch((e) => console.log("click err:", e.message))
  await page.waitForTimeout(6000)
}

console.log("\n=== captured write calls ===")
for (const c of calls) {
  console.log(`\n${c.method} ${c.url}`)
  console.log(`  ct: ${c.headers["content-type"] || "(none)"}`)
  console.log(`  body[:600]: ${c.body.slice(0, 600)}`)
}

await browser.close()
