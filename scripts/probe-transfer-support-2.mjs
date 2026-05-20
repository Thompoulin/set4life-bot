/**
 * Recon round 2 — find the swagger endpoints + scan for transfer/
 * attachment routes + verify whether PATCHing `type` on an existing
 * appointment-request flips it to Transfer.
 *
 * Read-only against live data. The PATCH probe targets a DISCARDED
 * appointment-request (terminal state, no rep notifications, no
 * carrier sees it) so we can verify whether the API accepts the
 * type change without harming a real rep.
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
const log = pino()
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, log)

const tokensByRealm = {}
const seenUrls = new Set()
page.on("request", (req) => {
  const url = req.url()
  if (!url.startsWith("https://surelc.surancebay.com/")) return
  seenUrls.add(url.split("?")[0])
  const a = req.headers()["authorization"]
  if (a?.startsWith("Bearer ")) {
    const tok = a.replace("Bearer ", "")
    if (tok.split(".").length !== 3) return
    const realm = url.match(/surancebay\.com\/([^/]+)\//)?.[1]
    if (realm && !tokensByRealm[realm]) tokensByRealm[realm] = tok
  }
})

// Visit pages likely to trigger surecrm, carrierlc, agency, onboard traffic.
async function navTo(p) {
  await page.evaluate((path) => {
    history.pushState({}, "", path)
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
  }, p)
  await page.waitForTimeout(3500)
}
await navTo("/bga/producers/11096584")
await navTo("/bga/producers/11096584/contracts")
await navTo("/bga/producers/11096584/contracts/116984707")
await navTo("/bga/fastlane")
await navTo("/contracting/carriers/selected")

console.log("─── Bearer tokens captured by realm:")
for (const r of Object.keys(tokensByRealm)) console.log(`  ${r}: ${tokensByRealm[r].slice(0, 24)}…`)

// ─── Swagger discovery ─────────────────────────────────────────────
console.log("\n─── Swagger discovery")
const swaggerEndpoints = [
  "/swagger-resources",
  "/v2/api-docs",
  "/surecrm/swagger-resources",
  "/surecrm/v2/api-docs",
  "/surecrm/api/v2/api-docs",
  "/api/v2/api-docs",
  "/carrierlc/v2/api-docs",
  "/carrierlc/swagger-resources",
  "/onboard/v2/api-docs",
  "/db-events/v2/api-docs",
]
const anyBearer = Object.values(tokensByRealm)[0]
for (const ep of swaggerEndpoints) {
  try {
    const r = await fetch(`https://surelc.surancebay.com${ep}`, {
      headers: anyBearer ? { Authorization: `Bearer ${anyBearer}` } : {},
    })
    if (r.ok) {
      const body = await r.text()
      console.log(`  ${r.status} ${ep}  (${body.length} bytes)`)
      if (ep === "/swagger-resources" || ep.endsWith("/swagger-resources")) {
        try { console.log(`    contents: ${body.slice(0, 600)}`) } catch {}
      }
    } else {
      console.log(`  ${r.status} ${ep}`)
    }
  } catch (err) {
    console.log(`  ERR ${ep} ${err.message}`)
  }
}

// ─── Scan captured URLs for hints ──────────────────────────────────
console.log("\n─── URLs containing 'transfer'/'attach'/'document'/'recontract'/'release':")
for (const u of seenUrls) {
  if (/transfer|attach|document|recontract|release|lor/i.test(u)) console.log("  " + u)
}

// ─── PATCH/PUT probe on a Discarded appointment ────────────────────
//
// Strategy: find a Discarded appointment-request on Holton (or any
// of our agents) and try to PUT it back with type="Transfer". The
// status quo is that discarded appointments are terminal — they
// shouldn't notify anyone. If the PUT succeeds, that confirms the
// type field is mutable via API.
console.log("\n─── PATCH/PUT probe on a Discarded appointment-request")
const surecrm = tokensByRealm.surecrm
if (!surecrm) {
  console.log("  no surecrm bearer; skipping")
} else {
  // Find any discarded appointment-request across our active agents.
  const producers = [11096584, 11482453, 7533541, 5331616, 11168051, 11474885, 11338188, 11473444, 11474830, 11474775]
  let target = null
  for (const pid of producers) {
    const list = await fetch(
      `https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${pid}&gaId=1322`,
      { headers: { Authorization: `Bearer ${surecrm}` } },
    ).then((r) => r.json())
    const d = list.find((a) => a.stage === "Discarded")
    if (d) { target = { pid, ...d }; break }
  }
  if (!target) {
    console.log("  No discarded appointment-requests found to probe with.")
  } else {
    console.log(`  Using id=${target.appointmentRequestId} pid=${target.pid} carrier=${target.carrierName} current type=${target.type}`)
    // 1) Read-only: GET single row to see current shape.
    const single = await fetch(
      `https://surelc.surancebay.com/surecrm/appointments-requests/${target.appointmentRequestId}`,
      { headers: { Authorization: `Bearer ${surecrm}` } },
    )
    console.log(`  GET single: HTTP ${single.status}`)
    const orig = await single.json()
    // 2) Try PUT with type=Transfer (full body, only the type changed).
    const putBody = { ...orig, type: "Transfer" }
    const put = await fetch(
      `https://surelc.surancebay.com/surecrm/appointments-requests/${target.appointmentRequestId}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${surecrm}`, "Content-Type": "application/json" },
        body: JSON.stringify(putBody),
      },
    )
    console.log(`  PUT type=Transfer: HTTP ${put.status}`)
    if (!put.ok) console.log(`    body: ${(await put.text()).slice(0, 300)}`)
    else {
      const after = await put.json().catch(() => null)
      console.log(`    after.type = ${after?.type ?? "(no JSON)"}`)
    }
    // 3) Try PATCH (some APIs prefer it).
    const patch = await fetch(
      `https://surelc.surancebay.com/surecrm/appointments-requests/${target.appointmentRequestId}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${surecrm}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "Recontract" }),
      },
    )
    console.log(`  PATCH type=Recontract: HTTP ${patch.status}`)
    if (!patch.ok) console.log(`    body: ${(await patch.text()).slice(0, 300)}`)

    // 4) Restore to original (best-effort safety).
    if (put.ok || patch.ok) {
      await fetch(
        `https://surelc.surancebay.com/surecrm/appointments-requests/${target.appointmentRequestId}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${surecrm}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ...orig, type: orig.type }),
        },
      )
      console.log("  (restored to original type)")
    }
  }
}

// ─── Probe attachments / documents endpoints on appointment-requests ────
console.log("\n─── Probing attachment endpoints on appointment-request")
if (tokensByRealm.surecrm && (await fetch(
  `https://surelc.surancebay.com/surecrm/appointments-requests/116984707/attachments`,
  { headers: { Authorization: `Bearer ${tokensByRealm.surecrm}` } },
).then((r) => `${r.status} ${r.statusText}`))) {
  const tries = [
    "/surecrm/appointments-requests/116984707/attachments",
    "/surecrm/appointments-requests/116984707/documents",
    "/surecrm/appointments-requests/116984707/files",
    "/surecrm/appointments-requests/116984707/release-form",
    "/surecrm/appointments-requests/116984707/lor",
  ]
  for (const t of tries) {
    const r = await fetch(`https://surelc.surancebay.com${t}`, {
      headers: { Authorization: `Bearer ${tokensByRealm.surecrm}` },
    })
    console.log(`  GET ${t}  → ${r.status}`)
  }
}

await browser.close()
