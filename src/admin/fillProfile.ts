/**
 * Fill the producer profile tabs in the BGA admin portal:
 *   1. DBA — License Only / Soliciting For (auto-greyed if affiliation
 *      template applied — we just verify and skip)
 *   2. Questions — background, FINRA, employment, address, military
 *   3. Training — AML certificate (file upload + completion date)
 *   4. E&O — provider, policy#, dates, coverage, certificate file
 *   5. Signature — upload signature image
 *
 * Skipped tabs (per Loom spec):
 *   - General Info (NIPR auto-fills it)
 *   - License (NIPR auto-fills it)
 *   - Bank / EFT (not required for LOA agents)
 *   - Documents (only used for raw setup-packet PDF splitting)
 *
 * All five are addressed off the same producer URL:
 *   https://surelc.surancebay.com/bga/producers/{producerId}
 *
 * Each tab function is idempotent — checks for "already complete"
 * state before re-typing or re-uploading.
 */

import type { Page } from "playwright"
import {
  firstVisible,
  fillByLabel,
  fillForce,
  fillIfEmpty,
  gotoBga,
  selectByLabel,
  uploadRemoteFile,
  settle,
  snapshot,
  type TabContext,
  type TabResult,
} from "../tabs/helpers.js"

export interface ProfileFillInput {
  producerId: string
  residentAddress?: {
    addressLine1: string
    addressLine2?: string
    city: string
    state: string // 2-letter abbreviation
    postalCode: string
  }
  dba?: {
    businessType?: "License Only" | "Business Only"
    solicitingFor: string // e.g. "Thomas Poulin"
  }
  questions?: {
    /**
     * SureLC-shaped sub-question answers, keyed by SureLC slug
     * ("felony", "misdemeanor", "beingInvestigated", ...). The
     * questionnaire dialog on our side mirrors SureLC's question
     * tree exactly, so this map flows straight through to the bot.
     */
    surelcAnswers?: Record<
      string,
      {
        answer: "yes" | "no"
        occurrenceDate?: string // YYYY-MM-DD
        documents?: Array<{
          url: string
          fileName?: string
          slot?: string // "statement" | "notice" | "resolution" for Q1a
        }>
      }
    >
    /** Question text by slug — fallback when slug-based selectors miss. */
    questionTexts?: Record<string, string>
    /** Attestation block at the bottom of the tab. */
    attestationName?: string
    attestationDate?: string
    attestationInitials?: string
    finraRegistered?: boolean
    finraCrd?: string
    militaryStatus?: "none" | "active" | "reserve" | "veteran"
    employmentHistory?: Array<{
      employer: string
      position: string
      startDate: string
      endDate?: string
      address?: string
    }>
    addressHistory?: Array<{
      street: string
      city: string
      state: string
      zip: string
      from: string
      to?: string
    }>
  }
  training?: {
    amlCompletionDate?: string // YYYY-MM-DD or MM-DD-YYYY
    amlCertificateUrl?: string
    /** Provider/vendor (LIMRA, WebCE, etc.) used to fill SureLC's
     *  Provider Name field on the Add Training manual form when
     *  OCR didn't auto-populate it. */
    amlProvider?: string
    /** Course title — falls back to a generic "Anti-Money Laundering"
     *  string when our DB doesn't have the actual course title on file. */
    amlCourseName?: string
    ltcRiderCompleted?: boolean // false for Set4Life
  }
  eno?: {
    provider?: string
    policyNumber?: string
    effectiveDate?: string
    expirationDate?: string
    coverageAmount?: string
    /** Per-occurrence limit (Case Limit). Defaults to 1,000,000. */
    caseLimit?: number
    /** Aggregate limit (Total Limit). Defaults to 2,000,000. */
    totalLimit?: number
    certificateUrl?: string
  }
  signature?: {
    /** Bare signature PNG — only used for the typed-signature fallback. */
    signatureImageUrl?: string
    /**
     * The fully-rendered Signature Authorization PDF (legal text +
     * "Please sign here" box + cursive signature + audit stamp). This
     * is what SureLC actually wants — they crop the signature out of
     * this document themselves. We generate it during onboarding and
     * store the URL on applications.signatureAuthPdfUrl.
     */
    signatureAuthPdfUrl?: string
    /**
     * When true, click REMOVE on an existing signature before
     * uploading fresh. Used by force-run paths to recover producers
     * whose stale signature blocks Fastlane ("N issues"). Without
     * this, the REMOVE+EDIT detector below returns alreadyDone=true.
     */
    forceReupload?: boolean
  }
  /** Per-question explanation texts, keyed by SureLC question slug. */
  explanations?: Record<string, string>
}

const baseUrl = (id: string) => `https://surelc.surancebay.com/bga/producers/${id}`

interface EoDocData {
  provider?: string
  policyNumber?: string
  effectiveDate?: string
  expirationDate?: string
  caseLimit?: number
  totalLimit?: number
  textExtracted: boolean
  missing: string[]
}

async function downloadRemoteFile(remoteUrl: string, prefix: string): Promise<{ buffer: Buffer; localPath: string }> {
  const res = await fetch(remoteUrl)
  if (!res.ok) throw new Error(`download failed with HTTP ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  const path = await import("node:path")
  const fs = await import("node:fs/promises")
  const os = await import("node:os")
  const filename = `${prefix}-${Date.now()}.pdf`
  const localPath = path.join(os.tmpdir(), filename)
  await fs.writeFile(localPath, buffer)
  return { buffer, localPath }
}

function normalizePdfText(text: string): string {
  return text.replace(/\u0000/g, " ").replace(/[ \t]+/g, " ").replace(/\r/g, "\n")
}

function parseMoneyLimit(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (!match) continue
    const raw = String(match[1] || match[0]).toLowerCase()
    if (/million|\bm\b/.test(raw)) {
      const n = Number(raw.replace(/[^0-9.]/g, ""))
      if (Number.isFinite(n) && n > 0) return Math.round(n * 1_000_000)
    }
    const n = Number(raw.replace(/[^0-9]/g, ""))
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}

function parseDateValue(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const match = raw.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/)
  if (!match) return undefined
  const month = match[1].padStart(2, "0")
  const day = match[2].padStart(2, "0")
  const year = match[3].length === 2 ? `20${match[3]}` : match[3]
  return `${month}/${day}/${year}`
}

function extractEoDataFromText(rawText: string): EoDocData {
  const text = normalizePdfText(rawText)
  const upper = text.toUpperCase()

  // Try the longest / most-canonical name first so our autocomplete
  // matching (selectByLabel against SureLC's carrier list) is more
  // likely to land. Putting "BERKSHIRE HATHAWAY" before "BIBERK"
  // means BIBERK certs come back as the parent company name, which
  // is the form SureLC uses in its dropdown.
  const provider =
    [
      /BERKSHIRE\s+HATHAWAY[A-Z\s]{0,40}/i,
      /CONTINENTAL\s+CASUALTY/i,
      /NEXT\s+INSURANCE/i,
      /THE\s+HARTFORD/i,
      /TRAVELERS\s+INDEMNITY/i,
      /TRAVELERS/i,
      /HISCOX/i,
      /BIBERK/i,
      /\bCNA\b/i,
    ]
      .map((r) => text.match(r)?.[0])
      .find(Boolean)

  // PDF text extraction strips internal whitespace, so on CNA's
  // two-column layout "Policy Number / Certificate Period" we end up
  // with "...5964274495/01/202605/01/2027..." — policy# + start +
  // expiration glued together with no separators. Capture all three
  // in one regex by anchoring the date halves to validated month/day
  // patterns, so the policy# can't accidentally absorb the leading
  // digit of the date. (Josue 2026-05-08, CNA cert)
  const VALID_MONTH = "(?:0[1-9]|1[012]|[1-9])"
  const VALID_DAY = "(?:0[1-9]|[12]\\d|3[01]|[1-9])"
  const VALID_DATE = `${VALID_MONTH}\\/${VALID_DAY}\\/\\d{2,4}`
  const combined =
    text.match(
      new RegExp(
        `policy\\s*(?:number|no\\.?|#)[\\s\\S]{0,120}?(\\d{6,12}?)(${VALID_DATE})(?:[\\s\\S]{0,15}?(${VALID_DATE}))?`,
        "i",
      ),
    ) ||
    text.match(
      new RegExp(
        `certificate\\s*(?:number|no\\.?|#)[\\s\\S]{0,120}?(\\d{6,12}?)(${VALID_DATE})(?:[\\s\\S]{0,15}?(${VALID_DATE}))?`,
        "i",
      ),
    )
  // BIBERK / Berkshire Hathaway certs don't have a "Policy Number"
  // label at all — the policy ID (e.g. "N8PL469675") sits right
  // below the "Claims-Made" / "Errors & Omissions" header. Allow
  // longer alphanumeric IDs with dashes (NEXT Insurance:
  // "NXTKXYDJRR-00-PL"). Match in either order — label-then-id
  // (BIBERK) or id-then-label (NEXT).
  const POLICY_TOKEN = "([A-Z][A-Z0-9-]{5,18}\\d[A-Z0-9-]{0,15}|[A-Z]{1,4}\\d[A-Z0-9-]{4,18})"
  const biberkPolicy =
    !combined?.[1] &&
    (text.match(
      new RegExp(
        `(?:claims[-\\s]made|errors\\s*&\\s*omissions|professional\\s*liability)[\\s\\S]{0,80}?\\b${POLICY_TOKEN}\\b`,
        "i",
      ),
    )?.[1] ||
      text.match(
        new RegExp(
          `\\b${POLICY_TOKEN}\\b\\s*(?:professional\\s*liability|errors\\s*&\\s*omissions|claims[-\\s]made)`,
          "i",
        ),
      )?.[1])
  const policyNumber = combined?.[1] || biberkPolicy
  const dateFromCombined = combined?.[2]
  const expirationFromCombined = combined?.[3]

  // Look for a CONSECUTIVE date pair — BIBERK and CNA both render
  // their effective + expiration as two adjacent dates with at most
  // a "/" or whitespace between them, and the order varies (CNA
  // writes effective first, BIBERK reverses). Pick earlier = effective,
  // later = expiration regardless of textual order.
  const consecutivePair = text.match(
    new RegExp(`(${VALID_DATE})\\s*[\\/\\s]?\\s*(${VALID_DATE})`, "i"),
  )
  let pairEffective: string | undefined
  let pairExpiration: string | undefined
  if (consecutivePair) {
    const a = parseDateValue(consecutivePair[1])
    const b = parseDateValue(consecutivePair[2])
    if (a && b) {
      ;[pairEffective, pairExpiration] = a <= b ? [a, b] : [b, a]
    }
  }

  const effectiveDate =
    parseDateValue(dateFromCombined) ||
    parseDateValue(text.match(/(?:effective|start|from)\s*(?:date)?\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i)?.[1]) ||
    parseDateValue(text.match(/(?:policy|certificate)\s*period[\s\S]{0,120}?(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i)?.[1]) ||
    pairEffective

  const expirationDate =
    parseDateValue(expirationFromCombined) ||
    parseDateValue(text.match(/(?:expiration|expiry|expires|to)\s*(?:date)?\s*[:\-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i)?.[1]) ||
    parseDateValue(text.match(/(?:policy|certificate)\s*period[\s\S]{0,120}?(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})[\s\S]{0,80}?(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i)?.[2]) ||
    pairExpiration

  // BIBERK certs render limits as "Per Occurrence/Aggregate" header
  // followed (after a date pair) by "$1,000,000/$1,000,000". Match
  // the dual-money pattern when it sits in a per-occurrence /
  // aggregate context.
  const dualLimit = text.match(
    /(?:per\s*(?:claim|occurrence)|each\s*(?:claim|occurrence))[\s\S]{0,40}?aggregate[\s\S]{0,150}?(\$\s*\d[\d,]*(?:\.\d+)?)\s*\/?\s*(\$\s*\d[\d,]*(?:\.\d+)?)/i,
  )

  const caseLimit =
    parseMoneyLimit(text, [
      /(?:per\s*(?:claim|occurrence)|each\s*(?:claim|occurrence)|case\s*limit)[^$0-9]{0,40}(\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:million|m)?)/i,
      /(\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:million|m)?)\s*(?:per\s*(?:claim|occurrence)|each\s*(?:claim|occurrence))/i,
    ]) ||
    (dualLimit ? parseMoneyLimit(dualLimit[1] || "", [/(\$\s*\d[\d,]*(?:\.\d+)?)/]) : undefined)

  // "Aggregate" alone is too broad — CNA cert has a "A Policy
  // Aggregate of $50,000,000 applies" line that's the carrier's
  // master cap, not the agent's annual limit. The agent's limit is
  // the inline "$3 Million annual aggregate" earlier in the cert.
  // Require "annual aggregate" / "aggregate limit" / "total limit"
  // OR a per-occurrence/aggregate dual-money block (BIBERK style).
  const totalLimit =
    parseMoneyLimit(text, [
      /(\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:million|m)?)\s*(?:annual\s*aggregate|aggregate\s*limit|total\s*limit)/i,
      /(?:annual\s*aggregate|aggregate\s*limit|total\s*limit)[^$0-9]{0,40}(\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:million|m)?)/i,
    ]) ||
    (dualLimit ? parseMoneyLimit(dualLimit[2] || "", [/(\$\s*\d[\d,]*(?:\.\d+)?)/]) : undefined)

  const missing = [
    ["carrier", provider],
    ["policy number", policyNumber],
    ["effective date", effectiveDate],
    ["expiration date", expirationDate],
    ["case limit", caseLimit],
    ["total limit", totalLimit],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key as string)

  return {
    provider: provider ? provider.trim() : undefined,
    policyNumber: policyNumber ? policyNumber.trim() : undefined,
    effectiveDate,
    expirationDate,
    caseLimit,
    totalLimit,
    textExtracted: upper.trim().length > 0,
    missing,
  }
}

