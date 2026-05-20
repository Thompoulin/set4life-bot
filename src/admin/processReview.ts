/**
 * Phase C — Admin BGA-stage review wizard.
 *
 * After the rep signs in /ar-review, SureLC moves the contract from
 * `Producer` stage to `BGA` stage where it waits for an agency admin
 * to walk through an 8-step review wizard and click "Process". That
 * pushes the contract to the configured upline (Quility for Set4Life)
 * and ultimately to the carrier.
 *
 * URL pattern (verified Sydney 2026-05-07):
 *   /bga/producers/{producerId}/appointments/wizard/guard/{appointmentRequestId}
 *
 * The /guard/ entry point auto-redirects to the first incomplete step
 * (typically /carrier). Wizard steps:
 *
 *   1. Carrier & Request Type   — defaults to "Contract", just Next
 *   2. States & Products        — toggle "Fixed Life" mat-chip-option
 *                                  (idempotent: skip if already selected)
 *   3. Hierarchy & Commissions  — fill Recruiter Name + Code via the
 *                                  AG Grid cell → "USE 'X' IN HIERARCHY"
 *                                  free-form path. Reset to Default
 *                                  first if a partial Name-only fill
 *                                  was left from an earlier session.
 *   4. Training                 — Next (auto-validated from profile)
 *   5. Errors & Omissions       — Next (auto-validated from profile)
 *   6. Carrier Questions        — Next (auto-defaults)
 *   7. Questionnaire            — wait for "Loading..." spinner to
 *                                  clear before clicking Next
 *   8. Documents                — final Process button. Lives bottom-
 *                                  right; needs 1400px+ viewport so
 *                                  Playwright considers it visible.
 *
 * SureLC's confirmation dialog after a successful Process click reads:
 *   "✓ This request has been processed and sent to the selected
 *    recipient(s)"
 *
 * Throttle: SureLC rate-limits the wizard route after ~5-10 rapid
 * accesses; the production caller should sleep 30-60s between
 * appointments in a batch.
 */

import {
  firstVisible,
  settle,
  snapshot,
  type TabContext,
  type TabResult,
} from "../tabs/helpers.js"

export interface AdminReviewInput {
  /**
   * SureLC's appointment request ID (the integer in the rep-review
   * URL's `appointmentId=` query string). REQUIRED. Without it, the
   * wizard guard URL can't resolve.
   */
  requestId?: string
  producerId: string
  carrierName: string
  recruiterName: string // e.g. "Thomas Poulin"
  certifiedByName: string // e.g. "Thomas Poulin"
  /** Per-carrier agency-side answers, keyed by question label. */
  carrierAgencyAnswers?: Record<string, string>
}

