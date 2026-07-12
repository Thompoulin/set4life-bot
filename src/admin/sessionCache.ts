/**
 * Shared authenticated-session cache for the SureLC BGA admin portal.
 *
 * Why this exists (2026-07-10): EVERY bot server endpoint and both
 * botRunner phases previously did a full browser OAuth login
 * (`loginAdmin`) on every call — see the identical
 * `newContext()` + `loginAdmin()` pattern across src/server.ts and
 * src/botRunner.ts. On the Vultr datacenter IP that OAuth handshake
 * intermittently trips SureLC's bot-detection ("email input invisible",
 * "did not land on /bga/*") and burns many retries; doing it once per
 * call multiplies that flakiness and derails contracting runs.
 *
 * The fix: after the FIRST successful admin login, snapshot Playwright's
 * `storageState` (cookies + localStorage — which is where the SPA keeps
 * `sb:id_token` / `sb:refresh_token`, verified in login.ts + bgaTokenCapture.ts)
 * plus a decoded expiry, and REUSE it on subsequent calls by creating the
 * context WITH `{ storageState }`. A full `loginAdmin` only runs when the
 * cache is missing, expired, or fails a live verify.
 *
 * FAIL-SAFE INVARIANT (critical): any error or uncertainty on the reuse
 * path — verify throws, storageState fails to load, the SPA bounces us to
 * OAuth — MUST fall through to a normal full `loginAdmin`. This change can
 * NEVER be worse than the old behavior; worst case it logs in exactly like
 * before. We never return an unauthenticated page as if it were authed.
 *
 * This module does NOT touch loginAdmin's internals (its retry hardening
 * stays intact) — it only changes WHEN loginAdmin is called (skips it when
 * a valid cached session exists).
 */

import type { Browser, BrowserContext, Page } from "playwright"
import type pino from "pino"
import { loginAdmin, type LoginAdminResult } from "./login.js"

/** A live-in-container cache of the authenticated Playwright storageState.
 *  Stored as one atomic object so a concurrent reader can never observe a
 *  torn state (we only ever swap the whole reference, never mutate it). A
 *  stale-but-still-valid state being read by a parallel call is harmless —
 *  the reuse path re-verifies it live before trusting it. */
type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>

interface CachedSession {
  storageState: StorageState
  /** ms epoch after which we treat the session as expired and re-login. */
  expiresAt: number
  /** email the session was minted for — a creds change invalidates it. */
  email: string
}

let cached: CachedSession | null = null

/** Skew we require before `expiresAt` to still call a session "valid", so
 *  we never hand back a token that expires mid-operation. */
const EXPIRY_SKEW_MS = 60_000
/** Fallback lifetime when we can't decode the JWT `exp`. Kept short so a
 *  mis-decode just means we re-login a little more often — never that we
 *  reuse a dead session for long. */
const FALLBACK_TTL_MS = 8 * 60_000

/** Kill switch (2026-07-12): when BOT_DISABLE_SESSION_CACHE is set we NEVER
 *  reuse a cached session — always do a fresh loginAdmin, exactly like the
 *  pre-2026-07-10 behavior. The 2026-07-10 session-cache change broke
 *  admin_setup fleet-wide (52 agents): a reused session passed
 *  verifyAuthenticated AND add_producer, but bounced the affiliation /
 *  profile AG-Grid navigation and threw — because Playwright's storageState
 *  snapshots cookies + localStorage but NOT sessionStorage, which the SPA
 *  needs for in-app routing. Flip this env var on the dyno to recover
 *  immediately; no code redeploy needed to toggle it back. */
const SESSION_CACHE_DISABLED =
  process.env.BOT_DISABLE_SESSION_CACHE === "1" ||
  process.env.BOT_DISABLE_SESSION_CACHE === "true"

/** Options passed through to browser.newContext(), plus an optional list of
 *  init scripts (botRunner hides navigator.webdriver via addInitScript). */
export interface AuthContextOptions {
  /** Passed verbatim to browser.newContext() (viewport, userAgent, …). */
  contextOptions?: Parameters<Browser["newContext"]>[0]
  /** Init scripts to add to the context BEFORE any page loads (e.g. the
   *  navigator.webdriver patch). Applied to both the reuse and login paths
   *  so behavior is identical whichever branch runs. */
  initScripts?: Array<() => void>
  /** Default page timeout (ms). Matches the callers' page.setDefaultTimeout. */
  defaultTimeout?: number
}