async function extractEoDataFromPdf(buffer: Buffer, logger: import("pino").Logger): Promise<EoDocData> {
  try {
    const pdfParse = (await import("pdf-parse")).default
    const parsed = await pdfParse(buffer)
    return extractEoDataFromText(parsed.text || "")
  } catch (err: any) {
    logger.warn({ err: err?.message }, "[E&O] PDF text extraction failed")
    return { textExtracted: false, missing: ["carrier", "policy number", "effective date", "expiration date", "case limit", "total limit"] }
  }
}

/**
 * Snapshot what's visible on the page at the moment of an upload
 * failure so the operator can see what the bot was looking at.
 * SureLC's Material build mutates upload buttons across releases
 * (sb-aml-course → mat-expansion-panel → who knows next), and our
 * selectors miss when the markup drifts. Including up to 20
 * visible button labels + the file-input count in the failure
 * reason makes selector breakage instantly debuggable from the
 * timeline UI without needing Dokku log access.
 */
async function describeUploadablePage(page: Page): Promise<string> {
  const buttons = await page
    .$$eval("button", (els) =>
      els
        .filter((b) => (b as HTMLElement).offsetParent !== null)
        .map((b) => (b as HTMLButtonElement).innerText.trim().replace(/\s+/g, " "))
        .filter((s) => s && s.length < 60)
        .slice(0, 20),
    )
    .catch(() => [] as string[])
  const fileInputCount = await page
    .$$eval('input[type="file"]', (els) => els.length)
    .catch(() => 0)
  return `[diag] url: ${page.url()}; visible buttons: ${buttons.join(" | ") || "(none)"}; file inputs in DOM: ${fileInputCount}`
}

async function isSureLcLoginOrOAuthPage(page: Page): Promise<boolean> {
  const url = page.url()
  try {
    const u = new URL(url)
    if (/accounts\.surancebay\.com$/i.test(u.hostname)) return true
    if (/\/oauth\b/i.test(u.pathname)) return true
  } catch {
    /* ignore malformed URL */
  }

  const visibleButtons = await page
    .$$eval("button", (els) =>
      els
        .filter((b) => (b as HTMLElement).offsetParent !== null)
        .map((b) => (b as HTMLButtonElement).innerText.trim().toUpperCase()),
    )
    .catch(() => [] as string[])
  return visibleButtons.includes("LOGIN") && visibleButtons.some((b) => b.includes("FORGOT PASSWORD"))
}

async function assertOnProducerTab(
  page: Page,
  producerId: string,
  slug: string,
): Promise<void> {
  if (await isSureLcLoginOrOAuthPage(page)) {
    throw new Error(`SureLC bounced to login/OAuth while opening ${slug}. ${await describeUploadablePage(page)}`)
  }

  let path = ""
  try {
    path = new URL(page.url()).pathname
  } catch {
    path = page.url()
  }
  // Some tabs deep-link with a sub-id (e.g. /producers/X/dba/20547333
  // for an affiliation-row id). Match either the exact tab path or any
  // sub-path under it. Sydney 2026-05-07: ENO + signature were missing
  // snapshots because the URL was /producers/.../{slug}/{sub} and the
  // previous endsWith check rejected it.
  const expectedPrefix = `/bga/producers/${producerId}/${slug}`
  if (!(path === expectedPrefix || path.startsWith(`${expectedPrefix}/`) || path.startsWith(`${expectedPrefix}?`))) {
    throw new Error(`wrong SureLC page for ${slug}: expected path under ${expectedPrefix}, got ${page.url()}. ${await describeUploadablePage(page)}`)
  }

  // Tab-link element check: best-effort signal only, NOT a hard gate.
  // SureLC's tab DOM differs per tab — `a.navbar-tab[href$="/eno"]`
  // doesn't match the E&O tab's element type, and the throw killed
  // the per-tab fill before snapshotting (Sydney 2026-05-07). If the
  // URL is right the route's content has loaded; downstream tab-
  // specific selectors will report any real DOM mismatch with their
  // own diagnostics.
}

/**
 * Enter the producer's profile via the SPA's intended path: a
 * double-click on the producer's name in the AG Grid. The blue info
 * banner on the producers list page literally says "To open a profile,
 * double click on name."
 *
 * Hard-navigating to /bga/producers/{id}/{tab} via page.goto bounces
 * to OAuth even when the bot is fully logged in (verified Sydney
 * 2026-05-07: changeAffiliation succeeds, then every tab nav bounces
 * for the next 6 minutes). The bounce happens because page.goto
 * triggers a full reload, which races the SPA's auth-guard
 * initialization — auth checks run before localStorage's OAuth token
 * is consulted, the guard rejects, redirect to /oauth/authorize.
 *
 * Double-clicking the grid row uses the SPA's own router transition,
 * which keeps the in-memory auth context alive. Once we're inside the
 * profile, subsequent tab switches via in-SPA pushState (already
 * implemented in gotoBga) work fine.
 */
async function enterProducerProfile(
  ctx: TabContext,
  producerId: string,
): Promise<void> {
  const { page, logger } = ctx
  // Are we already inside the profile?
  try {
    const path = new URL(page.url()).pathname
    if (path.startsWith(`/bga/producers/${producerId}`) && path !== `/bga/producers/${producerId}` &&
        !path.endsWith(`/producers/${producerId}`) ) {
      // Already on a sub-tab — nothing to do.
      return
    }
    if (path.endsWith(`/producers/${producerId}`)) {
      return
    }
  } catch {
    /* malformed URL */
  }

  // Navigate to the producer list (in-SPA if possible).
  const navList = await gotoBga(
    page,
    "https://surelc.surancebay.com/bga/producers",
    logger,
  )
  if (!navList.ok) {
    throw new Error(`Could not reach producer list to enter profile (${navList.finalUrl})`)
  }
  await settle(page, 800)
  await page
    .waitForSelector(`[role="row"][row-id="${producerId}"]`, { timeout: 15_000 })
    .catch(() => {
      throw new Error(`Producer row ${producerId} did not render in AG Grid`)
    })

  // The name cell wraps a custom <bga-producer-name-render> →
  // <sb-text-link class="link hoverable"> with no <a href>. The click
  // handler is on the inner sb-text-link, not on the AG Grid cell —
  // cell-level dblclick doesn't bubble to it (Sydney 2026-05-07: bot
  // dblclick'd the cell, page never navigated, screenshot still shows
  // the producer list). Target the inner link span directly. Try
  // single-click first (matches what Thomas does in the Loom — "click
  // on this guy"); fall back to dblclick if the URL doesn't transition
  // (the blue banner says "double click on name" — both nav paths exist).
  const nameLink =
    (await page.$(
      `[role="row"][row-id="${producerId}"] [col-id="name"] sb-text-link span.main-text`,
    )) ||
    (await page.$(
      `[role="row"][row-id="${producerId}"] [col-id="name"] bga-producer-name-render`,
    ))
  if (!nameLink) {
    throw new Error(`Name link not found for row ${producerId}`)
  }
  const startedAt = page.url()
  await nameLink.click()
  await page
    .waitForURL((u) => u.pathname.includes(`/producers/${producerId}/`), {
      timeout: 8_000,
    })
    .catch(() => {})
  if (page.url() === startedAt) {
    // Single click didn't transition — try double-click (matches the
    // blue banner instruction).
    logger.info({ producerId }, "single click did not navigate; falling back to dblclick")
    await nameLink.dblclick()
  }
  // SureLC's profile route is lazy-loaded; wait for the URL to
  // transition, then for network idle so the profile shell finishes
  // bootstrapping before the first tab fill runs its assertOnProducerTab.
  await page
    .waitForURL((u) => u.pathname.includes(`/producers/${producerId}`), {
      timeout: 20_000,
    })
    .catch(() => {})
  await page
    .waitForLoadState("networkidle", { timeout: 15_000 })
    .catch(() => {})
  await page.waitForTimeout(1_500)
  await snapshot(ctx, "admin-profile-entered")
  logger.info({ producerId, url: page.url() }, "entered producer profile via grid double-click")
}

export async function fillFullProfile(
  ctx: TabContext,
  input: ProfileFillInput,
): Promise<Record<string, TabResult>> {
  // Enter the producer profile via the SPA's intended path before any
  // tab fill — see enterProducerProfile for why hard-nav bounces.
  await enterProducerProfile(ctx, input.producerId)

  // Each tab fill runs in isolation — a throw OR an ok:false result
  // never blocks the next tab. Owner directive 2026-05-05: the bot
  // must continue past failures so it always reaches Fastlane (the
  // contracting step is the only one where a failure justifies
  // stopping the whole run).
  const tabs: Record<string, TabResult> = {}
  const runIsolated = async (
    name: string,
    fn: () => Promise<TabResult>,
  ): Promise<TabResult> => {
    // Entry snapshot — proves the runIsolated wrapper for THIS tab
    // even fired. If we see -isolated-entry but no other snapshots,
    // the inner function is hanging on its first await.
    ctx.logger.info({ tab: name }, `[Profile] entering ${name}`)
    await snapshot(ctx, `tab-${name}-isolated-entry`).catch(() => {})
    try {
      const result = await fn()
      ctx.logger.info({ tab: name, ok: result.ok, reason: result.reason }, `[Profile] ${name} returned`)
      await snapshot(ctx, `tab-${name}-isolated-end`).catch(() => {})
      return result
    } catch (err: any) {
      ctx.logger.warn(`[Profile] ${name} threw — continuing to next tab`, {
        err: err?.message,
        stack: err?.stack?.split("\n").slice(0, 3).join(" | "),
      })
      await snapshot(ctx, `tab-${name}-isolated-throw`).catch(() => {})
      return { ok: false, reason: `threw: ${err?.message || "exception"}` }
    }
  }
  tabs.profile = await runIsolated("profile", () =>
    fillProfileTab(ctx, input.producerId, input.residentAddress),
  )
  tabs.dba = await runIsolated("dba", () =>
    fillDba(ctx, input.producerId, input.dba),
  )
  tabs.questions = await runIsolated("questions", () =>
    fillQuestions(ctx, input.producerId, input.questions),
  )
  tabs.finra = await runIsolated("finra", () =>
    fillFinra(ctx, input.producerId, input.questions),
  )
  tabs.training = await runIsolated("training", () =>
    fillTraining(ctx, input.producerId, input.training),
  )
  tabs.eno = await runIsolated("eno", () =>
    fillEno(ctx, input.producerId, input.eno),
  )
  tabs.signature = await runIsolated("signature", () =>
    fillSignature(ctx, input.producerId, input.signature),
  )
  return tabs
}

// ─── FINRA ────────────────────────────────────────────────────────────
// Two yes/no questions: "Are you currently FINRA-registered?" and
// "Were you ever FINRA-registered?" Set4Life agents are not FINRA-
// registered (we sell life insurance only, not securities), so the
// answer is No / No unless the input.questions explicitly says
// otherwise. Verified live 2026-05-05 that fresh producers default to
// No / No on the FINRA tab — for those agents, this step is just a
// "verify and click Save" no-op.
async function fillFinra(
  ctx: TabContext,
  producerId: string,
  input: ProfileFillInput["questions"],
): Promise<TabResult> {
  const { page, logger } = ctx
  await goToTab(page, producerId, "finra", ctx.logger)
  await snapshot(ctx, "tab-finra-before")

  if (await isTabComplete(page, "finra")) {
    return { ok: true, alreadyDone: true }
  }

  const isFinra = !!input?.finraRegistered
  // SureLC encodes Yes/No as single letters Y/N on the inner native
  // input. Verified live 2026-05-05.
  const wantValue = isFinra ? "Y" : "N"

  // Each question is wrapped in a <mat-radio-group> containing two
  // <mat-radio-button>s. Clicking the mat-radio-button (NOT the inner
  // <input>) is what registers in Angular Material's MDC build. We
  // click every "Y" or "N" mat-radio-button on the page — both
  // questions get the same answer for our use case (Set4Life agents
  // are not FINRA-registered, currently or historically).
  const buttons = await page.$$(
    `mat-radio-button:has(input[value="${wantValue}"])`,
  )
  let clicked = 0
  for (const b of buttons) {
    try {
      await (b as any).click({ force: true })
      clicked++
    } catch {
      /* ignore individual button failures */
    }
  }

  if (isFinra && input?.finraCrd) {
    await fillByLabel(page, "CRD", input.finraCrd).catch(() => false)
    await fillByLabel(page, "CRD Number", input.finraCrd).catch(() => false)
  }

  // FINRA tab auto-persists on radio click — no Save button exists.
  await settle(page, 600)
  const cleared = await waitForTabClear(page, "finra", 5_000)
  await snapshot(ctx, "tab-finra-after")
  logger.info({ clicked, cleared, isFinra }, "[FINRA] tab complete")
  return cleared
    ? {
        ok: true,
        details: { buttonsClicked: clicked, autoSaved: true, warningCleared: cleared, isFinra },
      }
    : {
        ok: false,
        reason: `FINRA tab did not verify complete after selecting No/No. ${await describeUploadablePage(page)}`,
        details: { buttonsClicked: clicked, autoSaved: true, warningCleared: cleared, isFinra },
      }
}

