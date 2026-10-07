/**
 * SureLC rep SSN/DOB auth gate (accounts.surancebay.com/oauth/authorize,
 * client_id=arreview) — the screen Phase B passes before it can sign as the rep.
 *
 * 2026-10-05 redesign: the auth app moved from Angular 13 / legacy Material to
 * Angular 19 / MDC Material and its form controls were renamed:
 *
 *   before                                after
 *   <auth-ssn-input name="ssn">           <sb-ssn-input format="ssn6">
 *     <input class="hidden">                <input data-cy="ssn-input" class="hidden">
 *     <input class="visible" readonly>      <input class="visible">        (no readonly)
 *   <auth-date-input formcontrolname=dob> <sb-date-input formcontrolname="dob">
 *     <input matinput id="mat-input-0">     <input matinput data-cy="date-input" role="combobox">
 *   <button mat-flat-button>LOGIN         <button mat-flat-button class="mat-mdc-unelevated-button">LOGIN
 *
 * The bot only looked for `auth-ssn-input`, so from 2026-10-06 every Phase B
 * run reported "SSN field not found at auth (email/password gate persisted
 * after retries)" while the page was in fact showing the normal SSN/DOB gate.
 * Both generations are accepted below. Fixture:
 * test/fixtures/rep-auth-2026-10-05/ (trimmed from the bot's own failure dump).
 *
 * Reason strings returned here are matched by the backoffice
 * (activationPipeline.ts TRANSIENT_BOT_FAILURE_PATTERNS / AUTH_REJECTION_PATTERNS:
 * /SSN field not found at (?:re-)?auth/ etc.) — keep the prefixes.
 */
import type { Page } from "playwright"
import { firstVisible, settle, snapshot, type TabContext } from "../tabs/helpers.js"

/** The SSN control's host element, new tag first. */
export const SSN_HOST = "sb-ssn-input, auth-ssn-input"

/** The input that receives keystrokes (IMask-bound; the `.visible` one is display only). */
export const SSN_KEY_INPUT = [
  'sb-ssn-input input[data-cy="ssn-input"]',
  "sb-ssn-input input.hidden",
  "auth-ssn-input input.hidden",
  "auth-ssn-input input:not([readonly])",
].join(", ")

/** The typeable DOB input (never the hidden matNativeControl datepicker input). */
export const DOB_INPUT = [
  'sb-date-input input[data-cy="date-input"]',
  'sb-date-input input[matinput][type="text"]:not([matnativecontrol])',
  "auth-date-input input#mat-input-0",
  'auth-date-input input[type="text"]:not([readonly]):not([matnativecontrol])',
].join(", ")

/** Anything that means the auth SPA has mounted a form. */
export const AUTH_FORM_MOUNTED = `${SSN_HOST}, input[matinput], input.mat-mdc-input-element, input[type="password"]`

export const LOGIN_BUTTONS = [
  'button:has-text("LOGIN")',
  'button:has-text("Login")',
  'button:has-text("Sign In")',
  'button:has-text("Authenticate")',
  'button:has-text("Verify")',
  'button:has-text("Continue")',
  'button:has-text("Submit")',
  'button[type="submit"]',
  "button.mat-mdc-unelevated-button.mat-accent",
  "button.mat-flat-button.mat-primary",
]

const digitsOf = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "")

/** True when the SSN/DOB gate (either generation) is on the page. */
export async function hasSsnGate(page: Page): Promise<boolean> {
  return !!(await page.$(SSN_HOST).catch(() => null))
}

async function readValue(page: Page, selector: string): Promise<string> {
  return page
    .evaluate((sel: string) => (document.querySelector(sel) as HTMLInputElement | null)?.value ?? "", selector)
    .catch(() => "")
}

async function typeSsn(page: Page, ssnLast6: string): Promise<void> {
  const focused = await page
    .evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLInputElement | null
      if (!el) return false
      el.focus()
      return document.activeElement === el
    }, SSN_KEY_INPUT)
    .catch(() => false)
  if (!focused) {
    // Clicking the host routes focus to the real input (onContainerClick).
    await (await page.$(SSN_HOST))?.click().catch(() => undefined)
  }
  await page.waitForTimeout(300)
  await page.keyboard.type(ssnLast6, { delay: 100 })
  await page.waitForTimeout(500)
}

