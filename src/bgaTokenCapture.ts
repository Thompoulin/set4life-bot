/**
 * Drives a fresh Playwright session through the SureLC BGA portal OAuth2
 * authorization_code login and captures the resulting access_token +
 * refresh_token from the SPA's storage.
 *
 * Why this exists: `/contracting/*` endpoints (the agency LOA carrier
 * list lives there) require a Bearer JWT minted by the `bga` OAuth2
 * client. That client only authorizes `authorization_code` grant, the
 * SPA login is JS-only behind a bot-detection WAF, so curl can't drive
 * it. A real browser can — we already have one in this container.
 *
 * Caller passes a dedicated service-account user/pass. The function
 * returns whatever tokens it finds in localStorage/sessionStorage. The
 * main app caches the refresh_token and uses it via refresh_token grant
 * until it eventually rotates, then re-runs this capture.
 */
import { chromium, type Browser, type Page } from "playwright"
import { CHROMIUM_ARGS, launchChromium } from "./browserArgs.js"
import { tryReuseContext } from "./admin/sessionCache.js"
import pino from "pino"

const CAPTURE_CONTEXT_OPTIONS = {
  viewport: { width: 1280, height: 900 },
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}

export interface CaptureBgaTokensInput {
  email: string
  password: string
}

export interface CaptureBgaTokensResult {
  ok: boolean
  accessToken?: string
  refreshToken?: string
  expiresAt?: number // ms epoch (decoded from JWT exp)
  storageKeys?: string[]
  /** On failure: snapshot of localStorage/sessionStorage for diagnosis. */
  storageDump?: Record<string, string>
  finalUrl?: string
  /** URLs the page navigated through during capture. */
  urlHistory?: string[]
  error?: string
}

const ENTRY_URL =
  "https://surelc.surancebay.com/bga/agency/carriers/selected?search="

export async function captureBgaTokens(
  input: CaptureBgaTokensInput,
  logger: pino.Logger,
): Promise<CaptureBgaTokensResult> {
  const browser: Browser = await launchChromium(logger)
  const urlHistory: string[] = []
  try {
    const attachNavLogger = (page: Page) => {
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) {
          const u = frame.url()
          if (u && u !== "about:blank" && urlHistory[urlHistory.length - 1] !== u) {
            urlHistory.push(u)
            logger.info({ url: u }, "[bga-tokens] navigation")
          }
        }
      })
    }

    // Reuse the cached admin session when one is valid — the SPA only needs
    // to be authed for us to read its tokens; no fresh OAuth login needed.
    // Falls through to the full capture-login below on any miss/failure.
    const reused = await tryReuseContext(browser, input.email, logger, {
      contextOptions: CAPTURE_CONTEXT_OPTIONS,
    })
    if (reused) {
      attachNavLogger(reused.page)
      await reused.page
        .goto(ENTRY_URL, { waitUntil: "domcontentloaded", timeout: 45_000 })
        .catch(() => undefined)
      const reusedTokens = await waitForTokens(reused.page, logger)
      if (reusedTokens.accessToken) {
        return {
          ok: true,
          accessToken: reusedTokens.accessToken,
          refreshToken: reusedTokens.refreshToken,
          expiresAt: readJwtExpiry(reusedTokens.accessToken),
          storageKeys: reusedTokens.keys,
          finalUrl: reused.page.url(),
          urlHistory,
        }
      }
      // Cached session didn't yield tokens — discard it and do a full login.
      logger.warn("[bga-tokens] cached session yielded no tokens — full capture login")
      await reused.context.close().catch(() => undefined)
    }

    const ctx = await browser.newContext(CAPTURE_CONTEXT_OPTIONS)
    const page = await ctx.newPage()
    page.setDefaultTimeout(30_000)
    attachNavLogger(page)

    logger.info({ url: ENTRY_URL }, "[bga-tokens] navigating to entry URL")
    await page.goto(ENTRY_URL, { waitUntil: "domcontentloaded", timeout: 45_000 })

    await waitForLogin(page, logger)
    const ok = await tryLogin(page, input.email, input.password, logger)
    if (!ok) {
      return {
        ok: false,
        finalUrl: page.url(),
        urlHistory,
        error: "login form fill or submit failed",
      }
    }

    const tokens = await waitForTokens(page, logger)
    return {
      ok: !!tokens.accessToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.accessToken
        ? readJwtExpiry(tokens.accessToken)
        : undefined,
      storageKeys: tokens.keys,
      storageDump: tokens.storageDump,
      finalUrl: page.url(),
      urlHistory,
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

async function waitForLogin(page: Page, logger: pino.Logger): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < 25_000) {
    if (/accounts\.surancebay\.com/.test(page.url())) {
      const visibleInput = await page.$("input:visible").catch(() => null)
      if (visibleInput) {
        logger.info({ url: page.url() }, "[bga-tokens] login form visible")
        return
      }
    }
    await page.waitForTimeout(400)
  }
  logger.warn({ url: page.url() }, "[bga-tokens] no login form within 25s")
}