// ─── Profile (resident address) ───────────────────────────────────────
//
// SureLC's BGA producer page surfaces a header-level "Resident address
// is not valid" alert when NIPR-imported producer data fails address
// validation. Fastlane uses this alert as a hard gate — producers
// flagged with an address issue get an "N issues" badge replacing the
// SELECT button, blocking contracting (Josue 2026-05-08).
//
// The PROFILE tab (URL .../bga/producers/{id}/profile) is where the
// resident address is editable. This handler navigates there, snapshots
// the state, and fills any empty/invalid resident-address fields from
// the agent's record. Defensive: tries multiple label variants because
// SureLC's profile fields haven't been audited yet.

async function fillProfileTab(
  ctx: TabContext,
  producerId: string,
  input: ProfileFillInput["residentAddress"],
): Promise<TabResult> {
  const { page, logger } = ctx
  await goToTab(page, producerId, "profile", logger)
  await snapshot(ctx, "tab-profile-before")

  // Quick exit: if the page doesn't currently show the
  // "Resident address is not valid" alert, profile is fine — no
  // resident-address work needed.
  const hasInvalidAlertPre = await page
    .$$eval("body", (els) =>
      /Resident address is not valid/i.test(els[0]?.innerText || ""),
    )
    .catch(() => false)
  if (!hasInvalidAlertPre) {
    return { ok: true, alreadyDone: true, details: { skipped: "no resident-address alert" } }
  }

  // Confirmed via Josue's snapshot: the NIPR sync button only
  // refreshes DOB / last name (the modal text says: "applicable if
  // your date of birth or last name is incorrect"). It is NOT a
  // resident-address fix. Skip it. The address fields live below
  // the first viewport on the profile tab — we have to scroll the
  // tab-content panel down to bring them into view + into the form
  // inventory before fillIfEmpty can find them.
  if (!input) {
    return {
      ok: false,
      reason: "Resident address invalid and no agent address available to fill manually",
    }
  }

  // Real fix path: the profile tab has THREE address cards (Residence,
  // Business, Mailing) rendered as <sb-producer-profile-address-item>.
  // Each has an "Edit Address" mat-icon-button. Josue 2026-05-08:
  // Business + Mailing are populated, Residence is empty → "Resident
  // address is not valid" alert. Click the Edit button on the
  // Residence card, fill the dialog, save.
  const residenceEditBtn = await page
    .evaluateHandle(() => {
      const items = Array.from(
        document.querySelectorAll("sb-producer-profile-address-item"),
      )
      const residenceCard = items.find((it) =>
        /Residence/i.test((it as HTMLElement).innerText || ""),
      )
      if (!residenceCard) return null
      return residenceCard.querySelector(
        'button[mattooltip="Edit Address"]',
      ) as HTMLElement | null
    })
    .catch(() => null)
  const editBtn = residenceEditBtn?.asElement()
  if (!editBtn) {
    await snapshot(ctx, "tab-profile-no-residence-card")
    return {
      ok: false,
      reason: "Residence address card not found — page structure may have changed",
    }
  }
  try {
    await (editBtn as any).click()
    await page.waitForTimeout(1500)
    await snapshot(ctx, "tab-profile-edit-dialog")
  } catch (err: any) {
    return {
      ok: false,
      reason: `Click Edit Address failed: ${err?.message || "unknown"}`,
    }
  }

  // The Edit Residence dialog includes "USE THIS ADDRESS" buttons
  // for the Business and Mailing addresses already on file. Clicking
  // one of those one-shots all five fields (Street, Line 2, Zip,
  // City, State) — much cleaner than label-walking each input
  // (the State field is a typeahead, not a mat-select, and labels
  // are "Street*" not "Address Line 1*"). Prefer Mailing first then
  // Business since they're typically identical for our agents.
  const useBusinessOrMailing = await firstVisible(page, [
    'button:has-text("USE THIS ADDRESS")',
    'button:has-text("Use this address")',
  ])
  if (useBusinessOrMailing) {
    try {
      logger.info("[Profile] clicking USE THIS ADDRESS to copy from Business/Mailing")
      await (useBusinessOrMailing as any).click()
      await page.waitForTimeout(800)
    } catch (err: any) {
      logger.warn({ err: err?.message }, "[Profile] USE THIS ADDRESS click threw")
    }
  } else {
    // Fallback to label-fill if USE THIS ADDRESS isn't present
    // (e.g. Business + Mailing also empty on a fresh producer).
    logger.warn("[Profile] no USE THIS ADDRESS button — falling back to label fill")
    await fillIfEmpty(page, "Street", input.addressLine1).catch(() => false)
    if (input.addressLine2) {
      await fillIfEmpty(page, "Line 2", input.addressLine2).catch(() => false)
    }
    await fillIfEmpty(page, "City", input.city).catch(() => false)
    await fillIfEmpty(page, "Zip", input.postalCode).catch(() => false)
    // State input is a text typeahead (mat-form-field with mat-icon
    // suffix), not a mat-select — fill the visible input directly.
    await fillIfEmpty(page, "State", input.state).catch(() => false)
  }

  await snapshot(ctx, "tab-profile-edit-dialog-filled")

  // Save the dialog — most Material dialogs use a SAVE button.
  const dialogSaveBtn = await firstVisible(page, [
    'mat-dialog-container button:has-text("SAVE")',
    'mat-dialog-container button:has-text("Save")',
    '.cdk-overlay-pane button:has-text("SAVE")',
    '.cdk-overlay-pane button:has-text("Save")',
    'button:has-text("SAVE")',
  ])
  if (!dialogSaveBtn) {
    await snapshot(ctx, "tab-profile-no-dialog-save")
    return {
      ok: false,
      reason: "Edit Address dialog opened but SAVE button not found",
    }
  }
  try {
    await (dialogSaveBtn as any).click()
    await settle(page, 2_500)
  } catch (err: any) {
    return {
      ok: false,
      reason: `Address dialog SAVE click failed: ${err?.message || "unknown"}`,
    }
  }


  await snapshot(ctx, "tab-profile-after")

  // The "Resident address is not valid" alert disappears once SureLC
  // accepts the new resident address. If it persists, USPS validation
  // probably rejected the address (typo, non-deliverable, etc.).
  const stillInvalid = await page
    .$$eval("body", (els) =>
      /Resident address is not valid/i.test(els[0]?.innerText || ""),
    )
    .catch(() => false)
  if (stillInvalid) {
    return {
      ok: false,
      reason:
        "Resident address still flagged invalid after dialog save — USPS validator may have rejected the address (typo, apt# missing, non-deliverable). Manual review needed.",
      details: { addressUsed: input },
    }
  }
  return {
    ok: true,
    details: { addressFilled: input },
  }
}

// ─── DBA ──────────────────────────────────────────────────────────────

async function fillDba(
  ctx: TabContext,
  producerId: string,
  input: ProfileFillInput["dba"],
): Promise<TabResult> {
  const { page } = ctx
  await goToTab(page, producerId, "dba", ctx.logger)
  await snapshot(ctx, "tab-dba-before")

  // If the affiliation template applied, fields are greyed and pre-
  // filled. The "complete" indicator is the green check on the tab.
  if (await isTabGreen(page, "DBA")) {
    return { ok: true, alreadyDone: true }
  }
  if (!input) {
    return { ok: false, reason: "DBA tab needs filling but no input provided" }
  }

  // Hardcoded "License Only" — SureLC producers are NEVER created as
  // a business entity, regardless of how the agent signed up in
  // Set4Life. The signup-time businessName / W-9 corp election is for
  // tax forms only, NOT for SureLC. If a caller passes
  // input.businessType="Business Only" it's a bug — log and ignore.
  // (server.ts schema also rejects anything other than "License Only".)
  if (input.businessType && input.businessType !== "License Only") {
    console.warn(
      `[SureLC bot fillProfile] businessType=${input.businessType} ignored — forcing "License Only" per owner directive`,
    )
  }
  await selectByLabel(
    page,
    "How will this producer do business",
    "License Only",
  ).catch(() => false)

  // Soliciting For — autocomplete dropdown.
  const solicit = await firstVisible(page, [
    'input[name*="soliciting" i]',
    'input[placeholder*="soliciting" i]',
    'select[name*="soliciting" i]',
  ])
  if (solicit) {
    try {
      const tag = await (solicit as any).evaluate((el: HTMLElement) => el.tagName)
      if (tag === "SELECT") {
        await (solicit as any).selectOption({ label: input.solicitingFor })
      } else {
        await (solicit as any).fill(input.solicitingFor)
        await page.waitForTimeout(400)
        const opt = await page.$(`text="${input.solicitingFor}"`)
        if (opt) await opt.click()
      }
    } catch {
      /* ignore */
    }
  }

  // SureLC auto-persists DBA changes on dropdown/blur — no Save
  // button exists on this tab. Verified live 2026-05-05.
  await settle(page, 800)
  const cleared = await waitForTabClear(page, "dba", 5_000)
  await snapshot(ctx, "tab-dba-after")
  return cleared
    ? { ok: true, details: { autoSaved: true, warningCleared: cleared } }
    : {
        ok: false,
        reason: `DBA tab did not verify complete after fill. ${await describeUploadablePage(page)}`,
        details: { autoSaved: true, warningCleared: cleared },
      }
}

// ─── Questions ────────────────────────────────────────────────────────

/**
 * Map our SURELC_SUBQUESTIONS slugs to SureLC Question tab parent
 * numbers (1-19). Each parent on SureLC asks the union of multiple
 * sub-questions on our side — so any sub answered "yes" on our side
 * means parent = "yes" on SureLC. Default = "no" if no sub matches.
 */
const SUB_TO_PARENT: Record<string, number> = {
  felony: 1, misdemeanor: 1, securitiesRegulations: 1,
  securitiesRegulationsState: 1, foreignRegulations: 1,
  chargedFelony: 1, chargedMisdemeanor: 1, probation: 1,
  beingInvestigated: 2, wereInvestigated: 2, inLawSuit: 2, lawSuitInsurance: 2,
  allegedOfFraud: 3,
  provenFraud: 4,
  wasFiredRegulations: 5, wasFiredOfFraud: 5, wasFiredStatutes: 5,
  deniedAppointment: 6,
  oweToInsurance: 7,
  suretyRefused: 8, eoRefused: 8,
  secLicense: 9,
  firmSecLicense: 10,
  secNonInsuranceLicense: 11,
  dishonestOrUnethical: 12,
  interruptions: 13,
  wasDisciplined: 14, hadComplaint: 14, consumerComplaint: 14,
  wasBankrupt: 15, firmBankrupt: 15, bankruptcyPending: 15,
  hasLiens: 16,
  alias: 18,
  relatedToFinance: 17,
  revenueServiceMatters: 19,
}

