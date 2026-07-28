/**
 * Login to the SureLC BGA admin portal.
 *
 * Per Loom spec: BGA admin URL is https://surelc.surancebay.com/bga/.
 * The producer-rep portal is at /producer/ — different login, different
 * flow. This module is for the AGENCY ADMIN only. For the rep flow
 * (Step 0 of the Producer Review wizard) see ../rep/review.ts.
 *
 * Credentials come from the bot's env (SURELC_ADMIN_EMAIL +
 * SURELC_ADMIN_PASSWORD) — owner created a dedicated bot@... account
 * to keep MFA off (per spec section D, Trou #9). Real admins
 * (Thomas / Anna / Marilyn) can keep MFA on their own logins.
 */

import type { Page } from "playwright"
import type pino from "pino"
import { firstVisible } from "../tabs/helpers.js"

export const BGA_LOGIN_URL = "https://surelc.surancebay.com/bga/"

export interface LoginAdminResult {
  ok: boolean
  /** Why login failed — surfaced in the activation timeline so the
   *  owner can see "Invalid email or password" / "MFA required" /
   *  "session not real" without digging into Dokku logs. */
  reason?: string
  /** True when the failure is NOT worth retrying — explicit bad
   *  credentials or an MFA challenge. Transient failures (blank/bounced
   *  OAuth page, missing form, no token yet) leave this false so the
   *  retry wrapper tries again. */
  fatal?: boolean
}

/**
 * Log in to the BGA admin portal, retrying transient failures.
 *
 * Why a retry wrapper exists (2026-05-30): the login PAGE and our
 * selectors are verified-good — a manual login with these exact creds
 * lands on /bga/producers instantly, and `input[data-cy="email-input"]`
 * is present and visible. Yet the bot's headless container on the Vultr
 * datacenter IP intermittently lands on a blank / bounced OAuth page
 * ("email input not found", "did not land on /bga/*") — SureLC's auth
 * guard does bot detection (see the navigator.webdriver patch in
 * botRunner) and intermittently refuses the headless session, especially
 * under the bot's fresh-login-per-operation volume. The old code reloaded
 * exactly once and then failed the whole job, so a single transient block
 * stranded a producer for the day. We now re-navigate fresh up to
 * MAX_LOGIN_ATTEMPTS times with growing backoff. Genuine bad-creds / MFA
 * failures short-circuit (fatal) so we don't hammer a truly-broken login.
 */
export async function loginAdmin(
  page: Page,
  creds: { email: string; password: string },
  logger: pino.Logger,
): Promise<LoginAdminResult> {
  // Bumped 4 → 8 (2026-07-10). The datacenter-IP bot-detection block is
  // intermittent and clears on its own within a few tries; giving up at 4
  // was stranding producers for a full day on what is almost always a
  // transient wobble. More attempts + longer tail backoff rides out the
  // throttle window instead.
  const MAX_LOGIN_ATTEMPTS = 8
  // Backoff before attempt N (index = attempt number). Attempt 1 is
  // immediate; later attempts wait longer to ride out a throttle window
  // without turning into a hammer. Tail extended for the extra attempts.
  const BACKOFF_MS = [0, 0, 4_000, 10_000, 20_000, 30_000, 45_000, 60_000, 60_000]
  let lastReason: string | undefined
  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const backoff = BACKOFF_MS[attempt] ?? 20_000
      logger.warn(
        { attempt, of: MAX_LOGIN_ATTEMPTS, backoffMs: backoff, lastReason },
        "admin login: retrying after transient failure",
      )
      await page.waitForTimeout(backoff)
    }
    const res = await attemptLogin(page, creds, logger, attempt)
    if (res.ok) {
      if (attempt > 1) {
        logger.info({ attempt }, "admin login: succeeded on retry")
      }
      return res
    }
    lastReason = res.reason
    if (res.fatal) {
      // Wrong password / MFA — retrying won't help and risks locking the
      // service account. Fail immediately with the explicit reason.
      logger.warn({ attempt, reason: res.reason }, "admin login: fatal failure — not retrying")
      return res
    }
  }
  return {
    ok: false,
    reason: `admin login failed after ${MAX_LOGIN_ATTEMPTS} attempts — last: ${lastReason ?? "unknown"}`,
  }
}

/** One login attempt: navigate fresh, fill the OAuth form, confirm we
 *  landed inside /bga/* with a real token. Returns fatal=true only for
 *  unambiguous credential / MFA failures so the wrapper knows to stop. */
