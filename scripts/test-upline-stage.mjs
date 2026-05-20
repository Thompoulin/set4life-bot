#!/usr/bin/env node
/**
 * Test if UPLINE-stage appointments can be moved to Carrier via the
 * same /surecrm/appointments-requests/{id}/stage endpoint as BGA.
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const PORTAL_USER = "admin+bot@set4lifeagency.com"
const PORTAL_PASS = "pvG7Dkp5eiyf8LT!"
const PRODUCER_ID = "11338188"
const TARGET_ID = 116869504  // Paul's Transamerica at UPLINE

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)
const logger = pino({ name: "upline-test" })

await loginAdmin(page, { email: PORTAL_USER, password: PORTAL_PASS }, logger)

let bearer = ""
const handler = (req) => {
  const auth = req.headers()["authorization"]
  if (req.url().includes("/surecrm/") && auth?.startsWith("Bearer ")) {
    bearer = auth.replace("Bearer ", "")
    page.off("request", handler)
  }
}
page.on("request", handler)
await page.evaluate((id) => {
  history.pushState({}, "", `/bga/producers/${id}/profile`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
}, PRODUCER_ID)
await page.waitForTimeout(3000)
console.log("Bearer captured:", bearer.length, "chars")

// Try variations:
const tests = [
  { stage: "Carrier", comment: "Bot — UPLINE direct to Carrier" },
  // If "Carrier" rejects, fall back to BGA first (caller would then re-fire bulk)
]

for (const t of tests) {
  console.log(`\nAttempt: stage=${t.stage}`)
  const res = await fetch(
    `https://surelc.surancebay.com/surecrm/appointments-requests/${TARGET_ID}/stage`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ ...t, isPrivate: false }),
    },
  )
  const body = (await res.text().catch(() => "")).slice(0, 500)
  console.log(`  status=${res.status} body=${body}`)
  if (res.ok) break
}

// Verify final state
const v = await fetch(
  `https://surelc.surancebay.com/api/v2/producers/${PRODUCER_ID}/appointment-requests`,
  { headers: { "x-api-key": "ftukJYXDYvajJnkYaL0eF/XKCx9Y+TuAp4cvOOHOnBIS5C7O" } },
)
const list = await v.json()
const target = list.find((r) => r.id === TARGET_ID)
console.log(`\nFinal stage of ${TARGET_ID}: ${target?.stage}`)

await browser.close()
