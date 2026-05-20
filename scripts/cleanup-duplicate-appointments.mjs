/**
 * Clean up duplicate appointment-requests for a producer. Multiple
 * Phase A re-fires of Fastlane create duplicate request rows for the
 * same carrier; this finds them, keeps the most-advanced one
 * (Carrier > BGA > Producer), and DELETEs the rest via the BGA SPA's
 * Bearer-authenticated /surecrm endpoint.
 *
 * Usage:
 *   node scripts/cleanup-duplicate-appointments.mjs <producerId>            # dry-run
 *   node scripts/cleanup-duplicate-appointments.mjs <producerId> --execute  # actually delete
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const PRODUCER_ID = process.argv[2]
const EXECUTE = process.argv.includes("--execute")
if (!PRODUCER_ID) {
  console.error("usage: cleanup-duplicate-appointments.mjs <producerId> [--execute]")
  process.exit(1)
}

const STAGE_RANK = { Carrier: 3, BGA: 2, Producer: 1 }

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)
const logger = pino({ name: "cleanup-appts" })

await loginAdmin(
  page,
  { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" },
  logger,
)

// Capture Bearer JWT (must be a valid 3-segment header.payload.signature)
let bearer = null
const handler = (req) => {
  const a = req.headers()["authorization"]
  if (req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
    const b = a.replace("Bearer ", "")
    if (!bearer && b.split(".").length === 3) {
      bearer = b
      page.off("request", handler)
    }
  }
}
page.on("request", handler)
await page.evaluate((id) => {
  history.pushState({}, "", `/bga/producers/${id}/appointments`)
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
}, PRODUCER_ID)
await page.waitForTimeout(4000)

if (!bearer) {
  console.error("FAIL: no Bearer captured")
  await browser.close()
  process.exit(1)
}

// Fetch all appointment-requests
const url = `https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${PRODUCER_ID}&gaId=1322`
const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } })
const data = await res.json()
const rows = Array.isArray(data) ? data : data.content || []
console.log(`\nFetched ${rows.length} appointment-requests for producer ${PRODUCER_ID}`)

// Skip already-discarded; group remaining by carrier name
const byCarrier = new Map()
for (const r of rows) {
  if (r.stage === "Discarded") continue
  const name = r.carrierName || r.carrier?.name || "?"
  if (!byCarrier.has(name)) byCarrier.set(name, [])
  byCarrier.get(name).push(r)
}

let deletedCount = 0
let keptCount = 0
for (const [carrier, items] of byCarrier.entries()) {
  if (items.length === 1) {
    keptCount++
    continue
  }
  // Sort by stage rank desc, then by id desc (newest first)
  items.sort((a, b) => {
    const ra = STAGE_RANK[a.stage] || 0
    const rb = STAGE_RANK[b.stage] || 0
    if (ra !== rb) return rb - ra
    return (b.id || 0) - (a.id || 0)
  })
  const keeper = items[0]
  const dupes = items.slice(1)
  console.log(
    `\n${carrier}: keeping id=${keeper.appointmentRequestId} stage=${keeper.stage}; deleting ${dupes.length} dup(s)`,
  )
  keptCount++
  for (const d of dupes) {
    console.log(`  candidate DELETE id=${d.appointmentRequestId} stage=${d.stage}`)
    if (EXECUTE) {
      const delUrl = `https://surelc.surancebay.com/surecrm/appointments-requests/${d.appointmentRequestId}`
      const dr = await fetch(delUrl, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bearer}` },
      })
      console.log(`    → HTTP ${dr.status}: ${(await dr.text()).slice(0, 200)}`)
      if (dr.ok) deletedCount++
    }
  }
}

console.log(`\n=== summary ===`)
console.log(`total rows: ${rows.length}`)
console.log(`unique carriers: ${byCarrier.size}`)
console.log(`kept: ${keptCount}`)
console.log(`would-delete: ${rows.length - keptCount}`)
if (EXECUTE) console.log(`actually deleted: ${deletedCount}`)
else console.log(`(dry-run; pass --execute to actually delete)`)

await browser.close()
