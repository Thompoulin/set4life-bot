/**
 * Recon: does SureLC support Transfer/Recontract request type +
 * release-form attachment on the appointment-request level?
 *
 * Probes:
 *   1) Full payload shape of an existing appointment-request to spot
 *      any type/flowType/transferType field.
 *   2) The single-row GET endpoint /surecrm/appointments-requests/{id}
 *      for richer detail than the list endpoint.
 *   3) The swagger spec(s) for endpoints that look like:
 *        - PATCH/PUT /appointment-requests/{id}
 *        - POST /appointment-requests/{id}/attachments
 *        - any "transfer" / "release-form" / "lor" route
 *   4) The agency-level Swagger (surecrm + carrierlc + onboard scopes).
 *   5) Existing carrierlc/contracts endpoint for hints about transfer
 *      contracts already on file.
 *
 * Read-only — no mutations.
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
const log = pino()
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, log)

let surecrmBearer = null
let carrierlcBearer = null
let onboardBearer = null
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (a?.startsWith("Bearer ")) {
    const tok = a.replace("Bearer ", "")
    if (tok.split(".").length === 3) {
      if (!surecrmBearer && req.url().includes("/surecrm/")) surecrmBearer = tok
      if (!carrierlcBearer && req.url().includes("/carrierlc/")) carrierlcBearer = tok
      if (!onboardBearer && req.url().includes("/onboard/")) onboardBearer = tok
    }
  }
})

// Trigger surecrm + carrierlc traffic by opening a producer page.
await page.evaluate(() => {
  history.pushState({}, "", "/bga/producers/11096584")
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(4000)

// Also visit the contracts tab + look at agency LOA list to pull carrierlc + onboard tokens.
await page.evaluate(() => {
  history.pushState({}, "", "/bga/producers/11096584/contracts")
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
})
await page.waitForTimeout(3500)

console.log(`\n[bearer] surecrm: ${surecrmBearer ? "captured" : "MISSING"}`)
console.log(`[bearer] carrierlc: ${carrierlcBearer ? "captured" : "MISSING"}`)
console.log(`[bearer] onboard: ${onboardBearer ? "captured" : "MISSING"}\n`)

// ── 1) Raw shape of an appointment-request ────────────────────────────
console.log("─── 1) Full appointment-request payload (Holton/Foresters in-flight)")
const list = await fetch(
  `https://surelc.surancebay.com/surecrm/appointments-requests?producerId=11096584&gaId=1322`,
  { headers: { Authorization: `Bearer ${surecrmBearer}` } },
).then((r) => r.json())
const ip = list.find((a) => a.stage === "Producer") || list[0]
console.log(JSON.stringify(ip, null, 2))

// ── 2) Single-row GET (often returns richer shape than list) ───────────
if (ip?.appointmentRequestId) {
  console.log(`\n─── 2) GET /surecrm/appointments-requests/${ip.appointmentRequestId}`)
  const single = await fetch(
    `https://surelc.surancebay.com/surecrm/appointments-requests/${ip.appointmentRequestId}`,
    { headers: { Authorization: `Bearer ${surecrmBearer}` } },
  )
  console.log(`  HTTP ${single.status}`)
  if (single.ok) {
    const body = await single.json()
    // Print only keys that aren't already in the list payload, plus all values for
    // anything that mentions transfer/release/type/document/attachment.
    const ipKeys = new Set(Object.keys(ip))
    const newKeys = Object.keys(body).filter((k) => !ipKeys.has(k))
    console.log("  New keys not seen in list payload:", newKeys)
    for (const [k, v] of Object.entries(body)) {
      if (/transfer|release|type|document|attach|recontract|priorBroker|prior|loa|lor/i.test(k)) {
        console.log(`    ${k} =`, v)
      }
    }
  } else {
    console.log(`  body: ${(await single.text()).slice(0, 400)}`)
  }
}

// ── 3) Swagger spec — pull route list for transfer/attach hints ────────
console.log("\n─── 3) Swagger spec scan")
async function fetchSwagger(name, slug, bearer) {
  if (!bearer) {
    console.log(`  [${name}] no bearer captured — skipping`)
    return null
  }
  const url = `https://surelc.surancebay.com/${slug}/v2/api-docs`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } })
  if (!r.ok) {
    console.log(`  [${name}] swagger ${r.status}`)
    return null
  }
  return r.json()
}
const swaggers = {
  surecrm: await fetchSwagger("surecrm", "surecrm", surecrmBearer),
  carrierlc: await fetchSwagger("carrierlc", "carrierlc", carrierlcBearer),
  onboard: await fetchSwagger("onboard", "onboard", onboardBearer),
}
for (const [name, spec] of Object.entries(swaggers)) {
  if (!spec?.paths) continue
  console.log(`\n  [${name}] paths matching /transfer|release|attach|document|appointment-request|prior/i:`)
  for (const path of Object.keys(spec.paths).sort()) {
    if (/transfer|release|attach|document|appointment-request|prior|recontract|lor/i.test(path)) {
      const methods = Object.keys(spec.paths[path]).filter((m) => !m.startsWith("x-"))
      console.log(`    ${methods.map((m) => m.toUpperCase()).join("/")} ${path}`)
    }
  }
}

// ── 4) For each appointment-request endpoint found, dump its operation
//        details so we can see the request body schema (especially for
//        any update / patch / type-change route).
console.log("\n─── 4) Operation detail for appointment-request endpoints")
for (const [name, spec] of Object.entries(swaggers)) {
  if (!spec?.paths) continue
  for (const path of Object.keys(spec.paths)) {
    if (!/appointment-?request|appointment_request|appointmentrequest/i.test(path)) continue
    for (const method of Object.keys(spec.paths[path])) {
      if (method.startsWith("x-")) continue
      const op = spec.paths[path][method]
      console.log(`\n  [${name}] ${method.toUpperCase()} ${path}`)
      console.log(`    summary: ${op.summary || "-"}`)
      if (op.parameters?.length) {
        for (const p of op.parameters) {
          console.log(`    param: ${p.in} ${p.name} (${p.type || p.schema?.$ref || "?"}) ${p.required ? "[req]" : ""}`)
        }
      }
      if (op.requestBody) {
        console.log(`    body: ${JSON.stringify(op.requestBody).slice(0, 250)}`)
      }
    }
  }
}

// ── 5) Try a discovery GET on the appointment-request's likely "type" field via the producer's contracts endpoint
console.log("\n─── 5) /carrierlc/contracts/producer/{id} — does it expose transfer status on existing contracts?")
if (carrierlcBearer) {
  const c = await fetch(
    `https://surelc.surancebay.com/carrierlc/contracts/producer/11096584`,
    { headers: { Authorization: `Bearer ${carrierlcBearer}` } },
  )
  console.log(`  HTTP ${c.status}`)
  if (c.ok) {
    const body = await c.json()
    if (Array.isArray(body) && body.length > 0) {
      console.log(`  example row keys: ${Object.keys(body[0]).join(", ")}`)
      const transferRow = body.find((r) => /transfer|recontract/i.test(JSON.stringify(r)))
      if (transferRow) console.log(`  TRANSFER row sample:`, JSON.stringify(transferRow, null, 2))
    }
  }
}

await browser.close()