async function attemptLogin(
  page: Page,
  creds: { email: string; password: string },
  logger: pino.Logger,
  attempt: number,
): Promise<LoginAdminResult> {
  await page.goto(BGA_LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  })

  // Wait up to 25s for the login form (the SPA may redirect to the
  // accounts.surancebay.com auth domain on cold start). Parse the URL
  // properly — the previous regex `/\/bga\//.test(url)` would match the
  // OAuth authorize URL because its `redirect_uri` query parameter
  // contains `/bga/oauth`, falsely declaring the bot already logged in
  // (owner-reported failure 2026-05-05: bot reported "Logged in" then
  // immediately failed at "Add Producer button not found" because it
  // was actually still on the OAuth login form).
  //
  // We don't break the wait loop on "any visible input" anymore — the
  // 2026-05-22 failure mode was that `input:visible` matched a transient
  // input (cookie banner / SPA bootstrap form) before the actual OAuth
  // form rendered, then firstVisible ran against an unsettled DOM and
  // returned null. Instead wait specifically for the OAuth form's
  // username field to be in the DOM, and only THEN proceed.
  const start = Date.now()
  while (Date.now() - start < 25_000) {
    if (isLoggedInBgaUrl(page.url())) return { ok: true } // already logged in
    const formReady = await page.$(
      'input[data-cy="email-input"], input[type="email"], input[name="username"]',
    )
    if (formReady) break
    await page.waitForTimeout(500)
  }
  // Extra beat for Material to finish wiring up the input. Without it
  // isVisible() can race the form's slide-in animation and return false
  // for an input that's already in the DOM. Bumped 1.5s → 3s (2026-07-10):
  // on the datacenter IP the OAuth form's slide-in is noticeably slower
  // than in a local browser, and 1.5s was still occasionally racing it
  // ("email input invisible after wait").
  await page.waitForTimeout(3_000)

  const emailSelectors = [
    'input[data-cy="email-input"]',
    'input[formcontrolname="username"]',
    'input[type="email"]',
    'input[name*="email" i]',
    'input[name*="username" i]',
    'input[id*="email" i]',
    'input[id*="username" i]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[aria-label*="email" i]',
    'input[placeholder*="email" i]',
  ]
  let emailField = await firstVisible(page, emailSelectors)
  // Transient: form rendered (the formReady selector above matched in the
  // DOM) but firstVisible() couldn't pin a visible field — often a
  // mid-animation race or an off-screen Material wrapper. Reload and retry
  // in-attempt. Fixes Mayo + Estell 2026-05-28 cold-context login fails.
  // Bumped to TWO in-attempt reloads (2026-07-10): a single reload still
  // occasionally landed on a not-yet-slid-in form, so give it one more
  // fresh reload with a longer settle before burning the whole attempt.
  const IN_ATTEMPT_RELOADS = 2
  for (let reload = 1; !emailField && reload <= IN_ATTEMPT_RELOADS; reload++) {
    logger.warn(
      { url: page.url(), attempt, reload, of: IN_ATTEMPT_RELOADS },
      "admin login: email input invisible after wait — reloading and retrying in-attempt",
    )
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined)
    // Longer settle on each successive reload (4s, then 6s).
    await page.waitForTimeout(2_000 + reload * 2_000)
    emailField = await firstVisible(page, emailSelectors)
  }
  if (!emailField) {
    logger.warn({ url: page.url(), attempt }, "admin login: email input not found")
    return { ok: false, reason: `Email input not found at ${page.url()}` }
  }
  await emailField.fill(creds.email)

  const pwField = await firstVisible(page, [
    'input[data-cy="password-input"]',
    'input[formcontrolname="password"]',
    'input[type="password"]',
    'input[name*="password" i]',
    'input[id*="password" i]',
    'input[autocomplete="current-password"]',
  ])
  if (!pwField) {
    logger.warn("admin login: password input not found")
    return { ok: false, reason: "Password input not found on SureLC OAuth page" }
  }
  await pwField.fill(creds.password)

  // Capture what the AUTH CALL itself says, and any error the UI flashes.
  //
  // collectVisibleErrors() runs only after the 30s waitForURL below, by which
  // time a Material snackbar has long auto-dismissed — so it returned [] even
  // for a genuine "invalid credentials", the bounce got classified as the
  // transient datacenter-IP block, and the wrapper retried forever. That
  // misclassification is what hid the 2026-07-27 outage for 3 days.
  //
  // Watching the network instead is authoritative: SureLC's own response tells
  // us wrong-password vs locked vs rate-limited, and it can't dismiss itself.
  const authSignals: string[] = []
  const onResponse = (resp: {
    url: () => string
    status: () => number
    text: () => Promise<string>
  }) => {
    const u = resp.url()
    if (!/accounts\.surancebay\.com/.test(u)) return
    if (!/(token|login|auth|authorize|signin)/i.test(u)) return
    const status = resp.status()
    if (status < 400) return
    void resp
      .text()
      .then((body) => {
        authSignals.push(`${status} ${u.split("?")[0]} ${body.slice(0, 200).replace(/\s+/g, " ")}`)
      })
      .catch(() => {
        authSignals.push(`${status} ${u.split("?")[0]} (body unreadable)`)
      })
  }
  page.on("response", onResponse as any)
  // Snapshot any error the UI paints while we're still waiting, before it fades.
  const errorWatcher = page
    .waitForSelector("mat-error, .error, .alert, [role=alert], snack-bar-container, .mat-mdc-snack-bar-label", {
      timeout: 25_000,
      state: "visible",
    })
    .then((el) => el?.textContent())
    .then((t) => {
      const s = (t ?? "").trim()
      if (s) authSignals.push(`ui:${s}`)
    })
    .catch(() => undefined)

  const submit = await firstVisible(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("LOGIN")', // Material caps the visible text
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
  ])
  if (submit) {
    await submit.click().catch(() => {})
  } else {
    await pwField.press("Enter").catch(() => {})
  }

  // Wait for the URL to land on the actual BGA app — meaning OAuth
  // completed AND the SPA processed the callback. We accept any path
  // under surelc.surancebay.com/bga/ EXCEPT /bga/oauth which is the
  // intermediate callback handler. Stays on /oauth/authorize → login
  // failed (wrong creds, MFA needed, etc.).
  try {
    await page.waitForURL(
      (u) => isLoggedInBgaUrl(u.href),
      { timeout: 30_000 },
    )
  } catch {
    // Capture any visible error text so the timeline shows WHY login
    // bounced — "Invalid email or password" / "MFA required" / etc.
    // Without this the owner has to dig into Dokku logs to see what
    // SureLC is actually complaining about.
    await errorWatcher
    page.off("response", onResponse as any)
    // Late-collected DOM errors plus anything we caught live (network + the
    // snackbar before it faded). The live signals are the trustworthy ones.
    const errors = [...(await collectVisibleErrors(page)), ...authSignals]
    const finalUrl = page.url()

    // A FORCED PASSWORD CHANGE looks identical to a transient bounce: SureLC
    // renders no error text, so collectVisibleErrors comes back empty and we
    // parked on the OAuth page. That cost 3 days on 2026-07-27 — the bot
    // retried 6× per request forever, browsers piled up until the box was out
    // of memory, and every agent surfaced as "operation aborted due to
    // timeout" while the real cause was a password-expiry screen nobody could
    // see. Detect it explicitly, make it FATAL so the retry storm stops, and
    // say exactly what a human has to do.
    const passwordChange = await detectPasswordChangeScreen(page)
    if (passwordChange) {
      logger.error(
        { url: finalUrl, indicator: passwordChange, attempt },
        "admin login: SureLC is forcing a PASSWORD CHANGE on the bot service account",
      )
      return {
        ok: false,
        fatal: true,
        reason:
          `SureLC is forcing a password change on the bot service account. ` +
          `Set a new password at https://surelc.surancebay.com/bga/ and update ` +
          `SURELC_ADMIN_PASSWORD on s4l-production. Nothing will contract until then. ` +
          `(matched: ${passwordChange})`,
      }
    }

    logger.warn(
      { url: finalUrl, errors, attempt },
      "admin login: did not land on /bga/* — likely wrong credentials or MFA prompt",
    )
    const reason = errors.length
      ? `SureLC: ${errors.join(" / ")}`
      : looksLikeStillOnOauthForm(finalUrl)
        ? `Login bounced — still on OAuth page (${finalUrl}). Likely wrong email/password or MFA was enabled on the bot service account.`
        : `Login did not land on /bga/* (final URL: ${finalUrl}).`
    // Only an EXPLICIT credential / MFA error from SureLC is fatal. A
    // bounce with no error text is the transient bot-detection block we
    // want the wrapper to retry — not a dead-end.
    const fatal = errors.some((e) =>
      /invalid|incorrect|wrong|locked|disabled|mfa|verification|verify|two[-\s]?factor|authenticator/i.test(e),
    )
    // Transient bounce (bot-detection block, not a real cred/MFA error):
    // the page is now parked on the bounced OAuth authorize form. Don't
    // leave the next attempt to start from that stale, half-submitted
    // page — re-navigate fresh to the BGA entry URL so the wrapper's next
    // attempt begins from a clean OAuth handshake (2026-07-10). Fatal
    // failures skip this since the wrapper won't retry them anyway.
    if (!fatal) {
      await page
        .goto(BGA_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 })
        .catch(() => undefined)
    }
    return { ok: false, reason, fatal }
  }

  // Success path — drop the response listener (the browser is reused for the
  // rest of the run, so leaving it attached would keep buffering auth bodies).
  page.off("response", onResponse as any)

  // URL transitioned to /bga/* — but that's not a guarantee the SPA
  // actually stored OAuth tokens. The previous failure mode (owner-
  // reported 2026-05-05 21:56) was: bot reports "Logged in" because the
  // URL settled on /bga/home, then the very next goto to /bga/producers
  // bounces straight back to /oauth/authorize because no Bearer token
  // is in localStorage. Defensive checks below close that gap:
  //
  //   1. Wait up to 15 s for an OAuth token (id_token / access_token)
  //      to appear in localStorage. SureLC's SPA stores them under
  //      `sb:id_token` + `sb:refresh_token` (verified 2026-04-28).
  //   2. Probe the producers list with a goto. If the SPA bounces us
  //      back to accounts.surancebay.com or /bga/oauth, the session
  //      isn't real — fail the login with the actual final URL logged.
  const haveToken = await waitForBgaToken(page, 15_000)
  if (!haveToken) {
    const storageKeys = await page
      .evaluate(() => {
        const keys: string[] = []
        for (let i = 0; i < localStorage.length; i++) keys.push(`local:${localStorage.key(i)}`)
        for (let i = 0; i < sessionStorage.length; i++) keys.push(`session:${sessionStorage.key(i)}`)
        return keys
      })
      .catch(() => [] as string[])
    logger.warn(
      { url: page.url(), storageKeys, attempt },
      "admin login: URL on /bga/* but no OAuth token in storage — SPA did not finish auth",
    )
    return {
      ok: false,
      reason:
        `Logged-in URL but no OAuth token in storage (keys: ${storageKeys.join(", ") || "none"}). ` +
        `The SPA didn't finish authenticating — most likely the password is wrong or the account ` +
        `requires MFA. Reset the bot service account password in SureLC and update SURELC_ADMIN_PASSWORD.`,
    }
  }

  // Log the JWT claims for diagnostics, but do NOT use them to decide
  // whether login worked. Different SureLC accounts get different role
  // claim shapes (officeManager / agencyWorker / agencyAdmin / etc.)
  // and the same account that opens /bga/producers fine in a real
  // browser sometimes shows only "officeManager"+"agencyWorker" in
  // the bot's token. The owner verified manually 2026-05-06 with the
  // exact same credentials the bot uses — claims look "producer-only"
  // but /bga/producers loads with the full Add Producer / agency view.
  // So claims are NOT a reliable admin signal; record them and move on.
  const claims = await readBgaTokenClaims(page).catch(() => null)
  logger.info({ claims }, "admin login: token claims captured (informational)")

  // Wait for the SPA to fully bootstrap before returning. Without this,
  // the next phase's first hard navigation (page.goto /bga/producers)
  // races the SPA's auth-guard initialization and bounces back to OAuth
  // even though the session is valid (owner-observed 2026-05-06: bot
  // logs in fine, then 5 s later the next step fails with "BGA session
  // lost between login and addProducer"). Letting network settle and
  // giving the SPA an additional generous beat lets cookies + in-memory
  // auth context finish wiring up before downstream navigations land.
  await page
    .waitForLoadState("networkidle", { timeout: 15_000 })
    .catch(() => {})
  await page.waitForTimeout(4_000)
  return { ok: true }
}