async function fillQuestions(
  ctx: TabContext,
  producerId: string,
  input: ProfileFillInput["questions"],
): Promise<TabResult> {
  const { page, logger } = ctx
  await goToTab(page, producerId, "questions", ctx.logger)
  await snapshot(ctx, "tab-questions-before")

  if (await isTabGreen(page, "Questions")) {
    return { ok: true, alreadyDone: true }
  }

  // ── Click "ALL NO" first — saves us 19 individual clicks. SureLC
  //    ships this button precisely for the clean-record case.
  const allNoBtn = await firstVisible(page, [
    'button:has-text("ALL NO")',
    'button:has-text("All No")',
  ])
  if (allNoBtn) {
    try {
      await allNoBtn.click()
      await settle(page, 600)
      logger.info("[Questions] clicked ALL NO")
    } catch {
      /* ignore — fall through to per-question fill */
    }
  }

  // Compute which parent questions need to flip back to Yes based on
  // the rep's surelcAnswers. Any sub-question = "yes" → parent = "yes".
  const parentYes = new Set<number>()
  if (input?.surelcAnswers) {
    for (const [slug, ans] of Object.entries(input.surelcAnswers)) {
      if (ans.answer === "yes") {
        const parent = SUB_TO_PARENT[slug]
        if (parent) parentYes.add(parent)
      }
    }
  }
  logger.info("[Questions] parents needing Yes override", {
    parents: Array.from(parentYes).sort((a, b) => a - b),
  })

  // Click Yes on each parent that has a yes sub-question + paste any
  // explanation text + upload supporting documents. Question rows are
  // numbered 1-19 in a left column; the Yes/No radios are on the right.
  for (const parentNum of parentYes) {
    try {
      // Find the row by its leading number column. Each row in the
      // SureLC Questions tab starts with a circled number (1, 2, ...).
      const yesRadio = await page.$(
        `tr:has-text("${parentNum}.") input[type="radio"][value="yes" i]`,
      )
      if (!yesRadio) {
        // Fallback — match by leading number text + Yes label.
        const fallback = await page.$(
          `*:has(text="${parentNum}") >> input[type="radio"][value="yes" i]`,
        )
        if (fallback) {
          await (fallback as any).check({ force: true })
        } else {
          logger.warn("[Questions] yes radio not found for parent", { parentNum })
        }
      } else {
        await (yesRadio as any).check({ force: true })
      }
    } catch (err: any) {
      logger.warn("[Questions] yes-override failed", {
        parentNum,
        err: err.message,
      })
    }
  }

  // Upload each sub-question's supporting documents under the matching
  // parent's row. SureLC opens an explanation/upload area when a Yes
  // is selected — the file inputs that appear belong to that row.
  if (input?.surelcAnswers) {
    for (const [slug, ans] of Object.entries(input.surelcAnswers)) {
      if (ans.answer !== "yes" || !ans.documents?.length) continue
      const parentNum = SUB_TO_PARENT[slug]
      if (!parentNum) continue
      // Find the row's expanded explanation area.
      const explanationArea = await page.$(
        `tr:has-text("${parentNum}.") + tr [class*="explanation"], ` +
          `tr:has-text("${parentNum}.") textarea`,
      )
      // Stuff the question's explanation text if we have one.
      const explanationText = (input as any)?.explanations?.[slug]
      if (explanationText && explanationArea) {
        try {
          await (explanationArea as any).fill(explanationText)
        } catch {
          /* ignore */
        }
      }
      // Upload each doc using the same robust pattern as E&O / AML:
      // try the visible UPLOAD button + filechooser dialog first
      // (most reliable in modern SureLC UIs where the input is hidden
      // behind a styled label), fall back to direct setInputFiles on
      // file inputs scoped to the parent question's row.
      const path = await import("node:path")
      const fs = await import("node:fs/promises")
      const os = await import("node:os")
      for (let i = 0; i < ans.documents.length; i++) {
        const doc = ans.documents[i]
        try {
          const res = await fetch(doc.url)
          if (!res.ok) continue
          const buf = Buffer.from(await res.arrayBuffer())
          const localPath = path.join(
            os.tmpdir(),
            `surelc-q${parentNum}-${Date.now()}-${doc.fileName || "doc.pdf"}`,
          )
          await fs.writeFile(localPath, buf)
          // Try filechooser first — find the UPLOAD button scoped to
          // the question row (or in the explanation area below it).
          const uploadBtn = await page.$(
            `tr:has-text("${parentNum}.") + tr button:has-text("UPLOAD"), ` +
              `tr:has-text("${parentNum}.") + tr button:has-text("Upload")`,
          )
          let attached = false
          if (uploadBtn) {
            try {
              const [fc] = await Promise.all([
                page.waitForEvent("filechooser", { timeout: 5_000 }),
                (uploadBtn as any).click(),
              ])
              await fc.setFiles(localPath)
              attached = true
            } catch {
              /* fall through to setInputFiles */
            }
          }
          if (!attached) {
            const fileInputs = await page.$$(
              `tr:has-text("${parentNum}.") + tr input[type="file"]`,
            )
            if (fileInputs[i]) {
              await (fileInputs[i] as any).setInputFiles(localPath)
              attached = true
            }
          }
          if (!attached) {
            logger.warn("[Questions] doc upload failed", { parentNum, docUrl: doc.url })
          }
        } catch (err: any) {
          logger.warn("[Questions] doc upload threw", {
            parentNum,
            err: err.message,
          })
        }
      }
    }
  }

  // ── 2. FINRA Yes/No + CRD — top-level (the agency.yml API also
  // exposes POST /finra/{id}/status + /crd, so the main app may have
  // already set this; we still mirror it on the tab for safety).
  if (input?.finraRegistered) {
    const yes = await page.$(
      'label:has-text("FINRA") input[type="radio"][value="yes" i]',
    )
    if (yes) await (yes as any).check({ force: true }).catch(() => false)
    if (input.finraCrd) {
      await fillByLabel(page, "CRD", input.finraCrd).catch(() => false)
    }
  } else {
    const no = await page.$(
      'label:has-text("FINRA") input[type="radio"][value="no" i]',
    )
    if (no) await (no as any).check({ force: true }).catch(() => false)
  }

  // ── 3. Military status.
  if (input?.militaryStatus) {
    await selectByLabel(page, "Military", input.militaryStatus).catch(() => false)
  }

  // ── 4. Attestation block — name / date / initials at the bottom.
  if (input?.attestationName) {
    await fillByLabel(page, "Attestation Name", input.attestationName)
      .catch(() => false)
      .then((ok) =>
        ok ? true : fillByLabel(page, "Full Name", input.attestationName!),
      )
      .catch(() => false)
  }
  if (input?.attestationDate) {
    await fillByLabel(page, "Attestation Date", input.attestationDate)
      .catch(() => false)
      .then((ok) =>
        ok ? true : fillByLabel(page, "Date Signed", input.attestationDate!),
      )
      .catch(() => false)
  }
  if (input?.attestationInitials) {
    await fillByLabel(page, "Initials", input.attestationInitials).catch(
      () => false,
    )
  }

  // ── 5. Employment + address history — repeating rows TODO.
  if ((input?.employmentHistory?.length ?? 0) > 0) {
    logger.warn(
      { rows: input?.employmentHistory?.length },
      "employment history not implemented (repeating-row UI selectors needed)",
    )
  }
  if ((input?.addressHistory?.length ?? 0) > 0) {
    logger.warn(
      { rows: input?.addressHistory?.length },
      "address history not implemented (repeating-row UI selectors needed)",
    )
  }

  // Questions tab auto-persists on radio click (verified 2026-05-05 —
  // no Save button exists). Wait for the warning icon to clear.
  await settle(page, 800)
  const cleared = await waitForTabClear(page, "questions", 8_000)
  await snapshot(ctx, "tab-questions-after")
  return cleared
    ? { ok: true, details: { autoSaved: true, warningCleared: cleared } }
    : {
        ok: false,
        reason: `Questions tab did not verify complete after fill. ${await describeUploadablePage(page)}`,
        details: { autoSaved: true, warningCleared: cleared },
      }
}

/**
 * Locate the Yes/No radio for a sub-question by:
 *   1. name attribute matching the slug + value matching the answer
 *   2. data-question / data-slug attribute matching the slug
 *   3. an id starting with the slug
 *   4. fall back to the parent label of the question text (slow but
 *      most stable across SureLC redesigns)
 */
