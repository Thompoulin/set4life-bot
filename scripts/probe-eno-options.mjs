import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, pino())
let bearer = null
const handler = (req) => {
  const a = req.headers()["authorization"]
  if (req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
    const b = a.replace("Bearer ", "")
    if (!bearer && b.split(".").length === 3) { bearer = b; page.off("request", handler) }
  }
}
page.on("request", handler)
// Drive the actual form-save flow on Sydney to capture the write call
const calls = []
page.on("requestfinished", async (req) => {
  const u = req.url()
  if (u.includes("/surecrm/eno") || u.includes("/surecrm/individual")) {
    const r = req.response()
    calls.push({ method: req.method(), url: u.replace("https://surelc.surancebay.com",""), status: r ? (await r.then(x=>x.status())) : "?", postPreview: (req.postData()||"").slice(0,300) })
  }
})
// Also use a passive recorder
const allEnoCalls = []
page.on("request", (req) => {
  const u = req.url()
  if (u.includes("/surecrm/") && (u.includes("eno") || u.includes("policy") || u.includes("policies"))) {
    allEnoCalls.push({ method: req.method(), url: u.replace("https://surelc.surancebay.com",""), postPreview: (req.postData()||"").slice(0,300) })
  }
})

await page.evaluate(() => {
  history.pushState({}, "", `/bga/producers/11482453/eno`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(5000)
console.log("=== Bearer obtained:", !!bearer)

// Try to OPTIONS each endpoint to see allowed methods
for (const path of [
  "/surecrm/eno/producer/11482453",
  "/surecrm/eno/individual",
  "/surecrm/eno/individual/11482453",
  "/surecrm/eno/24993467",
  "/surecrm/eno/individual/24993467",
]) {
  try {
    const r = await fetch(`https://surelc.surancebay.com${path}`, {
      method: "OPTIONS",
      headers: { Authorization: `Bearer ${bearer}` },
    })
    const allow = r.headers.get("allow") || r.headers.get("access-control-allow-methods")
    console.log(`OPTIONS ${path} → ${r.status} | Allow: ${allow}`)
  } catch (e) { console.log(`OPTIONS ${path} → ${e.message}`) }
}

// Try GET on individual paths
for (const path of [
  "/surecrm/eno/individual/11482453",
  "/surecrm/eno/24993467",
  "/surecrm/eno/individual/24993467",
]) {
  const r = await fetch(`https://surelc.surancebay.com${path}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  const t = (await r.text()).slice(0, 300)
  console.log(`GET ${path} → ${r.status}: ${t}`)
}

console.log("\n=== eno-related calls observed during page load ===")
for (const c of allEnoCalls) console.log(`  ${c.method.padEnd(6)} ${c.url}${c.postPreview ? " — post: " + c.postPreview : ""}`)

await browser.close()
