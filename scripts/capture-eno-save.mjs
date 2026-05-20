/**
 * Drive the actual SAVE & EXIT click on a working producer's E&O form
 * and capture the exact network request. We use Sydney 11482453 who
 * already has a saved policy — we'll OPEN her policy via the EDIT
 * button (which loads the form populated), make a tiny no-op change,
 * and click SAVE. The capture tells us the real write endpoint.
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, pino())

// Listen for ALL network activity related to E&O
const calls = []
page.on("request", (req) => {
  const u = req.url()
  if (u.includes("/surecrm/") && (u.includes("eno") || u.includes("policy") || u.includes("policies"))) {
    const post = req.postData() || ""
    calls.push({ method: req.method(), url: u.replace("https://surelc.surancebay.com",""), postLen: post.length, postPreview: post.slice(0, 800), headers: { ct: req.headers()["content-type"] || "" } })
  }
})
page.on("requestfinished", async (req) => {
  const u = req.url()
  if (u.includes("/surecrm/") && (u.includes("eno") || u.includes("policy"))) {
    const r = await req.response()
    if (r) {
      const last = calls.find(c => c.url === u.replace("https://surelc.surancebay.com",""))
      if (last) last.status = r.status()
    }
  }
})

await page.evaluate(() => {
  history.pushState({}, "", `/bga/producers/11482453/eno`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(4000)
console.log("=== loaded Sydney E&O ===")
console.log("calls so far:", calls.length)

// Find the EDIT pencil for Sydney's existing policy
const editBtn = await page.$('button[mattooltip*="Edit"], button:has(mat-icon:has-text("edit")), button.actions__button, sb-document-card button')
if (editBtn) {
  console.log("found edit-like button, clicking")
  await editBtn.click().catch(()=>{})
  await page.waitForTimeout(2000)
}

// Force-fill anything we can find to dirty the form
await page.evaluate(() => {
  document.querySelectorAll('input[matInput]').forEach((inp) => {
    inp.dispatchEvent(new Event("focus", {bubbles:true}))
  })
})
await page.waitForTimeout(800)

// Click SAVE & EXIT (force, ignore disabled)
const saveBtn = await page.$('button:has-text("SAVE & EXIT"), button:has-text("Save & Exit")')
if (saveBtn) {
  console.log("clicking SAVE & EXIT (force=true)")
  await saveBtn.click({ force: true }).catch((e)=>console.log("save click err:", e.message))
  await page.waitForTimeout(3000)
} else {
  console.log("no SAVE button found")
}

console.log("\n=== ALL eno-related network calls captured ===")
for (const c of calls) {
  console.log(`  ${c.method.padEnd(6)} ${c.url}${c.status ? ` → ${c.status}` : ""}${c.postLen ? ` (postLen=${c.postLen})` : ""}`)
  if (c.postPreview && c.postLen > 0) console.log(`    body[:200]: ${c.postPreview.slice(0, 200)}`)
}
await browser.close()