export async function processBgaReview(
  ctx: TabContext,
  input: AdminReviewInput,
): Promise<TabResult> {
  const { page, logger } = ctx

  if (!input.requestId) {
    return {
      ok: false,
      reason:
        "appointmentRequestId missing — caller must extract from rep-review email URL",
    }
  }

  const wizardUrl = `https://surelc.surancebay.com/bga/producers/${input.producerId}/appointments/wizard/guard/${input.requestId}`
  try {
    await page.goto(wizardUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    })
  } catch (err: any) {
    return {
      ok: false,
      reason: `wizard goto failed: ${err.message}`,
    }
  }

  // Poll URL — Angular's wizard guard redirects /guard/{id} to
  // /{id}/carrier. Anything under /wizard/{id}/ is success.
  const wizardDeadline = Date.now() + 20_000
  while (Date.now() < wizardDeadline) {
    if (
      page.url().includes(`/appointments/wizard/${input.requestId}/`)
    )
      break
    await page.waitForTimeout(500)
  }
  await settle(page, 3000)
  if (!page.url().includes(`/appointments/wizard/${input.requestId}`)) {
    return {
      ok: false,
      reason: `wizard guard bounced to ${page.url()} — likely OAuth throttle or session lost`,
    }
  }
  await snapshot(ctx, `phaseC-${input.requestId}-step1-carrier`)

  // ── Walk the 8 steps ───────────────────────────────────────────────
  const MAX_STEPS = 12
  let processed = false
  let lastStep = ""
  for (let step = 1; step <= MAX_STEPS; step++) {
    const stepName = await page
      .locator(".navigator-header__title, .navigator-header span.name")
      .first()
      .textContent()
      .catch(() => "")
    const stepNameLower = (stepName || "").toLowerCase().trim()
    lastStep = stepNameLower
    logger.info({ step, stepName: stepNameLower }, "[Phase C] step")

    // Per-step required-input handling.
    if (stepNameLower.includes("states") || stepNameLower.includes("product")) {
      await selectFirstProductChip(ctx)
    }
    if (stepNameLower.includes("hierarchy")) {
      await fillRecruiterHierarchy(ctx, input.recruiterName)
    }
    if (stepNameLower.includes("carrier questions") && input.carrierAgencyAnswers) {
      await fillCarrierAgencyAnswers(ctx, input.carrierAgencyAnswers)
    }

    // Look for the final Process button — Step 8 (Documents).
    const finalBtn = await findFinalActionButton(ctx)
    if (finalBtn) {
      logger.info({ step, finalBtn }, "[Phase C] final action button found")
      await snapshot(ctx, `phaseC-${input.requestId}-step8-documents-pre`)
      const clicked = await clickButtonByText(ctx, finalBtn)
      if (!clicked) {
        return { ok: false, reason: `Process button click failed at step ${step}` }
      }
      await settle(page, 10_000)
      await snapshot(ctx, `phaseC-${input.requestId}-step8-documents-post`)
      // Verify confirmation dialog text.
      const dialogText = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll(
            "mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane",
          ),
        )
          .filter((e: any) => e.offsetParent !== null)
          .map((e: any) => (e.textContent || "").trim())
          .join(" | "),
      )
      logger.info({ dialogText: dialogText.slice(0, 200) }, "[Phase C] post-process dialogs")
      if (/processed and sent|request has been processed/i.test(dialogText)) {
        processed = true
      }
      break
    }

    // Otherwise click Next (wait up to 15s for it to enable).
    const clickedNext = await clickNextWhenEnabled(ctx)
    if (!clickedNext) {
      return {
        ok: false,
        reason: `Next button never enabled at step "${stepNameLower}"`,
      }
    }
    await settle(page, 2500)
  }

  if (!processed) {
    return {
      ok: false,
      reason: `walked ${MAX_STEPS} steps, last="${lastStep}", never reached Process / no confirmation`,
    }
  }
  return { ok: true }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Click the first selectable mat-chip-option. SureLC's States &
 *  Products step requires at least one product chip selected before
 *  Next enables. Idempotent — no-op if a chip is already selected. */
async function selectFirstProductChip(ctx: TabContext): Promise<void> {
  const result = await ctx.page.evaluate(() => {
    const chips = Array.from(
      document.querySelectorAll("mat-chip-option, mat-chip"),
    )
    // Prefer "Fixed Life" — universal Set4Life product.
    const fixed = chips.find((c) => /Fixed\s*Life/i.test(c.textContent || ""))
    const target = fixed || chips[0]
    if (!target) return { ok: false, reason: "no chips" }
    const btn = target.querySelector(
      'button[matchipaction], button.mdc-evolution-chip__action',
    )
    if (!btn) return { ok: false, reason: "no chip action button" }
    if (btn.getAttribute("aria-selected") === "true") {
      return { ok: true, alreadySelected: true }
    }
    ;(btn as HTMLButtonElement).click()
    return { ok: true, clicked: true }
  })
  ctx.logger.info({ ...result }, "[Phase C] product chip")
  await ctx.page.waitForTimeout(1500)
}

/** Fill the Recruiter Name + Code in Step 3's AG Grid hierarchy table.
 *  Uses the "Edit Hierarchy for Recruiter Name" dialog's USE 'X' IN
 *  HIERARCHY button — fills both Name AND Code in one action.
 *
 *  If a prior partial fill left Name=valid + Code=invalid, click
 *  RESET TO DEFAULT first, then re-enter. */
