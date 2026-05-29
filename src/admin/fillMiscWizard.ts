/**
 * Wizard-driven misc/compliance fill for BGA stage appointment-requests.
 *
 * The SureLC direct PUT /surecrm/appointments-requests/{id}/miscellaneous
 * is silently no-op for admin Bearer tokens — returns 200 but the model
 * doesn't persist regardless of body shape (verified 2026-05-29 with
 * Bates Americo 117916924: tried flat, {model:{}}, {fields,model},
 * Hopkinson-shaped, with/without ?file=, from server IP matching JWT
 * claim — all 200 no-persist).
 *
 * The only mechanism that persists is the BGA review wizard's own
 * Carrier Questions step. This module:
 *   1. Navigates to the wizard guard URL.
 *   2. Walks each step, clicking Next.
 *   3. On the Carrier Questions step, fills every mat-radio-group with
 *      ComplianceDetails questions to "N" (or the override from
 *      `answers`).
 *   4. Clicks Next on Carrier Questions — this triggers the SPA's
 *      PUT /miscellaneous with the wizard-session context that the
 *      server accepts.
 *   5. STOPS before Documents step (never clicks Process). Closing the
 *      browser is safe — the misc PUT fires synchronously on Next click
 *      so the save persists.
 *
 * Unlike Phase C (full process review, hard-disabled 2026-05-12) this
 * endpoint does NOT release the contract to the carrier. It only
 * unblocks the AR_MISCELLANEOUS WARNING so the admin can do the
 * BGA→Carrier release manually.
 */

import { snapshot, settle, type TabContext, type TabResult } from "../tabs/helpers.js"

export interface FillMiscWizardInput {
  /** SureLC's appointment-request ID (the integer). */
  appointmentRequestId: string
  /** SureLC's producer ID (the integer). */
  producerId: string
  /**
   * Optional per-question overrides keyed by substring of the question
   * label. Default for unmatched questions is "N". Example:
   *   { "1994 Crime Act": "N", "outstanding civil judgments": "N" }
   */
  answers?: Record<string, "Y" | "N">
  /**
   * Optional text-field values keyed by exact SureLC field name.
   * Used to fill input[type=text] cells on the misc step. Example:
   *   { "placeOfBirth": "Freeport, New York" }
   */
  textValues?: Record<string, string>
}

interface FillMiscWizardResult extends TabResult {
  details?: {
    stepsWalked: string[]
    fieldsFilled?: number
    miscStepReached?: boolean
    miscSaveSeen?: boolean
    finalUrl?: string
  }
}

const MAX_STEPS = 12

