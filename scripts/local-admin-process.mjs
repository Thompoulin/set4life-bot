#!/usr/bin/env node
/**
 * Local Phase C testing harness.
 *
 * Phase C URL pattern (verified Sydney 2026-05-07):
 *   https://surelc.surancebay.com/bga/producers/{producerId}/appointments/wizard/guard/{appointmentRequestId}
 *
 * 8-step wizard (sidebar):
 *   1. Carrier & Request Type
 *   2. States & Products
 *   3. Hierarchy & Commissions
 *   4. Training
 *   5. Errors & Omissions
 *   6. Carrier Questions
 *   7. Questionnaire
 *   8. Documents → final action: Process / Submit
 *
 * Same `sb-appointment-navigation-*` infrastructure as Phase B's rep
 * review wizard — clickNext + watch for the final action button.
 *
 * Usage:
 *   cd surelc-bot
 *   pnpm build
 *   node scripts/local-admin-process.mjs
 *
 * Env:
 *   PRODUCER_ID    — Sydney = 11482453
 *   APPOINTMENT_ID — defaults to first BGA-stage appointment found
 *   APPT_INDEX     — pick the Nth appointment from the list (default 0)
 *   AGENT_OPEN_ID  — for fetching list of pending appointments
 *   ADMIN_EMAIL / ADMIN_PASSWORD — defaults to Thomas's
 *   HEADED         — "0" for headless. Default headed (so you can watch).
 *   MAX_STEPS      — clip the walk early. Default 10.
 */
import { chromium } from "playwright"
import pino from "pino"
import fs from "node:fs/promises"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"

const APP_URL = "https://app.set4lifeagency.com"
const COOKIE_SECRET = "713df7896eaa71b7b405b5fc6f85a68a531e7ec46b7b5024fddcca3acb8dff41"
const AGENT_OPEN_ID = process.env.AGENT_OPEN_ID || "pending-sydney-desilva-yahoo-com-72"
const PRODUCER_ID = process.env.PRODUCER_ID || "11482453"
const APPT_INDEX = Number(process.env.APPT_INDEX || "0")
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "thomas@thompoulin.com"
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Exit-31$"
const HEADED = process.env.HEADED !== "0"
const SLOW_MO = Number(process.env.SLOW_MO ?? (HEADED ? 100 : 0))
const MAX_STEPS = Number(process.env.MAX_STEPS || "10")