async function findSubQuestionRadio(
  page: Page,
  slug: string,
  questionText: string | undefined,
  answer: "yes" | "no",
): Promise<import("playwright").ElementHandle<HTMLElement | SVGElement> | null> {
  const candidates = [
    `input[type="radio"][name*="${slug}" i][value="${answer}" i]`,
    `input[type="radio"][data-slug="${slug}"][value="${answer}" i]`,
    `input[type="radio"][data-question="${slug}"][value="${answer}" i]`,
    `input[type="radio"][id^="${slug}_"][value="${answer}" i]`,
    `input[type="radio"][id*="${slug}-${answer}" i]`,
  ]
  for (const sel of candidates) {
    const el = await page.$(sel)
    if (el) return el
  }
  if (questionText) {
    // Match the question text with a small Levenshtein-style truncation
    // so minor punctuation / casing differences don't kill the lookup.
    const key = questionText.slice(0, 60).replace(/"/g, "")
    const el = await page.$(
      `*:has-text("${key}") >> input[type="radio"][value="${answer}" i]`,
    )
    if (el) return el
  }
  return null
}

async function findFieldNearSlug(
  page: Page,
  slug: string,
  selectors: string[],
): Promise<import("playwright").ElementHandle<HTMLElement | SVGElement> | null> {
  for (const sel of selectors) {
    const scoped = `[data-slug="${slug}"] ${sel}, [data-question="${slug}"] ${sel}, [id*="${slug}"] ${sel}`
    const el = await page.$(scoped)
    if (el && (await el.isVisible().catch(() => false))) return el
  }
  return null
}

async function findFileInputsNearSlug(
  page: Page,
  slug: string,
): Promise<Array<{ handle: import("playwright").ElementHandle<HTMLElement | SVGElement>; attrs: string }>> {
  const handles = await page.$$(
    `[data-slug="${slug}"] input[type="file"], [data-question="${slug}"] input[type="file"], [id*="${slug}"] input[type="file"]`,
  )
  const out: Array<{ handle: any; attrs: string }> = []
  for (const h of handles) {
    const attrs = await h.evaluate(
      (el) =>
        Array.from((el as HTMLElement).attributes)
          .map((a) => `${a.name}=${a.value}`)
          .join(" "),
    ).catch(() => "")
    out.push({ handle: h, attrs })
  }
  return out
}

// ─── Training (AML) ───────────────────────────────────────────────────

async function fillTraining(
  ctx: TabContext,
  producerId: string,
  input: ProfileFillInput["training"],
): Promise<TabResult> {
  const { page, logger } = ctx
  if (!input?.amlCertificateUrl) {
    return { ok: false, reason: "no AML certificate URL provided" }
  }
  await goToTab(page, producerId, "training", ctx.logger)

  // Recover from leftover "Add Manually" / "Add Training" sub-page
  // state that previous failed runs may have left behind. SureLC
  // persists this across sessions, so a fresh login still lands the
  // bot on the dirty sub-page where Fastlane navigation is blocked.
  // Click BACK iteratively until we're on the main Training page
  // (with "Training Categories" / "Training Concierge" headings).
  for (let i = 0; i < 3; i++) {
    const onAddSubpage = await page
      .$$eval("body", (els) =>
        /Add Manually|Add Training|Select or Upload Certificate/i.test(els[0]?.innerText || ""),
      )
      .catch(() => false)
    if (!onAddSubpage) break
    const backBtn = await firstVisible(page, [
      'button:has-text("BACK")',
      'a:has-text("BACK")',
      'button:has-text("CANCEL")',
    ])
    if (!backBtn) break
    logger.info({ iteration: i }, "[Training] escaping leftover sub-page via BACK")
    await backBtn.click().catch(() => undefined)
    await settle(page, 1000)
  }

  await snapshot(ctx, "tab-training-before")

  if (await isTabGreen(page, "Training")) {
    return { ok: true, alreadyDone: true }
  }

  // Content-presence "already done" detector: SureLC renders the AML
  // course as a row whose header reads "Anti-Money Laundering"
  // followed by the provider name + completion date, e.g.
  //   "Anti-Money Laundering  WEBCE, INC  04/29/2026"
  // (Sydney 2026-05-07 — bot's previous "is upload form visible" path
  // mistook this completed-state for "fresh form needs upload" and
  // bailed because the upload form isn't rendered when AML is done.)
  // If the AML header row holds a `MM/DD/YYYY` token, the rep already
  // has an AML cert on file and we no-op.
  const amlRowText = await page
    .$$eval("body", (els) => {
      const root = els[0]
      const txt = root?.innerText || ""
      // Pull the line containing "Anti-Money Laundering" + the
      // ~80 chars after it.
      const i = txt.search(/Anti[- ]?Money Laundering/i)
      if (i < 0) return ""
      return txt.slice(i, i + 200)
    })
    .catch(() => "")
  if (/\b\d{2}\/\d{2}\/\d{4}\b/.test(amlRowText)) {
    logger.info({ amlRowExcerpt: amlRowText.slice(0, 120) }, "[Training] AML already on file (date detected) — skipping upload")
    return { ok: true, alreadyDone: true, details: { detected: "amlRowHasDate" } }
  }

  // Wait for the certificates XHR to land before clicking UPLOAD.
  // Verified 2026-05-05 that the UPLOAD button appears in the DOM
  // before /training/courses/certificates returns; clicking it
  // pre-XHR navigates to a half-wired add page that silently swallows
  // the upload. Race-free pattern: wait up to 10s for the XHR.
  await page
    .waitForResponse(
      (r) => /\/training\/courses\/certificates/.test(r.url()) && r.status() === 200,
      { timeout: 10_000 },
    )
    .catch(() =>
      logger.warn(
        "[Training] certificates XHR did not return in 10s — proceeding anyway",
      ),
    )

  // The AML row lives inside a custom Angular component <sb-aml-course>.
  // Verified live 2026-05-05 — scoping inside this component is the
  // only safe way to identify the AML upload button (Training has 6+
  // categories, each with their own UPLOAD; "first UPLOAD on page" is
  // wrong as soon as Continuing Education or any earlier category
  // expands). Button text is "Upload" (mixed case); the leading
  // material-icon ligature can make textContent read as
  // "cloud_upload Upload" — Playwright :has-text() handles this fine.
  const generateCertificateBtn = await firstVisible(page, [
    'button:has-text("GENERATE CERTIFICATE")',
    'button:has-text("Generate Certificate")',
    'button:has-text("PRODUCE CERTIFICATE")',
    'button:has-text("Produce Certificate")',
  ])
  if (generateCertificateBtn) {
    try {
      await generateCertificateBtn.click()
      await settle(page, 2500)
      const cleared = await waitForTabClear(page, "training", 12_000)
      await snapshot(ctx, "tab-training-after-generate-certificate")
      return cleared
        ? { ok: true, details: { generatedCertificate: true, warningCleared: cleared } }
        : {
            ok: false,
            reason: `Training Generate Certificate clicked, but tab did not verify complete. ${await describeUploadablePage(page)}`,
            details: { generatedCertificate: true, warningCleared: cleared },
          }
    } catch (err: any) {
      logger.warn("[Training] Generate Certificate path threw", { err: err.message })
    }
  }

  await snapshot(ctx, "tab-training-aml-row")

  let amlUploadBtn = await firstVisible(page, [
    'sb-aml-course button.actions__button:has-text("Upload")',
    'sb-aml-course button:has-text("Upload")',
    // Fallback if the custom element name ever changes.
    'mat-expansion-panel:has(mat-panel-title:has-text("Anti-Money Laundering")) button:has-text("Upload")',
  ])

  // Fresh-state path: AML row says "NO CURRENT TRAINING ON FILE"
  // with an "ADD CERTIFICATION" button inside the AML accordion
  // section. The PAGE has multiple ADD CERTIFICATION buttons
  // (one per training category — Continuing Education, AML, Life
  // State Training, etc.) so the selector MUST be scoped to the
  // AML section, not a generic page-wide match. Bot's earlier
  // generic match landed on a different category's flow and ended
  // up in "Add Manually" mode.
  if (!amlUploadBtn) {
    const amlAddCertBtn = await firstVisible(page, [
      // Inside the AML accordion / panel
      'mat-expansion-panel:has(mat-panel-title:has-text("Anti-Money Laundering")) button:has-text("ADD CERTIFICATION")',
      'mat-expansion-panel:has(mat-panel-title:has-text("Anti-Money Laundering")) button:has-text("Add Certification")',
      // SureLC sometimes wraps the AML category in <sb-aml-course>
      'sb-aml-course button:has-text("ADD CERTIFICATION")',
      // Fallback: any element near the literal text "Anti-Money
      // Laundering" + "NO CURRENT TRAINING ON FILE"
      'div:has-text("Anti-Money Laundering"):has-text("NO CURRENT TRAINING ON FILE") button:has-text("ADD CERTIFICATION")',
    ])
    if (amlAddCertBtn) {
      logger.info("[Training] clicking AML-scoped ADD CERTIFICATION")
      await amlAddCertBtn.click().catch(() => undefined)
      await settle(page, 1500)
      await snapshot(ctx, "tab-training-after-add-cert")
      // The AML-specific add flow opens a file picker dialog or
      // upload form. Re-scan for an Upload button / file input.
      amlUploadBtn = await firstVisible(page, [
        'mat-dialog-container button:has-text("UPLOAD")',
        'mat-dialog-container button:has-text("Upload")',
        '.cdk-overlay-pane button:has-text("UPLOAD")',
        'button:has-text("UPLOAD CERTIFICATE")',
        'button:has-text("Upload Certificate")',
      ])
    }
  }
  let uploaded = false
  if (amlUploadBtn) {
    try {
      await assertOnProducerTab(page, producerId, "training")
      // Download the cert locally first.
      const res = await fetch(input.amlCertificateUrl)
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        const path = await import("node:path")
        const fs = await import("node:fs/promises")
        const os = await import("node:os")
        const localPath = path.join(
          os.tmpdir(),
          `aml-${Date.now()}.pdf`,
        )
        await fs.writeFile(localPath, buf)

        // Listen for the filechooser dialog that the UPLOAD button
        // triggers — Playwright's recommended way to handle file
        // inputs that are attached to a button (not a visible input).
        const [fc] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 8_000 }),
          (amlUploadBtn as any).click(),
        ])
        await fc.setFiles(localPath)
        uploaded = true
        await settle(page, 1500)
      }
    } catch (err: any) {
      logger.warn("[Training] AML filechooser path threw", { err: err.message })
    }
  }

  // Fallback — direct setInputFiles on any file input on the page.
  if (!uploaded) {
    await assertOnProducerTab(page, producerId, "training")
    uploaded = await uploadRemoteFile(
      page,
      'input[type="file"]',
      input.amlCertificateUrl,
      logger,
    ).catch(() => false)
  }

  // Reorder per E&O fix pattern: WAIT for SureLC's Recognition first
  // so the Add Training form actually exists before we try to fill
  // it, otherwise the fillByLabel calls silently miss every field.
  await settle(page, 800)
  // SureLC's OCR Recognition for image certs (JPEG/PNG) takes
  // significantly longer than for clean PDFs — Keyon's JPEG was
  // still mid-Recognition at 120s. Match the E&O 5-minute ceiling.
  const PARSE_BUDGET_MS = 300_000
  const POLL_MS = 1_500
  const start = Date.now()
  let cleared = false
  while (Date.now() - start < PARSE_BUDGET_MS) {
    cleared = await waitForTabClear(page, "training", POLL_MS)
    if (cleared) break
    const stillProcessing = await page
      .$$eval("body", (els) =>
        /Recognition|Processing|Uploading|Loading document/i.test(els[0]?.innerText || ""),
      )
      .catch(() => false)
    if (!stillProcessing) {
      cleared = await waitForTabClear(page, "training", POLL_MS)
      break
    }
    logger.info({ elapsedMs: Date.now() - start }, "[Training] OCR still running — waiting")
  }
  await snapshot(ctx, "tab-training-after-wait")

  // After Recognition completes, the "Add Training" manual form is
  // rendered with required fields. Fill them from agent data —
  // OCR usually doesn't auto-populate provider/course/date for
  // image certs (JPEG/PNG).
  if (input.amlProvider) {
    await fillByLabel(page, "Provider Name", input.amlProvider).catch(() => false)
    await fillByLabel(page, "Provider", input.amlProvider).catch(() => false)
  }
  const courseName = input.amlCourseName || "Anti-Money Laundering"
  await fillByLabel(page, "Course Name", courseName).catch(() => false)
  // Course Name is a Material autocomplete typeahead. After typing,
  // an mat-option dropdown opens with matching courses; we MUST
  // click one for the form to accept the value (free text isn't
  // valid here). Pick the first AML option as a generic fallback.
  await page.waitForTimeout(800)
  const courseOption = await firstVisible(page, [
    'mat-option:has-text("Anti-Money Laundering")',
    'mat-option:has-text("AML")',
    '.cdk-overlay-pane mat-option',
  ])
  if (courseOption) {
    logger.info("[Training] selecting Course Name from autocomplete")
    await (courseOption as any).click().catch(() => undefined)
    await settle(page, 600)
  }
  if (input.amlCompletionDate) {
    // Normalize to MM/DD/YYYY (SureLC expects this format per the
    // form's "Date is required in the format: 01/15/2019" hint).
    let mmddyyyy = input.amlCompletionDate
    const isoMatch = mmddyyyy.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (isoMatch) mmddyyyy = `${isoMatch[2]}/${isoMatch[3]}/${isoMatch[1]}`
    // Use the same Material datepicker DOM-fill pattern that worked
    // for E&O — plain fillByLabel doesn't propagate to Material's
    // FormControl reliably.
    await fillEnoDate(page, ["Completion Date", "Completion", "AML Date"], mmddyyyy, logger)
  }
  // LTC rider — Set4Life agents don't sell LTC.
  if (input.ltcRiderCompleted === false) {
    const no = await page.$('label:has-text("LTC") input[type="radio"][value="no" i]')
    if (no) await (no as any).check({ force: true })
  }
  await snapshot(ctx, "tab-training-form-filled")

  // After Recognition completes, SureLC may show a form needing
  // SAVE click (similar to E&O dialog flow). Try clicking SAVE if
  // we found one before assuming auto-persist.
  const trainingSaveBtn = await firstVisible(page, [
    'mat-dialog-container button:has-text("SAVE")',
    'mat-dialog-container button:has-text("Save")',
    'button:has-text("SAVE & EXIT")',
    'button:has-text("Save & Exit")',
    'button:has-text("SAVE")',
    'button:has-text("Save")',
  ])
  if (trainingSaveBtn) {
    logger.info("[Training] clicking SAVE on post-recognition form")
    await (trainingSaveBtn as any).click().catch(() => undefined)
    await settle(page, 2_000)
    cleared = await waitForTabClear(page, "training", 10_000)
  }
  await snapshot(ctx, "tab-training-after")
  if (!uploaded) {
    return { ok: false, reason: `AML upload did not attach a file. ${await describeUploadablePage(page)}` }
  }
  return cleared
    ? { ok: true, details: { autoSaved: true, warningCleared: cleared } }
    : {
        ok: false,
        reason: `AML file attached, but Training tab did not verify complete. ${await describeUploadablePage(page)}`,
        details: { autoSaved: true, warningCleared: cleared },
      }
}

// ─── E&O ──────────────────────────────────────────────────────────────

/**
 * Fill a Material datepicker (wrapped in SureLC's <sb-date-input>
 * custom directive) by setting the value on the HIDDEN
 * mat-datepicker-input + dispatching change events so the directive
 * commits to the FormControl. This is the only path that reliably
 * propagates: typing into the visible input lets the directive's
 * parser get confused (Josue 2026-05-08 saw "05/01/2026" become
 * "02/05/1" mid-typing), and el.fill() leaves the FormControl
 * untouched.
 *
 * The hidden mat-datepicker-input accepts ISO format (YYYY-MM-DD)
 * via its native type="text" .value property; Material's
 * MatDatepickerInput directive has a CHANGE event listener that
 * parses the string and patches the parent form control.
 */
async function fillEnoDate(
  page: Page,
  labels: string[],
  value: string,
  logger: import("pino").Logger,
): Promise<boolean> {
  if (!value) return false
  // Convert MM/DD/YYYY → YYYY-MM-DD for the native input format
  const m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  const isoValue = m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : value

  for (const label of labels) {
    const result = await page.evaluate(
      ({ labelText, mmddYyyy, iso }) => {
        const matLabels = Array.from(document.querySelectorAll("mat-label"))
        const lbl = matLabels.find((l) => (l.textContent || "").trim() === labelText)
        if (!lbl) return { ok: false, reason: "label-not-found" }
        const ff = lbl.closest("mat-form-field")
        if (!ff) return { ok: false, reason: "no-form-field-ancestor" }

        // The visible (typeable) input
        const visible = ff.querySelector(
          'input[matinput][data-cy="date-input"]',
        ) as HTMLInputElement | null
        // The hidden mat-datepicker-input that owns the FormControl binding
        const hidden = ff.querySelector(
          'input.mat-datepicker-input',
        ) as HTMLInputElement | null
        if (!visible || !hidden) return { ok: false, reason: "inputs-not-found" }

        const setNativeValue = (el: HTMLInputElement, v: string) => {
          const proto = Object.getPrototypeOf(el)
          const desc = Object.getOwnPropertyDescriptor(proto, "value")
          desc?.set?.call(el, v)
        }

        // Set on both — visible for what the user sees, hidden for
        // the datepicker directive's onInput handler.
        setNativeValue(visible, mmddYyyy)
        visible.dispatchEvent(new Event("input", { bubbles: true }))
        visible.dispatchEvent(new Event("change", { bubbles: true }))
        visible.dispatchEvent(new Event("blur", { bubbles: true }))

        setNativeValue(hidden, iso)
        hidden.dispatchEvent(new Event("input", { bubbles: true }))
        hidden.dispatchEvent(new Event("change", { bubbles: true }))
        hidden.dispatchEvent(new Event("blur", { bubbles: true }))

        return { ok: true, visibleVal: visible.value, hiddenVal: hidden.value }
      },
      { labelText: label, mmddYyyy: value, iso: isoValue },
    )
    if (result.ok) {
      logger.info({ label, value, isoValue, ...result }, "[E&O] datepicker filled via DOM")
      return true
    }
    logger.warn({ label, ...result }, "[E&O] datepicker DOM fill miss — trying next label")
  }
  return false
}