export interface GetAuthenticatedPageResult {
  context: BrowserContext
  page: Page
  /** True when we reused a cached session (NO OAuth login happened). */
  reused: boolean
  /** Present only when a full loginAdmin ran (reused === false). Lets the
   *  caller preserve its existing fatal-vs-transient short-circuit. */
  loginResult?: LoginAdminResult
}

/**
 * Return a BrowserContext + Page that is authenticated to the BGA admin,
 * reusing a cached session when one is valid and verifiable, otherwise
 * falling back to a full `loginAdmin`.
 *
 * On the reuse path we return `{ reused: true }` with NO loginResult. On the
 * login path we return `{ reused: false, loginResult }` — the caller MUST
 * check `loginResult.ok` exactly as it did before (fatal short-circuit etc.).
 *
 * The caller owns the returned context's lifecycle (it should still
 * `browser.close()` / `context.close()` in its finally, exactly as today).
 */
export async function getAuthenticatedPage(
  browser: Browser,
  adminCreds: { email: string; password: string },
  logger: pino.Logger,
  opts: AuthContextOptions = {},
): Promise<GetAuthenticatedPageResult> {
  const timeout = opts.defaultTimeout ?? 30_000

  // ── Reuse path ────────────────────────────────────────────────────
  // Snapshot the cache reference once (atomic read) so a concurrent
  // invalidate/refresh can't tear it mid-check.
  const snapshot = cached
  if (
    !SESSION_CACHE_DISABLED &&
    snapshot &&
    snapshot.email === adminCreds.email &&
    Date.now() < snapshot.expiresAt - EXPIRY_SKEW_MS
  ) {
    let context: BrowserContext | undefined
    try {
      context = await browser.newContext({
        ...opts.contextOptions,
        storageState: snapshot.storageState,
      })
      for (const script of opts.initScripts ?? []) {
        await context.addInitScript(script)
      }
      const page = await context.newPage()
      page.setDefaultTimeout(timeout)
      const valid = await verifyAuthenticated(page, logger)
      if (valid) {
        logger.info("admin session: reused cached BGA session (no OAuth login)")
        return { context, page, reused: true }
      }
      // Verify failed — the cached session is stale/rejected. Discard the
      // context and fall through to a full login below.
      logger.warn("admin session: cached session failed live verify — re-logging in")
      invalidateSession()
      await context.close().catch(() => undefined)
    } catch (err: any) {
      // ANY error on the reuse path (bad storageState, verify threw, etc.)
      // falls through to a normal full login. Never worse than today.
      logger.warn(
        { err: err?.message },
        "admin session: reuse path errored — falling back to full login",
      )
      invalidateSession()
      if (context) await context.close().catch(() => undefined)
    }
  }

  // ── Login path (fallback / cold cache) ────────────────────────────
  // Exactly the old behavior: fresh context + full loginAdmin. On success
  // we snapshot the storageState + decoded expiry into the cache.
  const context = await browser.newContext(opts.contextOptions)
  for (const script of opts.initScripts ?? []) {
    await context.addInitScript(script)
  }
  const page = await context.newPage()
  page.setDefaultTimeout(timeout)
  const loginResult = await loginAdmin(page, adminCreds, logger)
  if (loginResult.ok && !SESSION_CACHE_DISABLED) {
    try {
      const storageState = await context.storageState()
      cached = {
        storageState,
        expiresAt: computeExpiry(storageState),
        email: adminCreds.email,
      }
      logger.info(
        { expiresInMs: cached.expiresAt - Date.now() },
        "admin session: cached authenticated storageState for reuse",
      )
    } catch (err: any) {
      // Failing to snapshot the state is non-fatal — this call still has a
      // valid logged-in page; we just won't have anything to reuse next time.
      logger.warn(
        { err: err?.message },
        "admin session: failed to snapshot storageState (login still valid)",
      )
    }
  }
  return { context, page, reused: false, loginResult }
}

/** Clear the cached session so the next getAuthenticatedPage() does a full
 *  login. Call this if a downstream op detects it was bounced to OAuth
 *  mid-run (the cached token was revoked / rotated under us). */
export function invalidateSession(): void {
  cached = null
}