export async function fillMiscWizard(
  ctx: TabContext,
  input: FillMiscWizardInput,
): Promise<FillMiscWizardResult> {
  const { page, logger } = ctx
  const answers = input.answers ?? {}

  // Install a network sniffer so we can confirm the misc PUT fired and
  // record its status. The wizard fires:
  //   PUT /surecrm/appointments-requests/{id}/miscellaneous
  // when Next is clicked on Carrier Questions.
  const miscPutResponses: Array<{ status: number; url: string }> = []
  const onResponse = (resp: any) => {
    try {
      const url = resp.url()
      if (
        url.includes(`/appointments-requests/${input.appointmentRequestId}/miscellaneous`) &&
        resp.request().method() === "PUT"
      ) {
        miscPutResponses.push({ status: resp.status(), url })
        logger.info(
          { status: resp.status(), url },
          "[fillMiscWizard] misc PUT response observed",
        )
      }
    } catch {
      /* ignore */
    }
  }
  page.on("response", onResponse)

  // Navigate via the SPA's internal router (history.pushState +
  // popstate). page.goto() triggers a full browser reload which
  // revalidates the OAuth token against accounts.surancebay.com and
  // can bounce cold sessions. SPA navigation keeps the in-memory
  // Bearer token intact — verified pattern used by recover-orphan,
  // diagnose-producer, etc.
  const wizardPath = `/bga/producers/${input.producerId}/appointments/wizard/guard/${input.appointmentRequestId}`
  logger.info({ wizardPath }, "[fillMiscWizard] navigating to wizard via SPA router")
  await page
    .evaluate((path: string) => {
      history.pushState({}, "", path)
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
    }, wizardPath)
    .catch(() => undefined)

  // Wait for guard redirect into an actual step URL.
  const guardDeadline = Date.now() + 20_000
  while (Date.now() < guardDeadline) {
    if (page.url().includes(`/appointments/wizard/${input.appointmentRequestId}/`)) break
    await page.waitForTimeout(500)
  }
  await settle(page, 3000)
  if (!page.url().includes(`/appointments/wizard/${input.appointmentRequestId}`)) {
    page.off("response", onResponse)
    return {
      ok: false,
      reason: `wizard guard bounced to ${page.url()} — OAuth throttle or session lost`,
    }
  }

  const stepsWalked: string[] = []
  let fieldsFilled = 0
  let miscStepReached = false

  for (let step = 1; step <= MAX_STEPS; step++) {
    const stepName = (
      (await page
        .locator(".navigator-header__title, .navigator-header span.name")
        .first()
        .textContent()
        .catch(() => "")) || ""
    )
      .toLowerCase()
      .trim()
    stepsWalked.push(stepName)
    logger.info({ step, stepName }, "[fillMiscWizard] step")

    // Hard stop on Documents step — that's where Process button lives.
    // We must NEVER click it.
    if (
      stepName.includes("document") &&
      !stepName.includes("documents and misc")
    ) {
      logger.info(
        { stepName },
        "[fillMiscWizard] reached Documents step — stopping before Process",
      )
      break
    }

    // Carrier Questions step — fill misc + ComplianceDetails questions.
    // SureLC's misc step name varies by template; match loosely.
    const isMiscStep =
      stepName.includes("carrier questions") ||
      stepName.includes("miscellaneous") ||
      stepName.includes("compliance") ||
      stepName.includes("misc")

    // Always dump the visible mat-radio-group labels on every step
    // so we can see which step actually carries the AR_MISCELLANEOUS
    // ComplianceDetails questions. Important: "Carrier Questions"
    // step in some templates carries PER-AGENCY yes/no overrides
    // (Mutual: New Producer / etc.) — different from ComplianceDetails.
    const labels = await page.evaluate(() => {
      const groups = Array.from(document.querySelectorAll("mat-radio-group"))
      return groups.map((g) => {
        const labelEl = g
          .closest("sb-question, .wrap, mat-form-field, .form-field")
          ?.querySelector(".question__text, label, .question-label")
        return (labelEl?.textContent || "").trim().slice(0, 80)
      })
    })
    if (labels.length > 0) {
      logger.info({ step: stepName, labels }, "[fillMiscWizard] radio labels on this step")
    }

    if (isMiscStep) {
      miscStepReached = true
      await snapshot(ctx, `fillMisc-${input.appointmentRequestId}-step${step}-pre`)
      const filled = await fillMiscRadios(ctx, answers)
      fieldsFilled += filled
      logger.info({ filled }, "[fillMiscWizard] misc radios filled on this step")
      // Also fill text inputs matched by formcontrolname against the
      // textValues map. Many carriers ask for placeOfBirth, residentCounty,
      // felony_county, felony_state etc. as plain text on the misc step.
      const textFilled = await fillMiscTextInputs(ctx, input.textValues || {})
      fieldsFilled += textFilled
      if (textFilled > 0) {
        logger.info({ textFilled }, "[fillMiscWizard] text fields filled on this step")
      }
      await page.waitForTimeout(1500)
      await snapshot(ctx, `fillMisc-${input.appointmentRequestId}-step${step}-post`)
    }

    // Even on non-misc steps, if a ComplianceDetails radio sneaks in
    // we want to fill it. Be defensive — Americo's misc might be
    // labelled "Step 6 - Miscellaneous" on one carrier and "Carrier
    // Questions" on another.
    if (!isMiscStep) {
      const opportunistic = await fillMiscRadios(ctx, answers)
      if (opportunistic > 0) {
        miscStepReached = true
        fieldsFilled += opportunistic
        logger.info(
          { opportunistic, stepName },
          "[fillMiscWizard] opportunistic misc fill on non-misc step",
        )
      }
    }

    // If we've completed the misc step, peek at the next step. If it
    // looks like Documents (Process button) we want to stop. Otherwise
    // click Next to continue walking.
    const clicked = await clickNextWhenEnabled(ctx)
    if (!clicked) {
      // No Next button — could mean Process button is visible (we've
      // reached the end of the wizard) OR Next is permanently disabled
      // due to validation. Either way: STOP. Don't search for Process.
      logger.info(
        { stepName },
        "[fillMiscWizard] no Next button — stopping (will not click Process)",
      )
      break
    }
    await settle(page, 2500)

    // Continue walking even after misc PUT fires — Americo's
    // AR_MISCELLANEOUS may actually be on a later step (the bundle
    // catalogs MISC step under AR_MISCELLANEOUS / AR_MISCELLANEOUS_AGENCY
    // / AR_ASSISTANTS / AR_OPTIONAL_PRODUCER_FORMS — multiple steps
    // can map to "MISC"). We stop only at Documents (hard stop) or
    // when Next button doesn't appear (step disabled).
  }

  page.off("response", onResponse)

  const miscSaveSeen = miscPutResponses.some((r) => r.status >= 200 && r.status < 300)
  const ok = miscStepReached && miscSaveSeen
  return {
    ok,
    reason: ok
      ? undefined
      : !miscStepReached
        ? `misc step never reached. Steps walked: ${stepsWalked.join(" → ")}`
        : `misc step reached but no successful PUT observed (responses: ${JSON.stringify(miscPutResponses)})`,
    details: {
      stepsWalked,
      fieldsFilled,
      miscStepReached,
      miscSaveSeen,
      finalUrl: page.url(),
    },
  }
}