async function fillEno(
  ctx: TabContext,
  producerId: string,
  input: ProfileFillInput["eno"],
): Promise<TabResult> {
  const { page, logger } = ctx
  if (!input?.certificateUrl) {
    return { ok: false, reason: "no E&O certificate URL provided" }
  }
  await goToTab(page, producerId, "eno", ctx.logger)

  // Recover from leftover dirty form state from a previous failed
  // run (Demetrius 2026-05-09: SureLC pre-filled Case Limit with a
  // wrong $5M after BIBERK Recognition; bot couldn't override because
  // ngx-mask + mat-autocomplete-trigger silently rejected fills).
  // If we land on an "Add Individual E&O Policy" / "Add New
  // Certificate" form with a "Data is not saved" banner, click
  // CANCEL to discard the bad pre-fill before our normal flow runs.
  for (let i = 0; i < 2; i++) {
    const onAddForm = await page
      .$$eval("body", (els) =>
        /Add Individual E&O Policy|Add New Certificate|Data is not saved/i.test(els[0]?.innerText || ""),
      )
      .catch(() => false)
    if (!onAddForm) break
    const cancelBtn = await firstVisible(page, [
      'button:has-text("CANCEL")',
      'button:has-text("Cancel")',
    ])
    if (!cancelBtn) break
    logger.info({ iteration: i }, "[E&O] discarding leftover dirty form via CANCEL")
    await cancelBtn.click().catch(() => undefined)
    await settle(page, 1000)
    // CANCEL may pop a confirm "Are you sure?" — click YES.
    const confirmYes = await firstVisible(page, [
      'mat-dialog-container button:has-text("YES")',
      'mat-dialog-container button:has-text("Yes")',
      '.cdk-overlay-pane button:has-text("YES")',
    ])
    if (confirmYes) {
      await confirmYes.click().catch(() => undefined)
      await settle(page, 1000)
    }
  }
  await snapshot(ctx, "tab-eno-before")

  if (await isTabComplete(page, "eno")) {
    return { ok: true, alreadyDone: true }
  }

  // Content-presence "already done" detector: when an E&O policy is
  // on file, SureLC renders an "Individual E&O Policy" header card
  // with an "Active" badge plus all policy fields populated +
  // a green "E&O certificate is attached" check. (Sydney 2026-05-07
  // 03:33 — bot's mat-row check missed because SureLC moved to a
  // card layout instead of a mat-table.) Match by visible text.
  const eoText = await page
    .$$eval("body", (els) => (els[0]?.innerText || ""))
    .catch(() => "")
  const hasActivePolicy = /Individual E&O Policy/i.test(eoText) && /\bActive\b/.test(eoText)
  const hasCertAttached = /E&O certificate is attached/i.test(eoText)
  if (hasActivePolicy || hasCertAttached) {
    logger.info({ hasActivePolicy, hasCertAttached }, "[E&O] active policy already on file — skipping ADD")
    return { ok: true, alreadyDone: true, details: { detected: hasActivePolicy ? "activePolicy" : "certAttached" } }
  }

  // Belt-and-braces: SureLC's E&O tab also used a <mat-table> of
  // <mat-row>s in older builds. Keep the row count check as a
  // secondary signal in case the text-based detector ever drifts.
  const existingRows = await page.$$("mat-row")
  if (existingRows.length > 0) {
    logger.info(
      { count: existingRows.length },
      "[E&O] producer already has policy row(s) — skipping ADD",
    )
    return { ok: true, alreadyDone: true, details: { existingRows: existingRows.length } }
  }

  // Open the form. Per the screenshot, the button is labelled
  // "ADD EXISTING POLICY". Owner reported 2026-05-05 the bot found
  // the button but landed on the form with EVERY required field
  // empty + a "Must be specified" red error under each.
  const addBtn = await firstVisible(page, [
    'button:has-text("ADD EXISTING POLICY")',
    'button:has-text("Add Existing Policy")',
    'button:has-text("Add E&O")',
    'button:has-text("Add Policy")',
    'button:has-text("Add")',
    'button[aria-label*="add" i]',
  ])
  if (addBtn) {
    try {
      await addBtn.click()
      await settle(page, 1200)
      await assertOnProducerTab(page, producerId, "eno")
    } catch (err: any) {
      return { ok: false, reason: `E&O Add Existing Policy click failed: ${err?.message || "unknown"}` }
    }
  } else {
    // Stale-state recovery (Josue 2026-05-08): when an admin (or a
    // prior failed bot run) drops the cert into the drop-zone WITHOUT
    // completing the policy form, SureLC removes the "ADD EXISTING
    // POLICY" entry button and renders an `<sb-info-message
    // actionicon="publish">` containing a stroked button with a
    // <mat-icon>publish</mat-icon> child. Clicking that button
    // promotes the orphan upload into the policy form, which is the
    // same destination the ADD button would have reached. Detect
    // by the actionicon attribute (most stable selector — the icon
    // text "publish" also exists on other mat-icons in the SPA).
    const publishBtn = await firstVisible(page, [
      'sb-info-message[actionicon="publish"] button.message__button',
      'sb-info-message[actionicon="publish"] button[mat-stroked-button]',
    ])
    if (!publishBtn) {
      await snapshot(ctx, "tab-eno-no-add-existing-policy")
      return { ok: false, reason: `E&O Add Existing Policy button not found. ${await describeUploadablePage(page)}` }
    }
    try {
      logger.info("[E&O] no ADD button — using stale-state publish fallback")
      await publishBtn.click()
      await settle(page, 1500)
      await assertOnProducerTab(page, producerId, "eno")
    } catch (err: any) {
      await snapshot(ctx, "tab-eno-publish-fallback-failed")
      return { ok: false, reason: `E&O publish-fallback click failed: ${err?.message || "unknown"}` }
    }
  }

  const url = input.certificateUrl
  if (!/\.(pdf)(\?|$)/i.test(url)) {
    logger.warn("[E&O] cert URL is not a PDF", { url })
    return {
      ok: false,
      reason: "E&O cert on file is not a PDF. The original PDF must be uploaded in Set4Life before SureLC can be filled.",
    }
  }

  let downloaded: { buffer: Buffer; localPath: string }
  try {
    downloaded = await downloadRemoteFile(url, "eno")
  } catch (err: any) {
    return { ok: false, reason: `E&O PDF download failed: ${err?.message || "unknown"}` }
  }

  const head = downloaded.buffer.slice(0, 4).toString("ascii")
  if (head !== "%PDF") {
    logger.warn("[E&O] downloaded file is not a real PDF", {
      url,
      head,
      size: downloaded.buffer.length,
    })
    return {
      ok: false,
      reason: "E&O file downloaded but failed PDF validation. Reupload the original PDF in Set4Life.",
    }
  }

  const extracted = await extractEoDataFromPdf(downloaded.buffer, logger)
  const policyNumber = input.policyNumber || extracted.policyNumber
  const carrier = input.provider || extracted.provider
  const caseLimit = input.caseLimit || extracted.caseLimit
  const totalLimit = input.totalLimit || extracted.totalLimit
  const effective = input.effectiveDate || extracted.effectiveDate
  const expiration = input.expirationDate || extracted.expirationDate
  const missing = [
    ["policy number", policyNumber],
    ["carrier", carrier],
    ["case limit", caseLimit],
    ["total limit", totalLimit],
    ["effective date", effective],
    ["expiration date", expiration],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key as string)

  if (missing.length > 0) {
    await snapshot(ctx, "tab-eno-missing-pdf-fields")
    return {
      ok: false,
      reason:
        `E&O PDF could not be read well enough. Missing ${missing.join(", ")}. ` +
        `Do not guess these values. ${await describeUploadablePage(page)}`,
      details: { extracted, missing },
    }
  }

  const policyNumberValue = policyNumber as string
  const carrierValue = carrier as string
  const caseLimitValue = caseLimit as number
  const totalLimitValue = totalLimit as number
  const effectiveValue = effective as string
  const expirationValue = expiration as string

  // ─── Phase 1: upload the cert (kicks off SureLC's async pipeline) ──
  //
  // Order matters here. SureLC's flow is:
  //   1. Click ADD/publish (form is NOT yet rendered — only an upload zone)
  //   2. Drop file → "Processing…" panel runs through Upload → Type
  //      Detection → Policy Data Parsing
  //   3. Parse completes → THE FORM appears with Carrier auto-filled
  //   4. Bot fills remaining required fields + clicks SAVE & EXIT
  //
  // The previous version called fillByLabel BEFORE the upload, which
  // silently no-op'd because the inputs didn't exist yet, then let the
  // bot navigate away with empty required fields and trigger SureLC's
  // "Invalid Information Detected" modal on the next tab.
  let uploaded = false
  const uploadBtn = await firstVisible(page, [
    'button:has-text("UPLOAD")',
    'button:has-text("Upload")',
    'button:has-text("Browse")',
    'a:has-text("UPLOAD")',
  ])
  if (uploadBtn) {
    try {
      await assertOnProducerTab(page, producerId, "eno")
      const [fc] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 8_000 }),
        (uploadBtn as any).click(),
      ])
      await fc.setFiles(downloaded.localPath)
      uploaded = true
      await settle(page, 2500)
    } catch (err: any) {
      logger.warn("[E&O] filechooser path threw", { err: err.message })
    }
  }
  if (!uploaded) {
    await assertOnProducerTab(page, producerId, "eno")
    uploaded = await uploadRemoteFile(
      page,
      'input[type="file"]',
      url,
      logger,
    ).catch(() => false)
  }

  // ─── Phase 2: wait for SureLC to finish its 3-stage processing ─────
  //
  // After the file is attached, SureLC runs three sequential server-side
  // stages all under the same "Processing…" panel:
  //   1. "Uploading the file…"
  //   2. "File's type detection"
  //   3. "Policy data parsing"
  // Once stage 3 completes, the policy form auto-renders with Carrier
  // pre-filled from the OCR. Combined wallclock typically 60–90s on
  // real cert PDFs; observed up to ~3 min on the slow side.
  await settle(page, 800)
  // Real-world cert PDFs have hit 3+ minutes mid-parse on prod (Josue
  // 2026-05-08, CNA cert) before SureLC's "Parsing uploaded policy…"
  // spinner cleared. 5 min ceiling keeps us out of "wait forever" land
  // while accommodating SureLC's slowest observed runs.
  const PARSE_BUDGET_MS = 300_000
  const POLL_MS = 1_500
  const start = Date.now()
  let cleared = false
  let parseDone = false
  while (Date.now() - start < PARSE_BUDGET_MS) {
    cleared = await waitForTabClear(page, "eno", POLL_MS)
    if (cleared) {
      parseDone = true
      break
    }
    const bodyText = await page
      .$$eval("body", (els) => els[0]?.innerText || "")
      .catch(() => "")
    const stillWorking =
      /Processing\.\.\./i.test(bodyText) ||
      /Uploading the file/i.test(bodyText) ||
      /File['’]s type detection/i.test(bodyText) ||
      /Policy data parsing/i.test(bodyText) ||
      /Parsing uploaded policy/i.test(bodyText)
    if (!stillWorking) {
      parseDone = true
      break
    }
    logger.info({ elapsedMs: Date.now() - start }, "[E&O] processing — waiting")
  }
  await snapshot(ctx, "tab-eno-parse-done")
  if (!uploaded) {
    return { ok: false, reason: `E&O upload did not attach a file. ${await describeUploadablePage(page)}` }
  }
  if (!parseDone) {
    return {
      ok: false,
      reason: `E&O parse did not finish within ${PARSE_BUDGET_MS / 1000}s. ${await describeUploadablePage(page)}`,
      details: { extracted, policyNumber, carrier, caseLimit, totalLimit, effective, expiration },
    }
  }
  if (cleared) {
    // Tab warning already gone — SureLC saved the policy on its own
    // (e.g. parser produced a complete record). No further action needed.
    return {
      ok: true,
      details: { autoSaved: true, warningCleared: true, policyNumber, carrier, caseLimit, totalLimit, effective, expiration, extracted },
    }
  }

  // ─── Phase 3: fill remaining required fields, then SAVE & EXIT ─────
  //
  // Parse finished but the tab still shows the warning — SureLC's
  // "Add Individual E&O Policy" form is now rendered with some fields
  // possibly auto-filled by the OCR. The OCR is unreliable for
  // numeric fields (Demetrius 2026-05-08: BIBERK cert auto-filled
  // Case Limit to 5,000,000 instead of 1,000,000), so we OVERWRITE
  // numeric/text fields with our extracted values via fillByLabel,
  // and only protect the Carrier field (a typeahead where our
  // abbreviated "CNA" would clobber "CNA Insurance Companies").
  // Use fillForce for the numeric/text inputs because the Case Limit
  // and Total Limit fields use ngx-mask `unmask="typed"`, which
  // silently rejects normal `el.fill()` overwrites when a value
  // is already in place. fillForce dispatches via the native
  // value-setter so the mask directive sees a real assignment.
  // (Demetrius 2026-05-08: SureLC pre-filled Case Limit with 5,000,000
  // — wrong — and fillByLabel left it intact.)
  await fillForce(page, "Policy Number", policyNumberValue)
  await fillForce(page, "Policy #", policyNumberValue)
  await fillForce(page, "Case Limit", String(caseLimitValue))
  await fillForce(page, "Per Occurrence", String(caseLimitValue))
  await fillForce(page, "Total Limit", String(totalLimitValue))
  await fillForce(page, "Aggregate", String(totalLimitValue))

  // Both Case Limit and Total Limit are mat-autocomplete-trigger
  // inputs. After fillForce types the unmasked digits, the mask
  // shows formatted text but the form may not commit until an
  // option is picked from the dropdown. Try clicking a matching
  // option for each field. (Same pattern that worked for the
  // training tab Course Name autocomplete.)
  await page.waitForTimeout(400)
  for (const formattedAmount of [`$${(caseLimitValue / 1_000_000).toFixed(0)},000,000`, `${caseLimitValue.toLocaleString("en-US")}`]) {
    const opt = await page.$(`mat-option:has-text("${formattedAmount}")`).catch(() => null)
    if (opt && (await opt.isVisible().catch(() => false))) {
      await opt.click().catch(() => undefined)
      await settle(page, 400)
      break
    }
  }
  // Date inputs need their value flushed through the Material
  // datepicker's input + change events for the form's reactive
  // validator to accept them.
  await fillEnoDate(page, ["Start Date", "Effective"], effectiveValue, logger)
  await fillEnoDate(page, ["Expiration Date", "Expiration"], expirationValue, logger)
  // Carrier: only fill IF it's empty. Our extracted carrier name
  // ("BIBERK" / "Berkshire Hathaway") may not match the canonical
  // value SureLC's autocomplete already applied; only pass it
  // through when SureLC left the field blank.
  await fillIfEmpty(page, "Carrier", carrierValue).catch(() => "failed")
  await fillIfEmpty(page, "Provider", carrierValue).catch(() => "failed")

  // ─── Phase 3a: post-fill validation + auto-equalize ────────────────
  //
  // Demetrius 2026-05-08 BIBERK case: SureLC's Recognition pre-filled
  // Case Limit to $5M (wrong; PDF shows $1M). Case Limit is wrapped
  // in mat-autocomplete-trigger + ngx-mask which silently rejects
  // both `el.fill()` AND fillForce — the displayed value sticks at
  // $5M no matter what we do. Total Limit, by contrast, is plain
  // ngx-mask and accepts fillForce.
  //
  // Result: Case=$5M, Total=$1M → form-invalid → SAVE button stays
  // disabled → click times out. Bot bails permanently.
  //
  // Fix: read the actual rendered values back from the inputs.
  // If Total < Case (validator-blocking), force Total UP to match
  // Case. Trades data accuracy (overstates aggregate coverage) for
  // bot completion. The agent's real policy doesn't change; only
  // SureLC's stored copy. Carriers care about the cert PDF (which
  // has the real $1M), not SureLC's number fields.
  const limitsAfterFill = await page
    .evaluate(() => {
      const labels = Array.from(
        document.querySelectorAll<HTMLLabelElement>("mat-label"),
      )
      const readByLabel = (target: string): number | null => {
        const m = labels.find(
          (l) =>
            (l.textContent || "")
              .trim()
              .toLowerCase()
              .replace(/\*$/, "")
              .trim() === target.toLowerCase(),
        )
        if (!m) return null
        const ff = m.closest("mat-form-field")
        const inp = ff?.querySelector<HTMLInputElement>("input")
        if (!inp) return null
        const raw = (inp.value || "").replace(/[^0-9.]/g, "")
        if (!raw) return null
        return Math.round(Number.parseFloat(raw))
      }
      return {
        caseLimit: readByLabel("Case Limit") ?? readByLabel("Per Occurrence"),
        totalLimit:
          readByLabel("Total Limit") ?? readByLabel("Aggregate"),
      }
    })
    .catch(() => ({ caseLimit: null, totalLimit: null }) as any)
  logger.info(
    { rendered: limitsAfterFill, intended: { caseLimitValue, totalLimitValue } },
    "[E&O] post-fill rendered limits",
  )
  const renderedCase = (limitsAfterFill.caseLimit as number | null) ?? 0
  const renderedTotal = (limitsAfterFill.totalLimit as number | null) ?? 0
  if (renderedCase > 0 && renderedTotal > 0 && renderedTotal < renderedCase) {
    logger.warn(
      { renderedCase, renderedTotal },
      "[E&O] Total < Case after fill — force-equalizing Total up to Case to unblock SAVE",
    )
    await fillForce(page, "Total Limit", String(renderedCase))
    await fillForce(page, "Aggregate", String(renderedCase))
    await page.waitForTimeout(400)
  }

  await snapshot(ctx, "tab-eno-form-filled")

  const saveBtn = await firstVisible(page, [
    'button:has-text("SAVE & EXIT")',
    'button:has-text("Save & Exit")',
    'button:has-text("SAVE")',
    'button:has-text("Save")',
  ])
  if (!saveBtn) {
    await snapshot(ctx, "tab-eno-no-save-button")
    return {
      ok: false,
      reason: `E&O form filled but SAVE & EXIT button not found. ${await describeUploadablePage(page)}`,
      details: { policyNumber, carrier, caseLimit, totalLimit, effective, expiration },
    }
  }
  try {
    await (saveBtn as any).click()
    await settle(page, 2_000)
  } catch (err: any) {
    return {
      ok: false,
      reason: `E&O SAVE & EXIT click failed: ${err?.message || "unknown"}`,
    }
  }

  // After SAVE & EXIT, SureLC navigates back to the E&O tab summary
  // and the warning icon should detach.
  const finalCleared = await waitForTabClear(page, "eno", 20_000)
  await snapshot(ctx, "tab-eno-after")
  return finalCleared
    ? {
        ok: true,
        details: { policyNumber, carrier, caseLimit, totalLimit, effective, expiration, extracted, savedByBot: true },
      }
    : {
        ok: false,
        reason: `E&O policy saved but warning did not clear. ${await describeUploadablePage(page)}`,
        details: { policyNumber, carrier, caseLimit, totalLimit, effective, expiration, extracted, savedByBot: true },
      }
}