/**
 * Best-effort: build an authenticated context+page from the cached session
 * for a caller that only needs an already-authed SPA (e.g. captureBgaTokens
 * reading tokens out of localStorage). Returns null when there's no valid
 * cache OR the live verify fails — the caller then does its own full login.
 * NEVER returns an unauthenticated page as if authed. On any error the
 * cache is invalidated and null is returned (fail-safe).
 */
export async function tryReuseContext(
  browser: Browser,
  email: string,
  logger: pino.Logger,
  opts: AuthContextOptions = {},
): Promise<{ context: BrowserContext; page: Page } | null> {
  const snapshot = cached
  if (
    SESSION_CACHE_DISABLED ||
    !snapshot ||
    snapshot.email !== email ||
    Date.now() >= snapshot.expiresAt - EXPIRY_SKEW_MS
  ) {
    return null
  }
  let context: BrowserContext | undefined
  try {
    context = await browser.newContext({
      ...opts.contextOptions,
      storageState: snapshot.storageState,
    })
    for (const script of opts.initScripts ?? []) {
      await context.addInitScript(script)
    }
    const page = await context.newPage()
    page.setDefaultTimeout(opts.defaultTimeout ?? 30_000)
    if (await verifyAuthenticated(page, logger)) {
      logger.info("admin session: reusing cached session for token capture")
      return { context, page }
    }
    invalidateSession()
    await context.close().catch(() => undefined)
    return null
  } catch (err: any) {
    logger.warn({ err: err?.message }, "admin session: tryReuseContext errored — full capture login")
    invalidateSession()
    if (context) await context.close().catch(() => undefined)
    return null
  }
}

/**
 * Lightweight live check that a page carrying the cached session is really
 * authenticated: hard-navigate to the producers list and confirm we land on
 * a /bga/* app URL (NOT bounced to accounts.surancebay.com / /bga/oauth) AND
 * that a BGA OAuth token is present in localStorage. Self-contained so we
 * don't have to change/export login.ts internals. Any throw → treated as
 * "not verified" by the caller (which falls back to full login).
 */
async function verifyAuthenticated(page: Page, logger: pino.Logger): Promise<boolean> {
  try {
    await page.goto("https://surelc.surancebay.com/bga/producers", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    })
    // Give the SPA's auth guard a beat to bounce us if the session is dead.
    await page.waitForTimeout(1_500)
    if (!isLoggedInBgaUrl(page.url())) {
      logger.warn({ url: page.url() }, "admin session: verify — not on a /bga/* app URL")
      return false
    }
    const hasToken = await hasBgaToken(page)
    if (!hasToken) {
      logger.warn("admin session: verify — no BGA token in storage")
      return false
    }
    return true
  } catch (err: any) {
    logger.warn({ err: err?.message }, "admin session: verify threw — treating as not authed")
    return false
  }
}

/** True if href is a logged-in BGA app URL (mirrors login.ts's strict
 *  check: surelc host, /bga/ path, not the /bga/oauth callback, not a
 *  login/sign-in route). Kept local so login.ts stays untouched. */
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

/** True if a JWT-shaped OAuth token is present in localStorage/sessionStorage
 *  (SureLC keeps `sb:id_token` in localStorage). Mirrors login.ts's token
 *  probe but as a single one-shot read. */
async function hasBgaToken(page: Page): Promise<boolean> {
  return page
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
}

/**
 * Decode the earliest JWT `exp` we find in the cached storageState's
 * localStorage (the SPA stores `sb:id_token` there) and return it as an ms
 * epoch. Falls back to now + FALLBACK_TTL_MS when nothing is decodable, so
 * an undecodable token just means we re-login a bit sooner — never that we
 * trust a dead session.
 */
function computeExpiry(state: StorageState): number {
  const now = Date.now()
  try {
    let earliest: number | undefined
    for (const origin of state.origins ?? []) {
      for (const item of origin.localStorage ?? []) {
        const exp = readJwtExpiryMs(item.value)
        if (exp !== undefined && (earliest === undefined || exp < earliest)) {
          earliest = exp
        }
      }
    }
    if (earliest !== undefined && earliest > now) return earliest
  } catch {
    /* fall through to fallback */
  }
  return now + FALLBACK_TTL_MS
}

/** Decode a JWT's `exp` claim to ms epoch; undefined if the value isn't a
 *  JWT or has no exp. Uses base64url-safe decode. */
function readJwtExpiryMs(value: string): number | undefined {
  if (value.split(".").length !== 3) return undefined
  try {
    const b64 = value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as {
      exp?: number
    }
    return payload.exp ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}