/**
 * Fill every mat-radio-group visible on the current step. Matches the
 * answers map by substring on the question label. Anything unmatched
 * defaults to "N" — which is the safe default for ComplianceDetails
 * questions (1994 Crime Act, 1033 form, civil judgments, FINRA
 * sanctions, etc.) and commission-assignment overrides.
 *
 * Uses Playwright's native mouse.click() on the mat-radio-button host
 * because synthetic `element.click()` in page.evaluate doesn't fire
 * Angular Material's full pointer-event sequence — the radio visually
 * updates but the Reactive Form value doesn't change, so the subsequent
 * Next click triggers no PUT (or fires a stale empty PUT). Verified
 * 2026-05-29 against Bates Americo 117916924: synthetic clicks gave
 * "7 filled" + 200 PUT but model didn't persist.
 *
 * Returns the number of groups that got a click.
 */
async function fillMiscRadios(
  ctx: TabContext,
  answers: Record<string, string>,
): Promise<number> {
  const { page } = ctx

  // Discover the unfilled groups by index so we can re-query coords
  // FRESH for each one. Capturing all 7 coords up-front breaks: the
  // first click scrolls the page, so coords 2..N are stale and clicks
  // land in the wrong places. Verified Bates 2026-05-29 — fields 4..8
  // persisted but 2..3 didn't because their captured coords were
  // off-screen after the page settled.
  const groupCount = await page.evaluate(() => {
    return document.querySelectorAll("mat-radio-group").length
  })

  let clicked = 0
  for (let idx = 0; idx < groupCount; idx++) {
    const click = await page.evaluate(
      (args: { idx: number; map: Record<string, string> }) => {
        const groups = Array.from(document.querySelectorAll("mat-radio-group"))
        const g = groups[args.idx]
        if (!g) return null
        const checked = g.querySelector(
          'input[type="radio"]:checked',
        ) as HTMLInputElement | null
        if (checked && (checked.value === "Y" || checked.value === "N")) {
          return { skip: true, reason: "already-checked", value: checked.value }
        }
        const labelEl = g
          .closest("sb-question, .wrap, mat-form-field, .form-field")
          ?.querySelector(".question__text, label, .question-label")
        const label = (labelEl?.textContent || "").trim()

        let value: "Y" | "N" = "N"
        for (const [key, ans] of Object.entries(args.map)) {
          if (label.toLowerCase().includes(key.toLowerCase())) {
            value = ans.toLowerCase().startsWith("y") ? "Y" : "N"
            break
          }
        }
        const inp = g.querySelector(
          `input[type="radio"][value="${value}"]`,
        ) as HTMLInputElement | null
        if (!inp) return { skip: true, reason: "no-input", value }
        const host = (inp.closest("mat-radio-button") || inp) as HTMLElement
        host.scrollIntoView({ block: "center", inline: "center" })
        const r = host.getBoundingClientRect()
        if (r.width === 0 || r.height === 0)
          return { skip: true, reason: "zero-rect", value }
        return {
          skip: false as const,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          label: label.slice(0, 60),
          value,
        }
      },
      { idx, map: answers },
    )
    if (!click) continue
    if (click.skip) {
      ctx.logger.info(
        { idx, reason: click.reason, value: click.value },
        "[fillMiscWizard] skipping radio group",
      )
      continue
    }
    // Wait briefly for any scroll animation triggered by scrollIntoView
    // to settle before clicking.
    await page.waitForTimeout(250)
    const cx = click.x as number
    const cy = click.y as number
    try {
      await page.mouse.click(cx, cy, { delay: 30 })
      ctx.logger.info(
        { idx, x: click.x, y: click.y, value: click.value, label: click.label },
        "[fillMiscWizard] radio clicked",
      )
      await page.waitForTimeout(250)
      clicked++
    } catch (err: any) {
      ctx.logger.warn(
        { err: err?.message, label: click.label },
        "[fillMiscWizard] radio click failed",
      )
    }
  }
  return clicked
}

