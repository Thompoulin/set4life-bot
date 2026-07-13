/**
 * Shared helpers for SureLC portal tab modules.
 *
 * Each tab module (profile, dba, eno, aml, eft, finra, signature,
 * contracting) imports from here so we have one place to evolve the
 * primitives — filling inputs, uploading files, clicking saves, taking
 * evidence screenshots, detecting "already done" idempotently.
 */

import type { Page, ElementHandle } from "playwright"
import type pino from "pino"
import { promises as fs } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"

export interface TabContext {
  page: Page
  logger: any
  jobId: string
  evidenceDir: string
  evidenceFiles: string[]
}

export interface TabResult {
  /** Did the tab end in a "complete / green" state? */
  ok: boolean
  /** Human-readable reason when ok=false. */
  reason?: string
  /** True if the tab was already complete before we touched it. */
  alreadyDone?: boolean
  /**
   * True when this carrier was neither signed nor genuinely-failed, but
   * SKIPPED for a structural reason that retrying can never fix — the
   * appointment-request was withdrawn/discarded by the agency. Skips
   * MUST NOT land in the rep-review `failed[]` array: a withdrawn
   * carrier is not a bot failure, and counting it as one churns the
   * daily sweep and falsely demotes the agent to needs_human even when
   * every live carrier signed fine. See rep/review.ts loop.
   */
  skipped?: boolean
  /** Why the carrier was skipped (e.g. "appointment_withdrawn"). */
  skipReason?: string
  /** Anything tab-specific the orchestrator should log. */
  details?: Record<string, unknown>
}

export function makeTabContext(
  page: Page,
  logger: any,
  jobId: string,
): TabContext {
  const evidenceDir = path.join(tmpdir(), "surelc-evidence", jobId)
  return { page, logger, jobId, evidenceDir, evidenceFiles: [] }
}

/**
 * First selector that resolves to a visible element. Selectors are
 * tried in order — list the most specific one first so we don't
 * accidentally bind to a generic match in a different tab.
 */
