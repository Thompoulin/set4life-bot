/**
 * Recon round 4 — find the LOR / release-form upload affordance on
 * the appointment-request page in BGA. The bot already uploads E&O
 * / AML via Playwright setInputFiles on UI file inputs (no direct
 * API), so the LOR likely follows the same pattern.
 *
 * Strategy:
 *   1) Open Holton's Foresters appointment-request page (currently
 *      type=Contract, stage=Producer). Capture network traffic +
 *      DOM to see what document inputs exist as-is.
 *   2) Probe a discarded appointment-request with type=Transfer
 *      briefly (PUT type=Transfer, open page, capture, restore).
 *      The Transfer view should expose any LOR-specific UI.
 *   3) Watch for any clicks/UI events that might be the upload entry.
 *
 * Read-only mutation: the type-flip is restored before exit.
 */
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await ctx.newPage()
const log = pino()
await loginAdmin(page, { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" }, log)

let bearer = ""
page.on("request", (req) => {
  const a = req.headers()["authorization"]
  if (!bearer && req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
    const tok = a.replace("Bearer ", "")
    if (tok.split(".").length === 3) bearer = tok
  }
})

async function navTo(p) {
  await page.evaluate((path) => {
    history.pushState({}, "", path)
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
  }, p)
  await page.waitForTimeout(3500)
}

// Trigger initial /surecrm/* traffic.
await navTo("/bga/producers/11096584/profile")
console.log(`[bearer] ${bearer ? "captured" : "MISSING"}`)

// ── 1) Inspect Holton's Foresters appointment (currently Contract) ───
console.log("\n─── 1) Holton/Foresters page (type=Contract)")
await navTo("/bga/producers/11096584/contracts/116984707")
await page.waitForTimeout(2000)

async function dumpUploadAffordances(label) {
  console.log(`  [${label}]`)
  // File inputs
  const fileInputs = await page.$$('input[type="file"]')
  console.log(`    file inputs: ${fileInputs.length}`)
  for (let i = 0; i < fileInputs.length; i++) {
    const el = fileInputs[i]
    const id = await el.getAttribute("id").catch(() => null)
    const name = await el.getAttribute("name").catch(() => null)
    const accept = await el.getAttribute("accept").catch(() => null)
    const hidden = await el.evaluate((n) => {
      const s = window.getComputedStyle(n)
      return s.display === "none" || s.visibility === "hidden"
    }).catch(() => null)
    console.log(`      [${i}] id=${id} name=${name} accept=${accept} hidden=${hidden}`)
  }
  // Buttons that look like upload/attach/document
  const btns = await page.$$eval("button, a, label", (els) =>
    els
      .filter((e) => /upload|attach|document|release|lor|transfer/i.test(e.textContent || ""))
      .map((e) => ({
        tag: e.tagName.toLowerCase(),
        text: (e.textContent || "").trim().slice(0, 60),
        title: e.getAttribute("title") || null,
        ariaLabel: e.getAttribute("aria-label") || null,
        href: e.getAttribute("href") || null,
      })),
  )
  console.log(`    matching buttons/labels: ${btns.length}`)
  for (const b of btns.slice(0, 20)) console.log(`      ${b.tag}  text="${b.text}"  title=${b.title}  href=${b.href}`)
  // Any element whose text mentions release/LOR/transfer
  const mentions = await page.$$eval("*", (els) =>
    els
      .filter((e) => {
        if (e.children.length > 0) return false
        const t = (e.textContent || "").trim()
        return t.length > 0 && t.length < 80 && /release|letter\s+of\s+release|\bLOR\b|transfer/i.test(t)
      })
      .map((e) => ({ tag: e.tagName.toLowerCase(), text: (e.textContent || "").trim().slice(0, 80) }))
      .slice(0, 10),
  )
  console.log(`    text mentions of release/LOR/transfer: ${mentions.length}`)
  for (const m of mentions) console.log(`      ${m.tag}: "${m.text}"`)
}

await dumpUploadAffordances("Contract — Holton/Foresters")

// ── 2) Find a Discarded appointment, flip to Transfer, re-inspect, restore ───
console.log("\n─── 2) Probe Transfer view on a discarded request")
if (bearer) {
  const list = await fetch(
    `https://surelc.surancebay.com/surecrm/appointments-requests?producerId=11096584&gaId=1322`,
    { headers: { Authorization: `Bearer ${bearer}` } },
  ).then((r) => r.json())
  const discarded = list.find((a) => a.stage === "Discarded")
  if (!discarded) {
    console.log("  no Discarded appointments — skipping")
  } else {
    console.log(`  using discarded id=${discarded.appointmentRequestId} carrier=${discarded.carrierName}`)
    // Get full payload
    const full = await fetch(
      `https://surelc.surancebay.com/surecrm/appointments-requests/${discarded.appointmentRequestId}`,
      { headers: { Authorization: `Bearer ${bearer}` } },
    ).then((r) => r.json())
    const origType = full.type
    // Flip to Transfer
    const flip = await fetch(
      `https://surelc.surancebay.com/surecrm/appointments-requests/${discarded.appointmentRequestId}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...full, type: "Transfer" }),
      },
    )
    console.log(`  flip to Transfer: HTTP ${flip.status}`)
    if (flip.ok) {
      // Now open the page in the UI
      await navTo(`/bga/producers/11096584/contracts/${discarded.appointmentRequestId}`)
      await page.waitForTimeout(2500)
      await dumpUploadAffordances("Transfer — discarded request")
      // Restore
      const restore = await fetch(
        `https://surelc.surancebay.com/surecrm/appointments-requests/${discarded.appointmentRequestId}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ...full, type: origType }),
        },
      )
      console.log(`  restore to ${origType}: HTTP ${restore.status}`)
    }
  }
}

// ── 3) Also scan the full SPA bundle for any references to "release"
//        or "lor" or "letterOfRelease" — these might map to API
//        endpoints we couldn't probe directly.
console.log("\n─── 3) Scanning loaded scripts for release/LOR keywords")
const scripts = await page.$$eval("script[src]", (els) =>
  els.map((e) => e.src).filter((s) => s.includes("surelc.surancebay.com")),
)
console.log(`  ${scripts.length} surelc scripts loaded`)
for (const s of scripts.slice(0, 5)) {
  try {
    const body = await fetch(s).then((r) => r.text())
    const matches = []
    const re = /(["'`])([^"'`]{1,80}(?:release[-\s]?form|letter[-\s]?of[-\s]?release|\blor\b|transfer)[^"'`]{0,80})\1/gi
    let m
    while ((m = re.exec(body)) && matches.length < 20) matches.push(m[2])
    if (matches.length) {
      console.log(`  ${s.split("/").pop()} → ${matches.length} matches:`)
      for (const x of matches.slice(0, 10)) console.log(`     "${x}"`)
    }
  } catch {}
}

await browser.close()