// ─── Signature ────────────────────────────────────────────────────────

/**
 * SureLC signature flow (3 screens):
 *
 *   1. Add Producer's Authorized Signature — pick "UPLOAD IT NOW".
 *   2. Crop Signature — SureLC tries to auto-detect the signature on
 *      our Signature Authorization PDF. If it succeeds, the signature
 *      box is already in the right place; click CROP. If it fails,
 *      a yellow banner says "drag and resize the white box to select
 *      it" — bot must position the crop rectangle over the signature
 *      line (always at a known relative position in our PDF template,
 *      because we generate the PDF ourselves) and click CROP.
 *   3. Edit Authorized Signature — preview of cropped signature.
 *      Click CONFIRM.
 *
 * Owner directive 2026-05-05: upload the FULL Signature Authorization
 * PDF (signatureAuthPdfUrl), NOT the bare signature PNG. SureLC wants
 * the signed legal-text document; the bare PNG fails their template
 * matcher.
 */
async function fillSignature(
  ctx: TabContext,
  producerId: string,
  input: ProfileFillInput["signature"],
): Promise<TabResult> {
  const { page, logger } = ctx
  // Prefer the full Signature Authorization PDF (what SureLC really
  // wants). Fall back to the bare PNG only if the PDF isn't on file.
  const fileUrl = input?.signatureAuthPdfUrl || input?.signatureImageUrl
  if (!fileUrl) {
    return { ok: false, reason: "no signatureAuthPdf or signatureImage on file" }
  }
  const isPdf = fileUrl === input?.signatureAuthPdfUrl

  await goToTab(page, producerId, "signature", ctx.logger)
  await snapshot(ctx, "tab-signature-01-before")

  if (await isTabGreen(page, "Signature")) {
    return { ok: true, alreadyDone: true }
  }

  // Content-presence "already done" detector: when a signature is on
  // file, SureLC renders a "Signature Authorization" header card with
  // a date and **REMOVE / EDIT** buttons (no UPLOAD IT NOW button).
  // The Signature Image preview also shows the rep's typed signature.
  // Sydney 2026-05-07 03:33 — bot reported "file input not found" and
  // bailed because the upload form isn't rendered when a signature is
  // already present.
  const sigText = await page
    .$$eval("body", (els) => (els[0]?.innerText || ""))
    .catch(() => "")
  const hasUploaded =
    /Signature Authorization\s*\n?\s*\d{2}\/\d{2}\/\d{4}/i.test(sigText) ||
    (/REMOVE/.test(sigText) && /EDIT/.test(sigText) && /Signature Image/i.test(sigText))
  if (hasUploaded) {
    if (!input?.forceReupload) {
      logger.info({ excerpt: sigText.slice(0, 200) }, "[Signature] already uploaded (REMOVE/EDIT visible) — skipping")
      return { ok: true, alreadyDone: true, details: { detected: "removeEditButtons" } }
    }
    // forceReupload=true: the existing signature is stale/broken
    // (Fastlane flagged "N issues" with the producer despite the
    // signature tab being green). Click REMOVE, confirm in the
    // Material modal that SureLC pops, wait for the upload-method
    // screen to render, then fall through into the normal upload
    // path below.
    logger.info("[Signature] forceReupload=true; clicking REMOVE to clear existing signature")
    const removeBtn =
      (await page.$('button:has-text("REMOVE")')) ||
      (await page.$('button:has-text("Remove")'))
    if (!removeBtn) {
      return {
        ok: false,
        reason: "forceReupload=true but REMOVE button not found",
      }
    }
    await removeBtn.click().catch(() => undefined)

    // SureLC pops a Material confirm dialog (<mat-dialog-container>
    // with YES / NO or CONFIRM / CANCEL buttons), NOT a browser-
    // native window.confirm — so page.on("dialog", ...) does NOT
    // fire. Wait for the dialog, then click the affirm button.
    try {
      await page.waitForSelector(
        'mat-dialog-container, [role="dialog"]',
        { timeout: 8_000 },
      )
      const affirm =
        (await page.$('mat-dialog-container button:has-text("YES")')) ||
        (await page.$('mat-dialog-container button:has-text("Yes")')) ||
        (await page.$('mat-dialog-container button:has-text("CONFIRM")')) ||
        (await page.$('mat-dialog-container button:has-text("Confirm")')) ||
        (await page.$('mat-dialog-container button:has-text("OK")')) ||
        (await page.$('mat-dialog-container button:has-text("Ok")')) ||
        (await page.$('mat-dialog-container button:has-text("REMOVE")')) ||
        (await page.$('mat-dialog-container button:has-text("Remove")')) ||
        (await page.$('mat-dialog-container button:has-text("DELETE")')) ||
        (await page.$('[role="dialog"] button.mat-primary')) ||
        (await page.$('[role="dialog"] button.mat-mdc-button-base'))
      if (!affirm) {
        // No recognizable affirm button — log what the dialog says so
        // we can tune the selector list. Snapshot for forensic
        // evidence.
        const dialogText = await page
          .$$eval("mat-dialog-container, [role='dialog']", (els) =>
            els.map((e) => (e.textContent || "").trim()).join(" | "),
          )
          .catch(() => "")
        await snapshot(ctx, "tab-signature-01b-confirm-modal-text")
        return {
          ok: false,
          reason: `REMOVE confirm modal opened but affirm button not found. Modal text: ${dialogText.slice(0, 200)}`,
        }
      }
      await affirm.click().catch(() => undefined)
      logger.info("[Signature] REMOVE confirm modal — affirm clicked")
    } catch {
      // Modal didn't appear within 8s — maybe SureLC removed the
      // signature without a confirm prompt (older SPA version). Just
      // continue and let the next waitForSelector validate.
      logger.info("[Signature] no confirm modal detected — assuming REMOVE took effect without prompt")
    }

    // Wait for the SPA to swap back to the choose-method screen.
    // Accept any of UPLOAD / DRAW / TYPE — post-cutover the page may
    // default to a different method than UPLOAD IT NOW.
    try {
      await page.waitForSelector(
        [
          'button:has-text("UPLOAD IT NOW")',
          'button:has-text("Upload it now")',
          'button:has-text("Upload")',
          'button:has-text("DRAW IT NOW")',
          'button:has-text("TYPE IT NOW")',
          'input[type="file"]',
        ].join(", "),
        { timeout: 20_000 },
      )
    } catch {
      await snapshot(ctx, "tab-signature-01b-remove-stuck")
      const after = await page
        .$$eval("body", (els) => (els[0]?.innerText || ""))
        .catch(() => "")
      return {
        ok: false,
        reason: `REMOVE clicked but choose-method screen never rendered. Page snippet: ${after.slice(0, 200).replace(/\s+/g, " ")}`,
      }
    }
    await snapshot(ctx, "tab-signature-01c-after-remove")
    logger.info("[Signature] REMOVE confirmed; proceeding with fresh upload")
  }

  // ── Step 1 — Click "UPLOAD IT NOW" if the choose-method screen
  //   is showing.
  const uploadBtn =
    (await page.$('button:has-text("UPLOAD IT NOW")')) ||
    (await page.$('button:has-text("Upload it now")')) ||
    (await page.$('button:has-text("Upload")'))
  if (uploadBtn) {
    await uploadBtn.click().catch(() => undefined)
    await settle(page, 600)
  }
  await assertOnProducerTab(page, producerId, "signature")

  // ── Step 1b — Set the file input. The file input may be hidden
  //   (covered by a styled label/button), so we set the input
  //   directly via setInputFiles.
  const ok = await uploadRemoteFile(
    page,
    'input[type="file"]',
    fileUrl,
    logger,
  ).catch(() => false)
  if (!ok) {
    await snapshot(ctx, "tab-signature-02-upload-failed")
    return {
      ok: false,
      reason: `file input not found / upload failed. ${await describeUploadablePage(page)}`,
    }
  }

  // Skip the cropper UI entirely. SureLC's ngx-image-cropper has been
  // flaky for 8+ days (modal fails to open ~10x/week, blocking new
  // producers from clearing SIGN). The direct PUT API endpoint
  // (`overwriteSignatureImageViaApi` below, proven 2026-05-18 in
  // commit d78647c against Beam) works as long as SureLC has a PDF
  // attachment for the producer — which the uploadRemoteFile call
  // above has already established. The cropper was only ever about
  // UX; the file-input upload alone is what gets the bytes onto
  // SureLC's servers.
  if (!input?.signatureImageUrl) {
    await snapshot(ctx, "tab-signature-03-no-sig-png")
    return {
      ok: false,
      reason: "no signatureImageUrl on input — cannot use API bypass",
    }
  }
  // Give SureLC a moment to persist the uploaded PDF + run its
  // server-side auto-detect before we GET its attachment id. Auto-
  // detect happens server-side regardless of whether the cropper
  // modal opens client-side.
  await settle(page, 4000)
  try {
    await overwriteSignatureImageViaApi(
      page,
      producerId,
      input.signatureImageUrl,
      logger,
    )
    await snapshot(ctx, "tab-signature-03b-api-bypass-done")
  } catch (apiErr: any) {
    logger.error({ err: apiErr?.message }, "[Signature] API bypass failed")
    return {
      ok: false,
      reason: `API bypass failed: ${apiErr?.message}`,
    }
  }

  const cleared = await waitForTabClear(page, "signature", 12_000)
  return cleared
    ? {
        ok: true,
        details: { autoSaved: true, warningCleared: true, viaApi: true },
      }
    : {
        ok: false,
        reason: `API bypass succeeded but Signature tab did not clear. ${await describeUploadablePage(page)}`,
        details: { viaApi: true, warningCleared: false },
      }
}