/** Read whatever JWT is in localStorage / sessionStorage and decode its
 *  payload (no signature verification — we just want to inspect claims).
 *  Returns the first JWT-shaped value found, decoded. */
async function readBgaTokenClaims(page: Page): Promise<Record<string, any> | null> {
  const jwt = await page.evaluate(() => {
    const isJwtLike = (s: string) => s.split(".").length === 3 && s.length > 40
    const collect: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const v = localStorage.getItem(localStorage.key(i) || "") || ""
      if (isJwtLike(v)) collect.push(v)
      try {
        const o = JSON.parse(v)
        for (const key of ["access_token", "id_token", "accessToken", "idToken"]) {
          if (o && typeof o[key] === "string" && isJwtLike(o[key])) collect.push(o[key])
        }
      } catch {
        /* not JSON */
      }
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const v = sessionStorage.getItem(sessionStorage.key(i) || "") || ""
      if (isJwtLike(v)) collect.push(v)
    }
    return collect[0] || null
  })
  if (!jwt) return null
  try {
    const payload = jwt.split(".")[1]
    // Browser-safe base64url → base64 + decode
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
    const json = Buffer.from(padded, "base64").toString("utf8")
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** Collect the top mat-error / role=alert / snack-bar messages on the
 *  page so we can surface SureLC's own error copy back to the operator. */
async function collectVisibleErrors(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const out: string[] = []
      document
        .querySelectorAll(
          "mat-error, .error, .alert, [role=alert], snack-bar-container, .mat-mdc-snack-bar-label",
        )
        .forEach((el) => {
          const s = (el.textContent || "").trim()
          if (s) out.push(s)
        })
      return Array.from(new Set(out)).slice(0, 5)
    })
    .catch(() => [] as string[])
}