export async function firstVisible(
  page: Page,
  selectors: string[],
): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
  for (const sel of selectors) {
    const els = await page.$$(sel)
    for (const el of els) {
      try {
        if (await el.isVisible()) return el
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

/** Find a labelled input by its visible <label> text. */
export async function inputByLabel(
  page: Page,
  labelText: string,
): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
  // Strategy 1 — input directly inside the same <label>.
  const inLabel = await page.$(`label:has-text("${labelText}") input`)
  if (inLabel && (await inLabel.isVisible().catch(() => false))) return inLabel

  // Strategy 2 — input referenced by `for=`.
  const forAttr = await page.$$eval(
    "label",
    (labels, t) => {
      const lower = String(t).toLowerCase()
      const m = labels.find((l) => l.textContent?.toLowerCase().includes(lower))
      return m?.getAttribute("for") || null
    },
    labelText,
  )
  if (forAttr) {
    const ref = await page.$(`#${forAttr}`)
    if (ref && (await ref.isVisible().catch(() => false))) return ref
  }

  // Strategy 3 — Material/Angular: input near a mat-label.
  const matLabel = await page.$(
    `mat-label:has-text("${labelText}") >> xpath=ancestor::*[self::mat-form-field][1] >> input`,
  )
  if (matLabel && (await matLabel.isVisible().catch(() => false))) return matLabel

  return null
}

/** Fill an input identified by visible label text. */
export async function fillByLabel(
  page: Page,
  labelText: string,
  value: string,
): Promise<boolean> {
  const el = await inputByLabel(page, labelText)
  if (!el) return false
  try {
    await el.fill(value)
    return true
  } catch {
    return false
  }
}

/**
 * Fill an input only if it's currently empty. Returns:
 *   - "filled"   we wrote the value
 *   - "skipped"  field already had a value (don't clobber)
 *   - "missing"  no matching input on the page
 *   - "failed"   el.fill threw
 *
 * Used for forms that auto-populate via server-side OCR (e.g.
 * SureLC's E&O policy form, where Carrier comes back pre-filled
 * with the canonical company name and we should NOT overwrite it
 * with whatever sloppy abbreviation we pulled from the cert PDF).
 */
export async function fillIfEmpty(
  page: Page,
  labelText: string,
  value: string,
): Promise<"filled" | "skipped" | "missing" | "failed"> {
  const el = await inputByLabel(page, labelText)
  if (!el) return "missing"
  const current = await el.inputValue().catch(() => "")
  if (current && current.trim().length > 0) return "skipped"
  try {
    await el.fill(value)
    return "filled"
  } catch {
    return "failed"
  }
}

/**
 * Force-overwrite an input's value, bypassing masks/directives that
 * silently no-op `el.fill()` when a value is already present (e.g.
 * SureLC's E&O Case/Total Limit inputs use ngx-mask `unmask="typed"`,
 * which intercepts incoming fills and keeps the previous value when
 * the user types over it through Playwright).
 *
 * Strategy: locate the input via mat-label, click+Ctrl+A+Delete to
 * clear, then dispatch the value through the native HTMLInputElement
 * property setter so the underlying directive sees a fresh assignment.
 * Same pattern we use for MatDatepicker.
 */
export async function fillForce(
  page: Page,
  labelText: string,
  value: string,
): Promise<boolean> {
  const el = await inputByLabel(page, labelText)
  if (!el) return false
  try {
    // Strategy: reach into Angular's reactive FormControl directly
    // via the formcontrolname attribute. ngx-mask + mat-autocomplete
    // ignore programmatic value writes that go through the DOM
    // input — but patchValue on the underlying FormControl is
    // authoritative and updates both the model and the displayed
    // (masked) text. Falls back to keystroke typing if Angular
    // debug API isn't accessible.
    const patched = await page
      .evaluate(
        ({ lbl, v }) => {
          // Locate input via mat-label
          const labels = Array.from(document.querySelectorAll("mat-label, label"))
          const matchLabel = labels.find(
            (l) =>
              (l.textContent || "")
                .trim()
                .toLowerCase()
                .replace(/\*$/, "")
                .trim() === lbl.toLowerCase(),
          )
          const ff = matchLabel?.closest("mat-form-field") || matchLabel?.closest("label")?.parentElement
          const input = ff?.querySelector("input, textarea") as
            | (HTMLInputElement & { __ngContext__?: unknown[] })
            | null
          if (!input) return { ok: false, reason: "no-input" }

          // Try Angular debug API (window.ng) — only available in
          // dev builds, but some carriers run dev-mode-ish builds.
          const ng = (window as any).ng
          if (ng?.getDirectives) {
            try {
              const directives = ng.getDirectives(input) as Array<{ control?: { patchValue?: (v: unknown) => void } }>
              for (const d of directives) {
                if (typeof d?.control?.patchValue === "function") {
                  d.control.patchValue(v)
                  return { ok: true, via: "ng.getDirectives" }
                }
              }
            } catch {
              /* fall through */
            }
          }

          // Try __ngContext__ — every Angular element has it. Walk
          // the LView for a NgControl directive instance.
          const ctx = input.__ngContext__
          if (Array.isArray(ctx)) {
            for (const item of ctx) {
              if (item && typeof item === "object") {
                const obj = item as Record<string, any>
                // FormControlName has a `.control` property; NgModel
                // exposes `.control` too.
                const candidate = obj.control || obj.formControl
                if (candidate && typeof candidate.patchValue === "function") {
                  candidate.patchValue(v)
                  return { ok: true, via: "__ngContext__" }
                }
              }
            }
          }

          return { ok: false, reason: "no-form-control-found" }
        },
        { lbl: labelText, v: value },
      )
      .catch(() => ({ ok: false, reason: "evaluate-threw" }))

    if (patched.ok) {
      // FormControl patched — but the displayed input text might
      // still show the old masked value until the next change-
      // detection tick. Click + blur to flush.
      await el.click().catch(() => undefined)
      await el.press("Tab").catch(() => undefined)
      return true
    }

    // Fallback: keystroke approach (works for most non-mask fields).
    await el.click().catch(() => undefined)
    await el.click({ clickCount: 3 }).catch(() => undefined)
    await el.press("Backspace").catch(() => undefined)
    const afterClear = await el.inputValue().catch(() => "")
    if (afterClear) {
      for (let i = 0; i < afterClear.length + 5; i++) {
        await el.press("Backspace").catch(() => undefined)
      }
    }
    await el.type(value, { delay: 30 })
    await el.press("Tab").catch(() => undefined)
    return true
  } catch {
    return false
  }
}

/**
 * Select a value in a dropdown identified by visible label.
 * Tries native <select> first, then Material/Angular custom dropdowns.
 */
export async function selectByLabel(
  page: Page,
  labelText: string,
  value: string,
): Promise<boolean> {
  // Native <select>
  const select = await page.$(`label:has-text("${labelText}") select`)
  if (select && (await select.isVisible().catch(() => false))) {
    try {
      await select.selectOption({ label: value })
      return true
    } catch {
      try {
        await select.selectOption({ value })
        return true
      } catch {
        /* fall through */
      }
    }
  }

  // Angular Material dropdown
  const trigger = await page.$(
    `mat-label:has-text("${labelText}") >> xpath=ancestor::*[self::mat-form-field][1] >> mat-select`,
  )
  if (trigger && (await trigger.isVisible().catch(() => false))) {
    try {
      await trigger.click()
      await page.waitForTimeout(300)
      const option = await page.$(`mat-option:has-text("${value}")`)
      if (option) {
        await option.click()
        return true
      }
    } catch {
      /* fall through */
    }
  }
  return false
}

/**
 * Upload a remote file (S3 URL) to a file input identified by a label
 * or selector. Downloads to /tmp first, then sets the input.
 */
export async function uploadRemoteFile(
  page: Page,
  fileInputSelector: string,
  remoteUrl: string,
  logger: any,
): Promise<boolean> {
  try {
    const input = await page.$(fileInputSelector)
    if (!input) {
      logger.warn({ selector: fileInputSelector }, "file input not found")
      return false
    }
    const res = await fetch(remoteUrl)
    if (!res.ok) {
      logger.warn({ remoteUrl, status: res.status }, "remote file fetch failed")
      return false
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const filename =
      decodeURIComponent(remoteUrl.split("?")[0]?.split("/").pop() || "upload.pdf") ||
      "upload.pdf"
    const localPath = path.join(tmpdir(), `surelc-upload-${Date.now()}-${filename}`)
    await fs.writeFile(localPath, buf)
    await (input as any).setInputFiles(localPath)
    return true
  } catch (err: any) {
    logger.warn({ err: err?.message, remoteUrl }, "uploadRemoteFile threw")
    return false
  }
}

/**
 * Click the first visible save / submit button, picking from a list
 * of likely labels. Returns true if a click succeeded.
 */
export async function clickSave(
  page: Page,
  candidates: string[] = [
    'button:has-text("Save")',
    'button:has-text("Submit")',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button[type="submit"]',
  ],
): Promise<boolean> {
  const btn = await firstVisible(page, candidates)
  if (!btn) return false
  try {
    await btn.click()
    return true
  } catch {
    return false
  }
}

/** Wait for the page to settle after navigation / save. */
export async function settle(page: Page, ms: number = 1500): Promise<void> {
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => {})
  await page.waitForTimeout(ms)
}

/**
 * Navigate to a /bga/* URL without losing the BGA session.
 *
 * SureLC's BGA is an Angular SPA. A `page.goto` to a /bga/* URL after
 * login does a full browser reload — the JS context is destroyed and
 * the SPA bootstraps from scratch. During that bootstrap there's a
 * race with the auth guard that, in a Playwright session, almost
 * always fires before the in-memory auth state is wired and bounces
 * to accounts.surancebay.com/oauth/authorize. Owner verified
 * 2026-05-06 the same URL opens fine in a real browser; it is purely
 * a bootstrap-race artifact of headless automation. Retries don't
 * help — every reload hits the same race.
 *
 * Strategy:
 *   1. Try in-SPA navigation via the History API (pushState +
 *      popstate). The SPA stays loaded; Angular Router responds to
 *      the popstate event and renders the new route. No reload, no
 *      auth re-bootstrap, no bounce.
 *   2. If the URL didn't actually change to the target (e.g. router
 *      ignored the popstate, or path is wrong), fall back to
 *      page.goto with retry — at least we'll catch transient races
 *      we previously missed.
 *
 * Returns ok=true if the page is on the target path. ok=false with
 * the final URL if every strategy bounced.
 */
export async function gotoBga(
  page: Page,
  targetUrl: string,
  logger: pino.Logger,
): Promise<{ ok: true } | { ok: false; finalUrl: string }> {
  const target = new URL(targetUrl)
  const targetPathWithQuery = target.pathname + target.search + target.hash
  // Strip /bga/ prefix to get a "lookup path" we can also match against
  // the URL after navigation (since some SPAs normalise the path).
  const targetPathOnly = target.pathname.replace(/[?#].*$/, "")

  // Quick check — already there? No-op. Treat sub-routes as "there"
  // too — some SureLC tabs deep-link with a trailing id (e.g. DBA shows
  // /producers/X/dba/{affiliationId}); navigating from `/dba/123` to
  // `/dba` is a no-op as far as the user is concerned, but pushState
  // doesn't move Angular Router on this kind of "go up one level"
  // transition (Sydney 2026-05-07: bot bounced trying to drop the
  // /20547333 affiliation suffix that BGA itself added).
  if (page.url() === targetUrl) return { ok: true }
  try {
    const here = new URL(page.url()).pathname
    if (here === targetPathOnly) return { ok: true }
    if (here.startsWith(`${targetPathOnly}/`)) return { ok: true }
  } catch {
    /* malformed current URL; ignore */
  }

  // ── Attempt 0: CLICK the real in-app nav link (navigate like a human) ──
  // The BGA SPA keeps its auth session in memory. A cold/hard page-load of a
  // deep /bga route — and, since ~2026-07-10, a synthetic pushState the
  // router no longer honors — both bounce to /oauth/authorize. Confirmed
  // with the owner 2026-07-13: pasting `/bga/producers` into the address bar
  // logs even a human out, but CLICKING "Producers" inside the app works,
  // because a real click is client-side Angular routing that keeps the
  // session. So we now navigate the way a human does. This is robust to the
  // SureLC app/router (or Chromium) change that broke the old pushState hack;
  // the pushState + hard-nav attempts below remain as fallbacks.
  try {
    const seg = targetPathOnly.split("/").filter(Boolean).pop() || ""
    if (seg) {
      const label = seg.charAt(0).toUpperCase() + seg.slice(1) // producers → Producers
      const candidates = [
        page.locator(`a[href$="/${seg}"]`).first(),
        page.locator(`a[href*="/${seg}"]`).first(),
        page.locator(`[routerlink*="${seg}"]`).first(),
        page.getByRole("link", { name: new RegExp(`^${label}s?$`, "i") }).first(),
        page.getByRole("button", { name: new RegExp(`^${label}s?$`, "i") }).first(),
      ]
      for (const loc of candidates) {
        const found = await loc.count().catch(() => 0)
        if (!found) continue
        await loc.click({ timeout: 4_000 }).catch(() => {})
        await page.waitForTimeout(1_200)
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {})
        let here = ""
        try {
          here = new URL(page.url()).pathname
        } catch {
          /* malformed */
        }
        if (here === targetPathOnly || here.startsWith(`${targetPathOnly}/`)) {
          logger.info({ targetUrl }, "gotoBga: in-app nav-link click succeeded")
          return { ok: true }
        }
      }
      logger.warn(
        { target: targetUrl },
        "gotoBga: no in-app nav link matched (or click didn't land); falling back to pushState/hard-nav",
      )
    }
  } catch (err: any) {
    logger.warn(
      { err: err?.message, target: targetUrl },
      "gotoBga: nav-link click attempt threw; falling back",
    )
  }

  // ── Attempt 1: in-SPA navigation via History API ────────────────
  // Only works if we're already on a logged-in /bga/* page (same origin
  // as the target); cross-origin pushState would throw a SecurityError.
  let onSameOrigin = false
  try {
    onSameOrigin = new URL(page.url()).origin === target.origin
  } catch {
    /* malformed current URL */
  }
  if (onSameOrigin) {
    try {
      await page.evaluate((path) => {
        // Push the new URL onto history without a full reload, then
        // dispatch popstate so Angular Router (and most history-aware
        // SPA routers) react and render the new route.
        window.history.pushState({}, "", path)
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
      }, targetPathWithQuery)
      // Give the router a beat to react.
      await page.waitForTimeout(1_500)
      await page
        .waitForLoadState("networkidle", { timeout: 8_000 })
        .catch(() => {})
      const here = page.url()
      let landed = false
      try {
        landed = new URL(here).pathname === targetPathOnly
      } catch {
        landed = here === targetUrl
      }
      if (landed) {
        logger.info({ targetUrl }, "gotoBga: in-SPA navigation succeeded")
        return { ok: true }
      }
      logger.warn(
        { here, target: targetUrl },
        "gotoBga: pushState did not move router; falling back to hard navigation",
      )
    } catch (err: any) {
      logger.warn(
        { err: err?.message, target: targetUrl },
        "gotoBga: pushState attempt threw; falling back to hard navigation",
      )
    }
  }

  // ── Attempt 2: hard page.goto with retry on OAuth bounce ────────
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
    } catch (err: any) {
      logger.warn(
        { attempt, err: err?.message, target: targetUrl },
        "gotoBga: hard goto threw; will check URL and retry",
      )
    }
    await page
      .waitForLoadState("networkidle", { timeout: 8_000 })
      .catch(() => {})
    await page.waitForTimeout(1_500)
    const here = page.url()
    let bounced = false
    try {
      const u = new URL(here)
      bounced =
        /accounts\.surancebay\.com$/i.test(u.hostname) ||
        /^\/bga\/oauth\b/.test(u.pathname)
    } catch {
      /* malformed URL */
    }
    if (!bounced) return { ok: true }
    logger.warn(
      { attempt, here, target: targetUrl },
      "gotoBga: hard goto bounced to OAuth; backing off and retrying",
    )
    await page.waitForTimeout(2_000 * attempt)
  }

  // All strategies failed. Dump everything we can about the session so
  // the operator can see what state the bot was in at the moment of
  // bounce — most-likely cause is a missing trusted-device / MFA
  // bypass cookie that the JWT alone can't substitute for, but
  // without diagnostic data we keep guessing. Surface cookie names,
  // storage keys, and the JWT's claims so the next failure is
  // actionable instead of opaque.
  const diag = await page
    .evaluate(() => {
      const localKeys: string[] = []
      const sessionKeys: string[] = []
      try {
        for (let i = 0; i < localStorage.length; i++) {
          localKeys.push(localStorage.key(i) || "")
        }
        for (let i = 0; i < sessionStorage.length; i++) {
          sessionKeys.push(sessionStorage.key(i) || "")
        }
      } catch {
        /* may throw on cross-origin pages */
      }
      return { localKeys, sessionKeys }
    })
    .catch(() => ({ localKeys: [] as string[], sessionKeys: [] as string[] }))
  const cookieNames: string[] = await page
    .context()
    .cookies()
    .then((cs) => cs.map((c) => `${c.domain}:${c.name}`))
    .catch(() => [] as string[])
  // DIAGNOSTIC (2026-07-12): capture the bounce page's title + visible text so
  // we can tell a bot-detection CHALLENGE (Datadome/PerimeterX/"verify you're
  // human") apart from a plain SureLC login form. Distinguishes datacenter-IP
  // bot-blocking from a session-not-carried flow issue.
  const pageContent = await page
    .evaluate(() => ({
      title: document.title,
      bodyText: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 600),
      hasEmailInput: !!document.querySelector('input[type="email"],input[data-cy="email-input"]'),
      hasPasswordInput: !!document.querySelector('input[type="password"]'),
    }))
    .catch(() => ({ title: "(unreadable)", bodyText: "", hasEmailInput: false, hasPasswordInput: false }))
  logger.warn(
    {
      target: targetUrl,
      finalUrl: page.url(),
      localStorageKeys: diag.localKeys,
      sessionStorageKeys: diag.sessionKeys,
      cookieNames,
      pageTitle: pageContent.title,
      pageBodyText: pageContent.bodyText,
      looksLikeLoginForm: pageContent.hasEmailInput && pageContent.hasPasswordInput,
    },
    "gotoBga: all strategies bounced; session diagnostic dump",
  )
  return { ok: false, finalUrl: page.url() }
}

/** Take a labelled screenshot + HTML dump for evidence. */
export async function snapshot(
  ctx: TabContext,
  label: string,
): Promise<void> {
  await fs.mkdir(ctx.evidenceDir, { recursive: true }).catch(() => {})
  const png = path.join(ctx.evidenceDir, `${label}.png`)
  const html = path.join(ctx.evidenceDir, `${label}.html`)
  await ctx.page.screenshot({ path: png, fullPage: true }).catch(() => {})
  const content = await ctx.page.content().catch(() => "")
  await fs.writeFile(html, content, "utf8").catch(() => {})
  ctx.evidenceFiles.push(png, html)
}

/**
 * Detect "already complete" — the SureLC portal usually shows a green
 * checkmark / "Complete" badge / status pill on tabs that are done.
 * Each tab module passes its own list of selectors that signal "no
 * action needed". Used for idempotent re-runs (auto-repair).
 */
export async function isTabComplete(
  page: Page,
  doneSelectors: string[],
): Promise<boolean> {
  for (const sel of doneSelectors) {
    const el = await page.$(sel)
    if (el && (await el.isVisible().catch(() => false))) return true
  }
  return false
}