async function fillRecruiterHierarchy(
  ctx: TabContext,
  recruiterName: string,
): Promise<void> {
  const { page, logger } = ctx
  // Detect partial fill (Code cell still has ag-cell--invalid).
  const partial = await page.evaluate(() => {
    const labels = Array.from(
      document.querySelectorAll('[role="gridcell"][col-id="label"]'),
    )
    for (const lbl of labels) {
      if (/recruiter/i.test(lbl.textContent || "")) {
        const row = lbl.closest('[role="row"]')
        const codeCell = row?.querySelector(
          '[role="gridcell"][col-id="code"]',
        )
        return codeCell?.classList.contains("ag-cell--invalid") || false
      }
    }
    return false
  })
  if (partial) {
    const reset = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"))
      const reset = btns.find((b) =>
        /reset to default/i.test((b.textContent || "").trim()),
      )
      if (reset) {
        ;(reset as HTMLButtonElement).click()
        return true
      }
      return false
    })
    if (reset) {
      logger.info("[Phase C] reset Hierarchy to Default before re-fill")
      await page.waitForTimeout(2000)
    }
  }

  // Find Recruiter Name cell coordinates.
  const cellInfo = await page.evaluate(() => {
    const labels = Array.from(
      document.querySelectorAll('[role="gridcell"][col-id="label"]'),
    )
    for (const lbl of labels) {
      if (/recruiter/i.test(lbl.textContent || "")) {
        const row = lbl.closest('[role="row"]')
        const valueCell = row?.querySelector(
          '[role="gridcell"][col-id="name"]',
        )
        if (valueCell) {
          const r = (valueCell as HTMLElement).getBoundingClientRect()
          ;(valueCell as HTMLElement).scrollIntoView({
            block: "center",
            inline: "center",
          })
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
  if (!cellInfo) {
    logger.warn("[Phase C] Recruiter Name cell not found")
    return
  }
  if (cellInfo.hasValue && !partial) {
    logger.info("[Phase C] Recruiter Name already filled — skipping")
    return
  }

  logger.info(
    { x: cellInfo.x, y: cellInfo.y },
    "[Phase C] dblclick Recruiter Name cell",
  )
  await page.mouse.dblclick(cellInfo.x, cellInfo.y)
  await page.waitForTimeout(1500)
  await page.keyboard.type(recruiterName, { delay: 60 })
  await page.waitForTimeout(2500)
  // Prefer "USE 'X' IN HIERARCHY" — it fills BOTH Name and Code
  // (the suggestion's APPLY button only fills Name).
  const action = await page.evaluate(() => {
    const btns = Array.from(
      document.querySelectorAll(
        "mat-dialog-container button, .mat-mdc-dialog-container button, .cdk-overlay-pane button",
      ),
    )
    const useInHierarchy = btns.find(
      (b: any) =>
        !b.disabled &&
        !b.classList.contains("mat-mdc-button-disabled") &&
        /\bUSE\b.*\bIN HIERARCHY\b/i.test((b.textContent || "").trim()),
    )
    if (useInHierarchy) {
      ;(useInHierarchy as HTMLButtonElement).click()
      return "use-in-hierarchy"
    }
    const apply = btns.find(
      (b: any) =>
        !b.disabled &&
        !b.classList.contains("mat-mdc-button-disabled") &&
        /^\s*apply\s*$/i.test((b.textContent || "").trim()),
    )
    if (apply) {
      ;(apply as HTMLButtonElement).click()
      return "apply"
    }
    return null
  })
  logger.info({ action }, "[Phase C] Recruiter dialog")
  await page.waitForTimeout(2500)
}

/** Step 6 — Carrier Questions: SureLC's per-agency yes/no overrides
 *  (e.g. Mutual: New Producer / No). Default everything to No if no
 *  override provided. */
async function fillCarrierAgencyAnswers(
  ctx: TabContext,
  answers: Record<string, string>,
): Promise<void> {
  const { page } = ctx
  await page.evaluate((map: Record<string, string>) => {
    const groups = Array.from(document.querySelectorAll("mat-radio-group"))
    for (const g of groups) {
      const groupName = (
        g.querySelector('input[type="radio"]') as HTMLInputElement | null
      )?.name
      if (!groupName) continue
      const labelEl = g
        .closest("sb-question, .wrap, mat-form-field")
        ?.querySelector(".question__text, label")
      const label = (labelEl?.textContent || "").trim()
      // Find override match.
      let value: string | undefined
      for (const [key, ans] of Object.entries(map)) {
        if (label.toLowerCase().includes(key.toLowerCase())) {
          value = ans.toLowerCase().startsWith("y") ? "Y" : "N"
          break
        }
      }
      const target = g.querySelector(
        `input[type="radio"][value="${value || "N"}"]`,
      ) as HTMLInputElement | null
      if (target && !target.checked) {
        const host = target.closest("mat-radio-button") as HTMLElement | null
        if (host) host.click()
        else target.click()
      }
    }
  }, answers)
  await page.waitForTimeout(1500)
}

/** Find the wizard's bottom-right Process / Submit / Send button if
 *  Step 8 is currently active. Returns the button text or null. */
async function findFinalActionButton(
  ctx: TabContext,
): Promise<string | null> {
  return ctx.page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"))
    const candidates = btns.filter(
      (b: any) =>
        !b.disabled &&
        !b.classList.contains("mat-mdc-button-disabled") &&
        b.offsetParent !== null,
    )
    for (const b of candidates) {
      const text = (b.textContent || "").replace(/\s+/g, " ").trim()
      if (
        /^(?:Process|Submit Request|Submit|Approve|Send|Complete|Finish)\b/i.test(
          text,
        )
      ) {
        return text
      }
    }
    return null
  })
}

/** Click a button by exact text match. SureLC's wizard renders mobile +
 *  desktop + widescreen variants; pick the one that's visible (non-zero
 *  bounding rect, offsetParent set). */
async function clickButtonByText(
  ctx: TabContext,
  label: string,
): Promise<boolean> {
  return ctx.page.evaluate((label: string) => {
    const re = new RegExp("^\\s*" + label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&") + "\\s*$", "i")
    const btns = Array.from(document.querySelectorAll("button")).filter(
      (b: any) =>
        !b.disabled &&
        !b.classList.contains("mat-mdc-button-disabled") &&
        re.test((b.textContent || "").replace(/\s+/g, " ").trim()),
    )
    const visible = btns.filter((b: any) => {
      if (b.offsetParent === null) return false
      const r = b.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
    const target = (visible[0] || btns[0]) as HTMLButtonElement | undefined
    if (!target) return false
    target.scrollIntoView({ block: "center", inline: "center" })
    target.click()
    return true
  }, label)
}

/** Click the bottom-right NEXT button. Some steps disable Next while
 *  loading — wait up to 15s for it to enable. */
async function clickNextWhenEnabled(ctx: TabContext): Promise<boolean> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const clicked = await ctx.page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button")).filter(
        (b: any) =>
          !b.disabled &&
          !b.classList.contains("mat-mdc-button-disabled") &&
          b.offsetParent !== null &&
          /^\s*Next\s*$/i.test(
            (b.textContent || "").replace(/\s+/g, " ").trim(),
          ),
      )
      // Bottom-right is at higher Y (and right X). Sort by Y desc.
      btns.sort((a: any, b: any) => {
        const ar = a.getBoundingClientRect()
        const br = b.getBoundingClientRect()
        return br.y - ar.y || br.x - ar.x
      })
      const target = btns[0] as HTMLButtonElement | undefined
      if (!target) return false
      target.click()
      return true
    })
    if (clicked) return true
    await ctx.page.waitForTimeout(1000)
  }
  return false
}