/**
 * Is SureLC showing a "you must change your password" wall?
 *
 * Checked three ways because SureLC gives us nothing to work with: no error
 * text and no distinctive status code. A URL match is the strongest signal; a
 * second password field (new + confirm) on a page we didn't land on is the
 * next; visible copy is the fallback. Returns the matched indicator so the
 * alert can say WHY we think so, rather than asserting it blindly.
 */
async function detectPasswordChangeScreen(page: Page): Promise<string | null> {
  try {
    const href = page.url()
    if (/(change|reset|expire|update)[-_]?password|password[-_]?(change|reset|expired|update)/i.test(href)) {
      return `url:${href}`
    }
    return await page.evaluate(() => {
      const PATTERNS =
        /(change|update|reset|create)\s+(your\s+)?password|password\s+(has\s+)?(expired|must\s+be\s+changed)|new\s+password|temporary\s+password/i
      // Two or more password inputs = new + confirm, i.e. a set-password form
      // rather than the single-field sign-in form.
      const pwFields = document.querySelectorAll('input[type="password"]')
      if (pwFields.length >= 2) return `form:${pwFields.length}-password-fields`
      const text = (document.body?.innerText ?? "").slice(0, 4000)
      const m = text.match(PATTERNS)
      return m ? `text:${m[0]}` : null
    })
  } catch {
    return null
  }
}