async function tryLogin(
  page: Page,
  email: string,
  password: string,
  logger: pino.Logger,
): Promise<boolean> {
  // Diagnostic: snapshot all inputs/buttons before we touch anything so a
  // failure tells us what selectors we'd need.
  const formShape = await page
    .evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input")).map(
        (el) => ({
          type: el.getAttribute("type"),
          name: el.getAttribute("name"),
          id: el.getAttribute("id"),
          autocomplete: el.getAttribute("autocomplete"),
          formControlName: el.getAttribute("formcontrolname"),
          placeholder: el.getAttribute("placeholder"),
          visible: !!(
            el.offsetWidth ||
            el.offsetHeight ||
            el.getClientRects().length
          ),
        }),
      )
      const buttons = Array.from(
        document.querySelectorAll("button, input[type=submit]"),
      ).map((el) => ({
        type: el.getAttribute("type"),
        text: (el.textContent || "").trim().slice(0, 40),
        id: el.getAttribute("id"),
        visible: !!(
          (el as HTMLElement).offsetWidth ||
          (el as HTMLElement).offsetHeight ||
          el.getClientRects().length
        ),
      }))
      return { inputs, buttons }
    })
    .catch(() => ({ inputs: [], buttons: [] }))
  logger.info({ formShape }, "[bga-tokens] form shape before fill")

  const emailField = await firstVisible(page, [
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[formcontrolname*="email" i]',
    'input[formcontrolname*="username" i]',
    'input[name*="email" i]',
    'input[name*="username" i]',
    'input[id*="email" i]',
    'input[id*="username" i]',
  ])
  if (!emailField) {
    logger.warn({ formShape }, "[bga-tokens] email input not found")
    return false
  }
  await emailField.fill(email)

  const pwField = await firstVisible(page, [
    'input[type="password"]',
    'input[autocomplete="current-password"]',
    'input[formcontrolname*="password" i]',
    'input[name*="password" i]',
    'input[id*="password" i]',
  ])
  if (!pwField) {
    logger.warn("[bga-tokens] password input not found")
    return false
  }
  await pwField.fill(password)

  // Confirm the field values stuck (Angular reactive forms sometimes
  // ignore programmatic input that doesn't fire the right events).
  const filledValues = await page
    .evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input"))
      return inputs.map((el) => ({
        type: el.getAttribute("type"),
        name: el.getAttribute("name"),
        valueLen: (el as HTMLInputElement).value.length,
      }))
    })
    .catch(() => [])
  logger.info({ filledValues }, "[bga-tokens] field values after fill")

  const urlBefore = page.url()
  // Anchor on the LOGIN text — the auth SPA renders an Angular Material
  // <button> with type=null (default submit inside a form). Material
  // capitalizes the visible text so case-insensitive has-text works.
  const loginBtn = page
    .locator('button:has-text("LOGIN"), button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Submit"), button[type="submit"]')
    .first()
  let clicked = false
  if (await loginBtn.count()) {
    try {
      await loginBtn.click({ timeout: 5_000 })
      clicked = true
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "[bga-tokens] login click threw")
    }
  }
  if (!clicked) {
    logger.info("[bga-tokens] no submit button matched; pressing Enter on password")
    await pwField.press("Enter").catch(() => {})
  }
  try {
    await page.waitForURL(
      (u) => !/accounts\.surancebay\.com\/oauth\/authorize/i.test(u.href),
      { timeout: 30_000 },
    )
    logger.info({ urlAfter: page.url() }, "[bga-tokens] navigated away from authorize")
    return true
  } catch {
    // Capture any visible error / status text on the page so the caller
    // can see why login bounced (wrong password, MFA required, etc.).
    const visibleText = await page
      .evaluate(() => {
        const t: string[] = []
        document
          .querySelectorAll("mat-error, .error, .alert, [role=alert], snack-bar-container")
          .forEach((el) => {
            const s = (el.textContent || "").trim()
            if (s) t.push(s)
          })
        // Fallback: also dump any visible <p> / <span> text on the page.
        if (t.length === 0) {
          document.querySelectorAll("body *").forEach((el) => {
            if (el.children.length > 0) return
            const s = (el.textContent || "").trim()
            if (s && s.length < 200 && /[a-z]/i.test(s)) t.push(s)
          })
        }
        return t.slice(0, 30)
      })
      .catch(() => [])
    logger.warn(
      { urlBefore, urlAfter: page.url(), visibleText },
      "[bga-tokens] still on /authorize after submit — login likely failed",
    )
    return false
  }
}