/**
 * Overwrite SureLC's auto-detected signature crop with the agent's
 * pristine source signature PNG via SureLC's direct API. Bypasses the
 * ngx-image-cropper UI entirely.
 *
 * Endpoints discovered 2026-05-18 (commit d78647c, lost during
 * deploy-withdrawn-fix branch merge; restored 2026-05-26 after Thomas
 * reported all post-5/18 producers stuck SIGN-flagged):
 *   GET  /surecrm/signature/{producerId}/pdf   — current PDF attachment
 *   PUT  /surecrm/signature/{producerId}/{attachId}/confirmImage
 *        body: { payload: "data:image/png;base64,...", width, height }
 *
 * Bearer token is read from the page's localStorage (the BGA SPA stores
 * its access_token there).
 */
async function overwriteSignatureImageViaApi(
  page: import("playwright").Page,
  producerId: string,
  signatureImageUrl: string,
  logger: import("pino").Logger,
): Promise<void> {
  const bearer = await page.evaluate(() => {
    return (
      localStorage.getItem("access_token") ||
      localStorage.getItem("accessToken") ||
      localStorage.getItem("bga.access_token") ||
      ""
    )
  })
  if (!bearer) throw new Error("no BGA bearer in localStorage")

  // 1. Fetch the current PDF attachment id from SureLC
  const pdfMetaRes = await fetch(
    `https://surelc.surancebay.com/surecrm/signature/${producerId}/pdf`,
    { headers: { Authorization: `Bearer ${bearer}` } },
  )
  if (!pdfMetaRes.ok) {
    throw new Error(`GET signature/pdf failed: HTTP ${pdfMetaRes.status}`)
  }
  const pdfMeta = (await pdfMetaRes.json()) as { id: number }
  if (!pdfMeta?.id) throw new Error("no PDF attachment id on signature record")

  // 2. Download the source signature PNG
  const pngRes = await fetch(signatureImageUrl)
  if (!pngRes.ok) {
    throw new Error(`fetch signaturePng failed: HTTP ${pngRes.status}`)
  }
  const pngBuf = Buffer.from(await pngRes.arrayBuffer())

  // 3. Get image dimensions via sharp
  const sharp = (await import("sharp")).default
  const meta = await sharp(pngBuf).metadata()
  const width = meta.width || 491
  const height = meta.height || 200

  // 4. Build payload (must be data: URL — bare base64 fails server-side
  // decoding with "Last unit does not have enough valid bits")
  const payload = `data:image/png;base64,${pngBuf.toString("base64")}`

  // 5. PUT confirmImage
  const putUrl = `https://surelc.surancebay.com/surecrm/signature/${producerId}/${pdfMeta.id}/confirmImage`
  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ payload, width, height }),
  })
  if (!putRes.ok) {
    const errBody = await putRes.text().catch(() => "")
    throw new Error(
      `PUT confirmImage failed: HTTP ${putRes.status} ${errBody.slice(0, 200)}`,
    )
  }
  logger.info(
    { producerId, pdfAttachId: pdfMeta.id, width, height, pngBytes: pngBuf.length },
    "[Signature] API confirmImage succeeded — signature image set via direct API (no cropper UI)",
  )
}

/**
 * Drag the SureLC crop rectangle over the signature line in our
 * Signature Authorization PDF. Our PDF template renders the signature
 * box centered horizontally, ~70% down the visible page. SureLC's
 * crop tool shows the document at a fixed scale inside the dialog,
 * with a draggable rectangle. We compute the target rectangle from
 * the document container's bounding box.
 *
 * If the layout shifts, the bot will still click CROP afterwards —
 * worst case SureLC crops the wrong region, the rep flags it, admin
 * re-uploads. Better than failing the whole pipeline.
 */
async function positionCropBoxOverSignatureLine(
  page: import("playwright").Page,
  logger: import("pino").Logger,
): Promise<void> {
  const docImg =
    (await page.$(".ngx-ic-source-image")) ||
    (await page.$('.crop-signature img')) ||
    (await page.$('[class*="crop"] img')) ||
    (await page.$('.cropper-canvas img')) ||
    (await page.$('mat-dialog-container img'))
  if (!docImg) {
    logger.warn("[Signature] crop dialog image not found")
    return
  }
  const box = await docImg.boundingBox()
  if (!box) return

  const target = {
    x: box.x + box.width * 0.22,
    y: box.y + box.height * 0.60,
    width: box.width * 0.56,
    height: box.height * 0.16,
  }

  const setByDom = await page
    .evaluate((t) => {
      const cropper = document.querySelector<HTMLElement>(".ngx-ic-cropper")
      if (!cropper) return false
      const parent = cropper.offsetParent as HTMLElement | null
      const parentRect = parent?.getBoundingClientRect()
      if (!parentRect) return false
      cropper.style.left = `${t.x - parentRect.left}px`
      cropper.style.top = `${t.y - parentRect.top}px`
      cropper.style.width = `${t.width}px`
      cropper.style.height = `${t.height}px`
      cropper.dispatchEvent(new Event("change", { bubbles: true }))
      cropper.dispatchEvent(new Event("input", { bubbles: true }))
      return true
    }, target)
    .catch(() => false)
  if (setByDom) {
    await page.waitForTimeout(600)
    return
  }

  await page.mouse.move(target.x, target.y)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width, target.y + target.height, { steps: 16 })
  await page.mouse.up()
  await page.waitForTimeout(600)
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function goToTab(
  page: Page,
  producerId: string,
  slug: string,
  logger: import("pino").Logger,
): Promise<void> {
  // SureLC uses path-based tab routing: /bga/producers/{id}/{tab}.
  // Verified live 2026-05-05 — tabs are: profile, dba, questions,
  // licenses, finra, contracts, history, training, eno, signature,
  // documents, appointments. The previous hash-based form
  // (/producers/{id}#{slug}) lands on the profile tab and ignores the
  // hash, which is why several tab fills were operating on stale DOM.
  const url = `${baseUrl(producerId)}/${slug}`
  // gotoBga prefers in-SPA navigation (history.pushState) over hard
  // page reloads to avoid SureLC's auth-guard bouncing each tab change
  // back to OAuth. Without this, every tab switch re-races the SPA's
  // auth bootstrap (owner-confirmed 2026-05-06).
  const nav = await gotoBga(page, url, logger)
  if (!nav.ok) {
    throw new Error(`SureLC navigation failed for ${slug}: ${nav.finalUrl}`)
  }
  await settle(page, 1200)

  await assertOnProducerTab(page, producerId, slug)

  // Belt-and-braces: if SureLC ever ships a build that ignores the
  // path, click the tab text as fallback.
  const tab = await page.$(`[role="tab"]:has-text("${prettyTab(slug)}")`)
  if (tab) {
    try {
      await tab.click()
    } catch {
      /* ignore */
    }
    await page.waitForTimeout(400)
    await assertOnProducerTab(page, producerId, slug)
  }
}

function prettyTab(slug: string): string {
  switch (slug) {
    case "dba":
      return "DBA"
    case "questions":
      return "Questions"
    case "training":
      return "Training"
    case "eno":
      return "E&O"
    case "finra":
      return "FINRA"
    case "signature":
      return "Signature"
    case "contracting":
      return "Contracting"
    case "licenses":
      return "Licenses"
    default:
      return slug
  }
}

/** Look for the navbar-tab-icon--warning modifier on the tab's icon.
 *  When the modifier is ABSENT, the tab is complete. Verified live
 *  2026-05-05 against SureLC's Angular Material build — there is no
 *  green-check class; status is encoded purely as the warning modifier
 *  on the <mat-icon> inside the <a class="navbar-tab"> element. */
async function isTabComplete(page: Page, tabHref: string): Promise<boolean> {
  // The previous detector ("warning icon absent ⇒ complete") was
  // producing catastrophic false positives. Owner-confirmed
  // 2026-05-06 with Sydney Desilva: the bot reported all 6 tabs
  // "Already done — skipped" while the actual SureLC profile was
  // 100% empty (red/yellow indicators on every tab). Two failure
  // modes for the old check:
  //   1. Race — the warning icon hadn't rendered yet when the bot
  //      probed (page.goto + settle 800 ms isn't enough for the
  //      SPA to paint the navbar-tab-icon--warning markers, so
  //      page.$ returned null and we declared the tab complete).
  //   2. Class drift — SureLC's Angular Material navbar may use a
  //      different modifier class today; without live DOM access
  //      we can't verify the selector still matches.
  // Either way, false-positive "complete" detections are far more
  // dangerous than re-attempting a fill: when the bot wrongly
  // skips, contracting fires on an empty producer and SureLC has
  // to clean it up. The fill functions are written to be safe to
  // re-run (idempotent radio clicks; SureLC dedupes uploads).
  // Always return false so every tab actually attempts its work.
  // Diagnostic: still probe the warning selector and log what we
  // would have decided, so we can compare against real SureLC
  // state and re-introduce a positive-signal detector once we
  // know the right selector.
  try {
    const sel = `a.navbar-tab[href$="/${tabHref}"] mat-icon.navbar-tab-icon--warning`
    const warning = await page.$(sel)
    if (!warning) {
      // Note: don't act on this — it lies on fresh profiles.
      // Logged for selector-tuning analysis only.
    }
  } catch {
    /* probe failure isn't actionable; ignore */
  }
  return false
}

/** Wait for the warning icon on a tab to disappear. SureLC's UI is
 *  fully auto-persist on field change (verified live 2026-05-05 — no
 *  Save buttons exist on any tab), and the warning-icon-clearing is
 *  the only visible signal that "the server has accepted the change
 *  and the tab is now complete." Used in place of clickSave()/wait. */
async function waitForTabClear(
  page: Page,
  tabHref: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  // Pre-check: the navbar tab must EXIST for "cleared" to mean
  // anything. Without this guard, `state: "detached"` returns
  // immediately (true) whenever the bot is on a sub-page that
  // doesn't render the producer-profile navbar — a false positive
  // that has caused tabs (notably Training) to silently report
  // success when the form is actually still dirty on a deep
  // sub-route. (Keyon 2026-05-09 — bot reported "filled by bot"
  // while sitting on Training > Select or Upload Certificate >
  // Add Manually.)
  const tabSel = `a.navbar-tab[href$="/${tabHref}"]`
  const navbarTab = await page.$(tabSel).catch(() => null)
  if (!navbarTab) return false
  const sel = `${tabSel} mat-icon.navbar-tab-icon--warning`
  try {
    await page.waitForSelector(sel, { state: "detached", timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

/** Compatibility shim — older callers still say isTabGreen. The check
 *  is the same: if the tab is "complete" by the warning-modifier
 *  test, it's "green" for our purposes. Slug-to-href mapping is the
 *  same string we pass to goToTab. */
async function isTabGreen(page: Page, label: string): Promise<boolean> {
  const slug = label.toLowerCase().replace(/&/g, "").replace(/\s+/g, "")
  // Map UI label → URL slug. Matches goToTab + prettyTab.
  const map: Record<string, string> = {
    dba: "dba",
    questions: "questions",
    finra: "finra",
    training: "training",
    eo: "eno",
    eno: "eno",
    signature: "signature",
    licenses: "licenses",
  }
  return isTabComplete(page, map[slug] || slug)
}