function looksLikeStillOnOauthForm(href: string): boolean {
  try {
    const u = new URL(href)
    return /accounts\.surancebay\.com$/.test(u.hostname) && /oauth\/authorize/.test(u.pathname)
  } catch {
    return false
  }
}

/**
 * Poll localStorage / sessionStorage for an OAuth token. Returns true as
 * soon as a JWT-shaped string is found under any key matching the SPA's
 * known token-key conventions (sb:id_token, *access*, *id_token*).
 */
async function waitForBgaToken(page: Page, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = await page
      .evaluate(() => {
        const isJwtLike = (s: string) => s.split(".").length === 3 && s.length > 40
        const all: Record<string, string> = {}
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i) || ""
          all[k] = localStorage.getItem(k) || ""
        }
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i) || ""
          all[k] = sessionStorage.getItem(k) || ""
        }
        for (const [k, v] of Object.entries(all)) {
          if (!v) continue
          if (/(?:^|:)id_token$/i.test(k) && isJwtLike(v)) return true
          if (/access(?:_?token)?/i.test(k) && isJwtLike(v)) return true
          // JSON-wrapped tokens (older SDK shape)
          try {
            const obj = JSON.parse(v)
            if (obj && typeof obj === "object") {
              if (typeof obj.access_token === "string" && isJwtLike(obj.access_token)) return true
              if (typeof obj.accessToken === "string" && isJwtLike(obj.accessToken)) return true
              if (typeof obj.id_token === "string" && isJwtLike(obj.id_token)) return true
            }
          } catch {
            /* not JSON */
          }
        }
        return false
      })
      .catch(() => false)
    if (found) return true
    await page.waitForTimeout(500)
  }
  return false
}

/**
 * True if the given URL is a "we're logged in and inside the BGA admin"
 * URL. Strict: must be on the surelc.surancebay.com host, path must
 * start with /bga/, and must NOT be /bga/oauth (the OAuth callback
 * handler). Anything else — including the OAuth authorize URL whose
 * redirect_uri query string contains "/bga/" — returns false.
 */
function isLoggedInBgaUrl(href: string): boolean {
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return false
  }
  if (u.hostname !== "surelc.surancebay.com") return false
  if (!u.pathname.startsWith("/bga")) return false
  if (/^\/bga\/oauth\b/.test(u.pathname)) return false
  if (/login|sign-?in/i.test(u.pathname)) return false
  return true
}