async function clearInput(page: Page, selector: string): Promise<void> {
  await page
    .evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLInputElement | null
      if (!el) return
      el.focus()
      el.select?.()
    }, selector)
    .catch(() => undefined)
  await page.keyboard.press("Backspace").catch(() => undefined)
}

/**
 * Fill SSN (last 6) + DOB and click LOGIN. Each value is read back from the
 * page before LOGIN; if what landed is not what we meant to type, nothing is
 * submitted (a wrong SSN/DOB attempt is never sent to SureLC).
 * `where` only words the failure reason ("auth" for Step 0, "re-auth" for the
 * mid-wizard OAuth-bounce recovery).
 */
export async function fillRepAuthGate(
  ctx: TabContext,
  ssnLast6: string,
  dob: string,
  where: "auth" | "re-auth",
  opts: { snapshots?: boolean } = {},
): Promise<{ ok: boolean; reason?: string }> {
  const { page, logger } = ctx

  if (!(await page.$(SSN_KEY_INPUT))) {
    return { ok: false, reason: `SSN field not found at ${where}` }
  }
  await typeSsn(page, ssnLast6)
  if (digitsOf(await readValue(page, SSN_KEY_INPUT)) !== ssnLast6) {
    // One clean retry — a keystroke can be lost while IMask is still binding.
    await clearInput(page, SSN_KEY_INPUT)
    await typeSsn(page, ssnLast6)
  }
  const ssnLanded = digitsOf(await readValue(page, SSN_KEY_INPUT))
  if (ssnLanded !== ssnLast6) {
    const ssnLen = ssnLanded.length
    logger.warn({ ssnDigitsLanded: ssnLen }, "[Rep auth] SSN did not land in the masked input — not submitting")
    return { ok: false, reason: `SSN field not found at ${where} (typed digits did not land in the SSN input; ${ssnLen}/6)` }
  }
  if (opts.snapshots) await snapshot(ctx, "rep-step0a-after-ssn")

  const dobSlashed = dob.replace(/-/g, "/") // MM/DD/YYYY
  const dobInput = await page.$(DOB_INPUT)
  if (!dobInput) return { ok: false, reason: `DOB field not found at ${where}` }
  try {
    await dobInput.fill(dobSlashed, { force: true, timeout: 10_000 })
  } catch {
    // fall through to the keyboard path below
  }
  if (digitsOf(await readValue(page, DOB_INPUT)) !== digitsOf(dobSlashed)) {
    // The DOB input is IMask-masked (MM/dd/yyyy); typed digits get their
    // slashes inserted by the mask.
    await dobInput.click({ force: true }).catch(() => undefined)
    await clearInput(page, DOB_INPUT)
    await page.keyboard.type(digitsOf(dobSlashed), { delay: 80 })
  }
  // Focusing the DOB input opens its mat-autocomplete panel; close it before
  // tabbing out so no suggestion can be picked, then blur to commit.
  await page.keyboard.press("Escape").catch(() => undefined)
  await page.keyboard.press("Tab").catch(() => undefined)
  await page.waitForTimeout(500)
  const dobLanded = await readValue(page, DOB_INPUT)
  if (digitsOf(dobLanded) !== digitsOf(dobSlashed)) {
    logger.warn({ dobDigitsLanded: digitsOf(dobLanded).length }, "[Rep auth] DOB did not land / was rejected by the mask — not submitting")
    return { ok: false, reason: `DOB field not found at ${where} (typed date did not stick in the DOB input)` }
  }
  if (opts.snapshots) await snapshot(ctx, "rep-step0a-fields-filled")

  const authBtn = await firstVisible(page, LOGIN_BUTTONS)
  if (!authBtn) return { ok: false, reason: `LOGIN button not found at ${where}` }
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {}),
    authBtn.click(),
  ])
  await settle(page, 3000)
  return { ok: true }
}