/**
 * Fill text inputs on the current step that match a key in `textValues`.
 * Match is by formcontrolname or name attribute. Uses Playwright's native
 * fill so Angular's reactive form picks up the value via the input event.
 *
 * Skips fields already non-empty (idempotent). Returns count of fields
 * actually filled.
 */
async function fillMiscTextInputs(
  ctx: TabContext,
  textValues: Record<string, string>,
): Promise<number> {
  const { page } = ctx
  if (Object.keys(textValues).length === 0) return 0
  // Discover which fields exist on the page and match our values.
  const candidates = await page.evaluate((map: Record<string, string>) => {
    const inputs = Array.from(
      document.querySelectorAll(
        'input[type="text"], input:not([type]), input[type="email"]',
      ),
    ) as HTMLInputElement[]
    const out: Array<{ selector: string; name: string; value: string }> = []
    for (const inp of inputs) {
      const name = inp.getAttribute("formcontrolname") || inp.getAttribute("name") || ""
      if (!name) continue
      if (!(name in map)) continue
      if (inp.value && inp.value.trim() !== "") continue
      // Build a stable selector — formcontrolname is unique on the misc form.
      const sel = `input[formcontrolname="${name}"], input[name="${name}"]`
      out.push({ selector: sel, name, value: map[name] })
    }
    return out
  }, textValues)

  let filled = 0
  for (const c of candidates) {
    try {
      const loc = page.locator(c.selector).first()
      await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined)
      await loc.fill(c.value, { timeout: 5000 })
      // Blur to trigger Angular's reactive form change detection.
      await loc.evaluate((el: HTMLInputElement) => el.blur())
      await page.waitForTimeout(150)
      ctx.logger.info(
        { name: c.name, value: c.value.slice(0, 40) },
        "[fillMiscWizard] text field filled",
      )
      filled++
    } catch (err: any) {
      ctx.logger.warn(
        { err: err?.message, name: c.name },
        "[fillMiscWizard] text field fill failed",
      )
    }
  }
  return filled
}

/** Bottom-right Next button. Wait up to 15s for enable. */
async function clickNextWhenEnabled(ctx: TabContext): Promise<boolean> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const clicked = await ctx.page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button")).filter(
        (b: any) =>
          !b.disabled &&
          !b.classList.contains("mat-mdc-button-disabled") &&
          b.offsetParent !== null &&
          /^\s*Next\s*$/i.test((b.textContent || "").replace(/\s+/g, " ").trim()),
      )
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