async function fetchPendingAppointmentIds() {
  // Pull rep-creds endpoint to get the 9 appointment URLs Sydney's
  // signed; extract appointmentIds.
  const res = await fetch(`${APP_URL}/api/debug/surelc-rep-creds`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${COOKIE_SECRET}`,
    },
    body: JSON.stringify({ agentOpenId: AGENT_OPEN_ID }),
  })
  if (!res.ok) throw new Error(`creds endpoint HTTP ${res.status}`)
  const data = await res.json()
  return data.reviewUrls.map((e) => {
    const m = e.url.match(/appointmentId=(\d+)/)
    return { appointmentId: m ? m[1] : null, subject: e.subject }
  }).filter((x) => x.appointmentId)
}

const ids = await fetchPendingAppointmentIds()
// ALL_APPTS=1 → process every appointment in the list. Otherwise just
// the single one selected by APPT_INDEX or APPOINTMENT_ID.
const targets = process.env.ALL_APPTS === "1"
  ? ids
  : process.env.APPOINTMENT_ID
    ? [{ appointmentId: process.env.APPOINTMENT_ID, subject: "(env override)" }]
    : [ids[Math.min(APPT_INDEX, ids.length - 1)]]
console.log(`[phaseC-local] targets: ${targets.length}`)
for (const t of targets) console.log(`  - ${t.appointmentId} :: ${t.subject.slice(0, 60)}`)

const out = `/tmp/surelc-bot-admin-${Date.now()}`
await fs.mkdir(out, { recursive: true })
console.log(`[phaseC-local] screenshots → ${out}`)

const browser = await chromium.launch({
  headless: !HEADED,
  slowMo: SLOW_MO,
  args: ["--disable-blink-features=AutomationControlled"],
})
// Use a wide+tall viewport so:
//  - Step 3 (hierarchy) Code cell is visible (default 1280px clipped
//    the rightmost column); 1600px exposes Name + Code
//  - Step 8 Process button stays in-viewport (default 900px clipped it)
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1400 } })
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)
const logger = pino({ name: "phaseC-local" })

const login = await loginAdmin(
  page,
  { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  logger,
)
if (!login.ok) {
  console.error("admin login failed:", login.reason)
  await browser.close()
  process.exit(1)
}
console.log("[phaseC-local] admin logged in")

const summary = []
for (const target of targets) {
  console.log(`\n\n###### Target: ${target.appointmentId} :: ${target.subject.slice(0, 60)} ######`)
  // Wizard URL: /bga/producers/{p}/appointments/wizard/guard/{id}.
  // The /guard/ entry point redirects to /wizard/{id}/carrier (Step 1).
  // gotoBga's exact-match logic considers that redirect a failure and
  // triggers hard-goto retries that BOUNCE to OAuth (verified). Use
  // page.goto directly + manually wait for the URL to settle on any
  // wizard sub-route.
  const wizardUrl = `https://surelc.surancebay.com/bga/producers/${PRODUCER_ID}/appointments/wizard/guard/${target.appointmentId}`
  try {
    await page.goto(wizardUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    })
  } catch (err) {
    console.error(`  page.goto err: ${err.message}`)
  }
  // Poll the URL — Angular's wizard guard redirects /guard/{id} to
  // /{id}/carrier (or /states / etc. if step 1 was completed).
  const wizardDeadline = Date.now() + 20_000
  while (Date.now() < wizardDeadline) {
    if (
      page.url().includes(`/appointments/wizard/${target.appointmentId}/`)
    )
      break
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(3000)
  const finalUrl = page.url()
  const onWizard = finalUrl.includes(
    `/appointments/wizard/${target.appointmentId}`,
  )
  if (!onWizard) {
    console.error(`  wizard load failed: ${finalUrl}`)
    summary.push({ id: target.appointmentId, ok: false, reason: "wizard load failed" })
    continue
  }
  console.log(`  wizard loaded: ${finalUrl}`)
  let processed = false
  let lastStep = "?"

// Walk through the wizard. At each step, snapshot, log step name, then
// click Next.
for (let step = 1; step <= MAX_STEPS; step++) {
  const stepName = await page
    .locator(".navigator-header__title, .navigator-header span.name")
    .first()
    .textContent()
    .catch(() => "")
  const subtitle = await page
    .locator(".navigator-header__sub-title")
    .first()
    .textContent()
    .catch(() => "")
  const url = page.url()
  lastStep = (stepName || "").trim() || `step${step}`
  console.log(
    `\n=== Step ${step} :: ${(subtitle || "").trim()} :: ${(stepName || "").trim()} ===`,
  )
  console.log(`  URL: ${url}`)
  const fname = `${target.appointmentId}-step${step}-${(stepName || "x").trim().replace(/\W+/g, "_").slice(0, 30)}`
  await page.screenshot({ path: `${out}/${fname}.png`, fullPage: true })
  await fs.writeFile(`${out}/${fname}.html`, await page.content())

  // Look for action buttons.
  const btns = await page.$$eval("button", (els) =>
    els
      .filter((e) => e.offsetParent !== null && !e.disabled)
      .map((e) => (e.textContent || "").trim().slice(0, 50))
      .filter((t) => t)
      .slice(0, 25),
  )
  console.log(`  Visible enabled buttons: ${JSON.stringify(btns)}`)

  // Per-step required-input handling.
  // Step 3 (hierarchy & commissions): some carriers (Foresters via
  // Quility downline invitation) require Recruiter Name. Default to
  // RECRUITER_NAME env var ("Thomas Poulin").
  const stepNameLower = (stepName || "").toLowerCase()
  if (stepNameLower.includes("hierarchy")) {
    const recruiter = process.env.RECRUITER_NAME || "Thomas Poulin"
    // If a prior partial fill left us with Name=Poulin/Code=invalid,
    // click RESET TO DEFAULT first so we re-enter clean state, then
    // use the USE_X_IN_HIERARCHY path which fills both Name AND Code
    // in one action.
    const codeInvalid = await page.evaluate(() => {
      const labels = Array.from(
        document.querySelectorAll('[role="gridcell"][col-id="label"]'),
      )
      for (const lbl of labels) {
        if (/recruiter/i.test(lbl.textContent || "")) {
          const row = lbl.closest('[role="row"]')
          const codeCell = row?.querySelector('[role="gridcell"][col-id="code"]')
          if (codeCell?.classList.contains("ag-cell--invalid")) return true
        }
      }
      return false
    })
    if (codeInvalid) {
      // Click RESET TO DEFAULT.
      const reset = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"))
        const reset = btns.find((b) =>
          /reset to default/i.test((b.textContent || "").trim()),
        )
        if (reset) {
          reset.click()
          return true
        }
        return false
      })
      if (reset) {
        console.log("  Reset Hierarchy to Default before re-fill")
        await page.waitForTimeout(2000)
      }
    }

    // Recruiter Name lives in an AG Grid cell — double-click to enter
    // edit mode, then type. The label cell (col-id="label") and value
    // cell (col-id="name") are siblings in the same row.
    const cellInfo = await page.evaluate(() => {
      const labels = Array.from(
        document.querySelectorAll('[role="gridcell"][col-id="label"]'),
      )
      for (const lbl of labels) {
        if (/recruiter/i.test(lbl.textContent || "")) {
          // Find the value cell in the same row.
          const row = lbl.closest('[role="row"]')
          const valueCell = row?.querySelector('[role="gridcell"][col-id="name"]')
          if (valueCell) {
            const r = valueCell.getBoundingClientRect()
            valueCell.scrollIntoView({ block: "center" })
            return {
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2),
              hasValue: !!(valueCell.textContent || "").trim(),
            }
          }
        }
      }
      return null
    })
    // Also locate the Code cell — same row, col-id="code".
    const codeCellInfo = await page.evaluate(() => {
      const labels = Array.from(
        document.querySelectorAll('[role="gridcell"][col-id="label"]'),
      )
      for (const lbl of labels) {
        if (/recruiter/i.test(lbl.textContent || "")) {
          const row = lbl.closest('[role="row"]')
          const codeCell = row?.querySelector('[role="gridcell"][col-id="code"]')
          if (codeCell) {
            const r = codeCell.getBoundingClientRect()
            codeCell.scrollIntoView({ block: "center" })
            return {
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2),
              hasValue: !!(codeCell.textContent || "").trim(),
              isInvalid: codeCell.classList.contains("ag-cell--invalid"),
            }
          }
        }
      }
      return null
    })
    if (cellInfo && !cellInfo.hasValue) {
      console.log(`  Recruiter Name cell at (${cellInfo.x},${cellInfo.y}) — double-clicking to edit`)
      await page.mouse.dblclick(cellInfo.x, cellInfo.y)
      await page.waitForTimeout(1000)
      // After dblclick, an input should appear inside the cell.
      await page.keyboard.type(recruiter, { delay: 60 })
      await page.waitForTimeout(1500)
      // SureLC may show an autocomplete dropdown — pick the first
      // matching option.
      const optionClicked = await page.evaluate(() => {
        const opt = document.querySelector(
          ".cdk-overlay-pane mat-option, .mat-mdc-autocomplete-panel mat-option, .ag-rich-select-list mat-option",
        )
        if (opt) {
          opt.click()
          return true
        }
        return false
      })
      console.log(`  Typed "${recruiter}"`)
      // SureLC opens an "Edit Hierarchy for Recruiter Name" dialog.
      // APPLY on the Suggestions row only fills Name (Code stays empty
      // → NEXT stays disabled). USE 'X' IN HIERARCHY is the free-form
      // creator that fills both Name and Code in one action.
      await page.waitForTimeout(2500)
      const applied = await page.evaluate(() => {
        const btns = Array.from(
          document.querySelectorAll(
            "mat-dialog-container button, .mat-mdc-dialog-container button, .cdk-overlay-pane button",
          ),
        )
        // Prefer "USE '...' IN HIERARCHY" (free-form), fall back to APPLY.
        const useInHierarchy = btns.find(
          (b) =>
            !b.disabled &&
            !b.classList.contains("mat-mdc-button-disabled") &&
            /\bUSE\b.*\bIN HIERARCHY\b/i.test((b.textContent || "").trim()),
        )
        if (useInHierarchy) {
          useInHierarchy.click()
          return "use-in-hierarchy"
        }
        const apply = btns.find(
          (b) =>
            !b.disabled &&
            !b.classList.contains("mat-mdc-button-disabled") &&
            /^\s*apply\s*$/i.test((b.textContent || "").trim()),
        )
        if (apply) {
          apply.click()
          return "apply"
        }
        return null
      })
      console.log(`  Recruiter dialog action: ${applied}`)
      await page.waitForTimeout(2500)
      await page.screenshot({ path: `${out}/${target.appointmentId}-step3-after-apply.png`, fullPage: true })
    } else {
      console.log(
        `  Recruiter Name cell: ${cellInfo ? "already filled" : "not found"}`,
      )
    }

    // Now fill the Code cell if invalid (same dialog flow — double-click
    // opens a search/picker, type the recruiter, click APPLY in
    // Suggestions which fills BOTH Name and Code with the matched
    // producer's record).
    if (codeCellInfo && (codeCellInfo.isInvalid || !codeCellInfo.hasValue)) {
      console.log(`  Recruiter Code cell at (${codeCellInfo.x},${codeCellInfo.y}) — double-clicking to edit`)
      await page.mouse.dblclick(codeCellInfo.x, codeCellInfo.y)
      await page.waitForTimeout(1500)
      await page.keyboard.type(recruiter, { delay: 60 })
      await page.waitForTimeout(2500)
      const codeApplied = await page.evaluate(() => {
        const btns = Array.from(
          document.querySelectorAll(
            "mat-dialog-container button, .mat-mdc-dialog-container button, .cdk-overlay-pane button",
          ),
        )
        // Code dialog: try APPLY (suggestion) first — should fill the
        // matching producer's actual code. Fall back to USE_X if no
        // suggestion.
        const apply = btns.find(
          (b) =>
            !b.disabled &&
            !b.classList.contains("mat-mdc-button-disabled") &&
            /^\s*apply\s*$/i.test((b.textContent || "").trim()),
        )
        if (apply) {
          apply.click()
          return "apply"
        }
        const useInHierarchy = btns.find(
          (b) =>
            !b.disabled &&
            !b.classList.contains("mat-mdc-button-disabled") &&
            /\bUSE\b.*\bIN HIERARCHY\b/i.test((b.textContent || "").trim()),
        )
        if (useInHierarchy) {
          useInHierarchy.click()
          return "use-in-hierarchy"
        }
        return null
      })
      console.log(`  Recruiter Code dialog action: ${codeApplied}`)
      await page.waitForTimeout(2500)
      await page.screenshot({ path: `${out}/${target.appointmentId}-step3-after-code.png`, fullPage: true })
    } else {
      console.log(
        `  Recruiter Code cell: ${codeCellInfo ? "already filled" : "not found"}`,
      )
    }
  }
  // Step 2 (states & products): SureLC uses Material 3 evolution chips
  // (mat-chip-option), not mat-checkbox. The clickable target is the
  // <button matchipaction> inside each chip.
  if (
    stepNameLower.includes("states") ||
    stepNameLower.includes("product")
  ) {
    const clicked = await page.evaluate(() => {
      const chips = Array.from(
        document.querySelectorAll("mat-chip-option, mat-chip"),
      )
      const fixedLife = chips.find((c) => /Fixed\s*Life/i.test(c.textContent || ""))
      const target = fixedLife || chips[0]
      if (!target) return { skipped: true, reason: "no chips found" }
      const btn = target.querySelector(
        'button[matchipaction], button.mdc-evolution-chip__action',
      )
      if (!btn) return { skipped: true, reason: "no matchipaction button" }
      const wasSelected = btn.getAttribute("aria-selected") === "true"
      // Idempotent: only click if NOT already selected.
      if (wasSelected) return { skipped: true, reason: "already selected" }
      btn.click()
      return { clicked: true, wasSelected: false }
    })
    console.log(`  Product chip: ${JSON.stringify(clicked)}`)
    await page.waitForTimeout(1500)
  }

  // Stop if we see a "Process" / "Submit" / "Complete" / "Approve" /
  // "Send to Carrier" — that's the final action.
  const finalBtn = btns.find((b) =>
    /^(?:Process|Submit Request|Submit|Approve|Send|Complete|Finish)\b/i.test(b),
  )
  if (finalBtn) {
    console.log(`  ★ FINAL ACTION button found: [${finalBtn}]`)
    if (process.env.PROCESS === "1") {
      console.log(`  Clicking final action (PROCESS=1)...`)
      // Get the button's bounding box, scroll it into view, then use
      // Playwright's mouse to click at its center — this dispatches
      // the full PointerEvent sequence Material requires, bypassing
      // the locator-engine's visibility heuristic.
      const handle = await page.evaluateHandle((label) => {
        const re = new RegExp("^\\s*" + label + "\\s*$", "i")
        const btns = Array.from(document.querySelectorAll("button")).filter(
          (b) =>
            !b.disabled &&
            !b.classList.contains("mat-mdc-button-disabled") &&
            re.test((b.textContent || "").replace(/\s+/g, " ").trim()),
        )
        // SureLC's wizard renders mobile + desktop + widescreen variants;
        // pick the one that's actually positioned on-screen with non-zero
        // dimensions. offsetParent is null for display:none ancestors.
        const visible = btns.filter((b) => {
          if (b.offsetParent === null) return false
          const r = b.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        })
        const target = visible[0] || btns[0]
        target?.scrollIntoView({ block: "center", inline: "center" })
        return target ?? null
      }, finalBtn)
      const el = handle.asElement()
      if (!el) {
        console.log("  Could not find Process button handle.")
      } else {
        await page.waitForTimeout(500)
        // Force-click via Playwright — bypasses visibility heuristic AND
        // dispatches a real PointerEvent sequence Material's host
        // listener picks up.
        try {
          await el.click({ force: true, timeout: 5_000 })
          console.log("  Playwright force-click fired")
        } catch (err) {
          console.log(`  force-click err: ${err.message}`)
          // Final fallback — dispatch click + pointerdown/up sequence.
          try {
            await el.dispatchEvent("pointerdown")
            await el.dispatchEvent("pointerup")
            await el.dispatchEvent("click")
            console.log("  dispatched pointerdown/up/click")
          } catch {
            /* ignore */
          }
        }
      }
      await page.waitForTimeout(10_000)
      console.log("  Post-action URL:", page.url())
      const finalTitle = await page.title()
      console.log("  Title:", finalTitle)
      await page.screenshot({ path: `${out}/${fname}-after-process.png`, fullPage: true })
      await fs.writeFile(`${out}/${fname}-after-process.html`, await page.content())
      // Also dump any visible dialog so we can see the confirmation.
      const dialogs = await page.$$eval(
        "mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane",
        (els) =>
          els
            .filter((e) => e.offsetParent !== null)
            .map((e) => (e.textContent || "").trim().slice(0, 300))
            .filter((t) => t),
      )
      console.log(`  Open dialogs: ${dialogs.length}`)
      for (const d of dialogs) console.log(`    ${d}`)
      // Did SureLC's confirmation dialog fire?
      const confirmed = dialogs.some((d) =>
        /processed and sent|request has been processed/i.test(d),
      )
      processed = confirmed
    } else {
      console.log(`  Skipping click (set PROCESS=1 to actually process).`)
    }
    break
  }

  // Wait up to 15s for the bottom-right NEXT button to become enabled
  // (page-loading spinner often disables it for a few seconds while
  // SureLC fetches the step's data).
  const waitDeadline = Date.now() + 15_000
  let clickedNext = false
  while (Date.now() < waitDeadline) {
    clickedNext = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"))
      const candidates = btns.filter(
        (b) =>
          !b.disabled &&
          !b.classList.contains("mat-mdc-button-disabled") &&
          b.offsetParent !== null &&
          /^\s*Next\s*$/i.test((b.textContent || "").replace(/\s+/g, " ").trim()),
      )
      candidates.sort((a, b) => {
        const ar = a.getBoundingClientRect()
        const br = b.getBoundingClientRect()
        return br.y - ar.y || br.x - ar.x
      })
      if (candidates.length === 0) return false
      candidates[0].click()
      return true
    })
    if (clickedNext) break
    await page.waitForTimeout(1000)
  }
  if (!clickedNext) {
    console.log("  Next button never enabled within 15s — moving on.")
    break
  }
  await page.waitForTimeout(2500)
} // end step loop

  summary.push({
    id: target.appointmentId,
    subject: target.subject.slice(0, 60),
    ok: processed,
    lastStep,
  })
} // end target loop

console.log("\n\n###### SUMMARY ######")
for (const s of summary) {
  console.log(
    `  ${s.ok ? "✓" : "✗"}  ${s.id}  ${s.subject}  lastStep=${s.lastStep}`,
  )
}
const ok = summary.filter((s) => s.ok).length
console.log(`\nProcessed ${ok}/${summary.length}`)
console.log(`\nDUMPS in ${out}/`)
if (HEADED) {
  console.log("Browser left open. Ctrl+C to exit.")
  await new Promise(() => {})
} else {
  await browser.close()
}