async function waitForTokens(
  page: Page,
  logger: pino.Logger,
): Promise<{
  accessToken?: string
  refreshToken?: string
  keys: string[]
  storageDump?: Record<string, string>
}> {
  const start = Date.now()
  let lastData: Record<string, string> = {}
  while (Date.now() - start < 60_000) {
    const data = await page
      .evaluate(() => {
        const dump: Record<string, string> = {}
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (!k) continue
          dump[`local:${k}`] = localStorage.getItem(k) || ""
        }
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i)
          if (!k) continue
          dump[`session:${k}`] = sessionStorage.getItem(k) || ""
        }
        // Cookies too — some SPAs put refresh in HttpOnly we can't see, but
        // any non-HttpOnly oauth-related cookie is worth surfacing.
        dump["__cookies"] = document.cookie
        return dump
      })
      .catch(() => ({}) as Record<string, string>)
    lastData = data
    const tokens = extractTokensFromStorage(data)
    if (tokens.accessToken) {
      logger.info(
        { storageKeys: Object.keys(data).length, hasRefresh: !!tokens.refreshToken },
        "[bga-tokens] captured tokens",
      )
      return { ...tokens, keys: Object.keys(data) }
    }
    await page.waitForTimeout(500)
  }
  // Failure path — return diagnostics so the caller can see what landed.
  // Truncate values so a JSON-stuffed token blob doesn't blow the log.
  const truncated: Record<string, string> = {}
  for (const [k, v] of Object.entries(lastData)) {
    truncated[k] = v.length > 400 ? `${v.slice(0, 400)}…(+${v.length - 400})` : v
  }
  return { keys: Object.keys(lastData), storageDump: truncated }
}

/**
 * Walk every storage value looking for JWT-shaped strings or known token
 * key patterns. SureLC's SPA (verified 2026-04-28) stores them under:
 *   local:sb:id_token       — Bearer JWT (used as access token)
 *   local:sb:refresh_token  — opaque refresh token
 * We also tolerate JSON-wrapped formats from older SDK versions.
 */
function extractTokensFromStorage(data: Record<string, string>): {
  accessToken?: string
  refreshToken?: string
} {
  let accessToken: string | undefined
  let refreshToken: string | undefined

  for (const [k, v] of Object.entries(data)) {
    if (!v) continue
    if (k === "__cookies") continue
    try {
      const obj = JSON.parse(v)
      if (obj && typeof obj === "object") {
        if (typeof obj.access_token === "string") accessToken ||= obj.access_token
        if (typeof obj.refresh_token === "string")
          refreshToken ||= obj.refresh_token
        if (typeof obj.accessToken === "string") accessToken ||= obj.accessToken
        if (typeof obj.refreshToken === "string")
          refreshToken ||= obj.refreshToken
      }
    } catch {
      /* not JSON */
    }
    // SureLC convention: sb:id_token holds the Bearer JWT, sb:refresh_token
    // holds the opaque refresh token. Match those plus generic fallbacks.
    if (!accessToken && /(?:^|:)id_token$/i.test(k) && isJwtLike(v))
      accessToken = v
    if (!accessToken && /access(?:_?token)?/i.test(k) && isJwtLike(v))
      accessToken = v
    if (!refreshToken && /refresh(?:_?token)?/i.test(k) && v.length >= 20)
      refreshToken = v
  }
  return { accessToken, refreshToken }
}

function isJwtLike(s: string): boolean {
  return s.split(".").length === 3 && s.length > 40
}

function readJwtExpiry(jwt: string): number | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64").toString("utf8"),
    ) as { exp?: number }
    return payload.exp ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

async function firstVisible(
  page: Page,
  selectors: string[],
): Promise<import("playwright").ElementHandle<SVGElement | HTMLElement> | null> {
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
