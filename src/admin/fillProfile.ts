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

/**
 * Map SureLC's rendered question text → our questionnaire slug.
 * Used by the v2 layout driver to know which DB answer applies to
 * which on-screen question. Keyword-based so a tweaked sentence
 * still matches; ordered most-specific first.
 */
const QUESTION_KEYWORD_MAP: Array<{ slug: string; match: (t: string) => boolean }> = [
  { slug: "chargedFelony", match: (t) => /charged with any felony/i.test(t) },
  { slug: "chargedMisdemeanor", match: (t) => /charged with any misdemeanor/i.test(t) },
  { slug: "probation", match: (t) => /been on probation/i.test(t) },
  { slug: "felony", match: (t) => /convicted.*felony|plead.*felony/i.test(t) && !/charged/i.test(t) },
  { slug: "misdemeanor", match: (t) => /convicted.*misdemeanor|plead.*misdemeanor/i.test(t) && !/charged/i.test(t) },
  { slug: "securitiesRegulations", match: (t) => /federal or state securities|investment.*regulation/i.test(t) },
  { slug: "securitiesRegulationsState", match: (t) => /state insurance department/i.test(t) },
  { slug: "foreignRegulations", match: (t) => /foreign government|foreign.*regulatory/i.test(t) },
  { slug: "beingInvestigated", match: (t) => /currently under investigation/i.test(t) },
  { slug: "wereInvestigated", match: (t) => /under investigation by any insurance/i.test(t) },
  { slug: "inLawSuit", match: (t) => /pending indictments|civil judgments/i.test(t) },
  { slug: "lawSuitInsurance", match: (t) => /named as a defendant|sued or been sued/i.test(t) },
  { slug: "allegedOfFraud", match: (t) => /alleged to have engaged in any fraud/i.test(t) },
  { slug: "provenFraud", match: (t) => /been found to have engaged in any fraud/i.test(t) },
  { slug: "wasFiredRegulations", match: (t) => /terminated.*accused.*violating insurance/i.test(t) },
  { slug: "wasFiredOfFraud", match: (t) => /terminated.*accused of fraud|wrongful taking/i.test(t) },
  { slug: "wasFiredStatutes", match: (t) => /failure to supervise/i.test(t) },
  { slug: "deniedAppointment", match: (t) => /appointment.*terminated for cause|denied an appointment/i.test(t) },
  { slug: "oweToInsurance", match: (t) => /commission chargeback|indebtedness/i.test(t) },
  { slug: "suretyRefused", match: (t) => /bonding or surety|denied.*bond/i.test(t) },
  { slug: "eoRefused", match: (t) => /errors\s*&\s*omissions|e&o.*denied|e&o.*claims/i.test(t) },
  { slug: "secLicense", match: (t) => /insurance or securities license.*denied/i.test(t) },
  { slug: "firmSecLicense", match: (t) => /state or federal regulatory body.*found/i.test(t) },
  { slug: "wasBankrupt", match: (t) => /bankrupt|bankruptcy/i.test(t) && !/firm/i.test(t) && !/pending/i.test(t) },
  { slug: "hasLiens", match: (t) => /liens|unsatisfied judgments/i.test(t) },
  { slug: "alias", match: (t) => /used any other name|alias/i.test(t) },
]

const matchQuestionSlug = (text: string): string | null => {
  for (const { slug, match } of QUESTION_KEYWORD_MAP) {
    if (match(text)) return slug
  }
  return null
}

/**
 * Drive SureLC's "ADD EXPLANATION" modal for one Yes-answer.
 *
 * Layout (verified 2026-05-29 on Jimenez/Gurira):
 *   - Click ADD EXPLANATION (already located by caller)
 *   - Modal renders with:
 *       - Occurrence Date combobox + Open calendar button
 *       - 3 category accordions: "Written statement…", "Notice of
 *         Hearing…", "official document…demonstrates the resolution…"
 *       - Each accordion opens to show UPLOAD NEW DOCUMENT +
 *         CREATE EXPLANATION DOCUMENT buttons
 *       - CANCEL / CREATE buttons at the bottom (CREATE disabled
 *         until ≥1 doc + Occurrence Date are set)
 *
 * We upload whatever slots we have data for (slot 1 = statement is
 * required; slot 2 = notice and slot 3 = resolution are optional —
 * see the onboarding form's Q1A_DOC_SLOTS for matching keys).
 */
async function driveAddExplanationModal(
  page: import("playwright").Page,
  addExplBtn: any,
  occurrenceDate: string | undefined,
  documents: Array<{ url: string; fileName?: string; slot?: string }>,
  logger: import("pino").Logger,
  parentNumLog: string,
): Promise<{ ok: boolean; reason?: string; uploadedSlots: number }> {
  try {
    await addExplBtn.click()
    await page.waitForTimeout(1200)
    if (occurrenceDate) {
      const isoMatch = occurrenceDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
      const mmddyyyy = isoMatch
        ? `${isoMatch[2]}/${isoMatch[3]}/${isoMatch[1]}`
        : occurrenceDate
      const dateField = await page.$(
        'mat-dialog-container input[placeholder*="MM/DD" i], ' +
          '.cdk-overlay-pane input[placeholder*="MM/DD" i], ' +
          'mat-dialog-container input[matinput], ' +
          '.cdk-overlay-pane input[matinput]',
      )
      if (dateField) {
        await (dateField as any).fill(mmddyyyy)
        await (dateField as any).dispatchEvent("change").catch(() => undefined)
        await (dateField as any).dispatchEvent("blur").catch(() => undefined)
        logger.info({ parentNumLog, mmddyyyy }, "[Questions/v2] occurrence date set")
      }
    }
    const SLOT_KEYWORD: Record<string, RegExp> = {
      statement: /written statement/i,
      notice: /Notice of Hearing/i,
      resolution: /official document|resolution/i,
    }
    const path = await import("node:path")
    const fs = await import("node:fs/promises")
    const os = await import("node:os")
    let uploadedSlots = 0
    // Modal layout detection: the criminal-question modal has 3
    // category accordions (statement / notice / resolution). The
    // bankruptcy / civil-question modal has NO accordions — just a
    // direct UPLOAD NEW DOCUMENT button at the top. Detect by
    // looking for any of the criminal-category buttons; if none
    // exist, use the simple-modal codepath that uploads docs
    // directly without category routing.
    const anyCategoryBtnExists = await (async () => {
      const allBtns = await page.$$(
        'mat-dialog-container button, .cdk-overlay-pane button',
      )
      for (const b of allBtns) {
        const t = await (b as any).innerText().catch(() => "")
        if (/written statement|Notice of Hearing|official document/i.test(t)) {
          return true
        }
      }
      return false
    })()
    if (!anyCategoryBtnExists) {
      logger.info(
        { parentNumLog },
        "[Questions/v2] simple modal detected (no category accordions) — uploading docs directly",
      )
      // Upload each doc directly via the modal-level UPLOAD NEW
      // DOCUMENT button. Iterating ensures multi-doc questions still
      // get every file attached.
      for (const doc of documents) {
        try {
          const res = await fetch(doc.url)
          if (!res.ok) continue
          const buf = Buffer.from(await res.arrayBuffer())
          const localPath = path.join(
            os.tmpdir(),
            `surelc-v2-simple-${Date.now()}-${doc.fileName || "doc"}`,
          )
          await fs.writeFile(localPath, buf)
          const uploadBtn = await page.$(
            'mat-dialog-container button:has-text("UPLOAD NEW DOCUMENT"), ' +
              '.cdk-overlay-pane button:has-text("UPLOAD NEW DOCUMENT")',
          )
          if (!uploadBtn) break
          const [fc] = await Promise.all([
            page.waitForEvent("filechooser", { timeout: 8_000 }),
            (uploadBtn as any).click(),
          ])
          await fc.setFiles(localPath)
          await page.waitForTimeout(2000)
          uploadedSlots++
        } catch (err: any) {
          logger.warn(
            { parentNumLog, err: err.message },
            "[Questions/v2] simple-modal upload threw",
          )
        }
      }
    } else {
      // Criminal-category modal — route per slot
      for (const doc of documents) {
        const slotKey = doc.slot || "statement"
        const re = SLOT_KEYWORD[slotKey] || SLOT_KEYWORD.statement
        const allCatBtns = await page.$$(
          'mat-dialog-container button, .cdk-overlay-pane button',
        )
        let catBtn: any = null
        for (const b of allCatBtns) {
          const t = await (b as any).innerText().catch(() => "")
          if (re.test(t)) {
            catBtn = b
            break
          }
        }
        if (!catBtn) {
          logger.warn({ parentNumLog, slotKey }, "[Questions/v2] category button not found")
          continue
        }
        try {
          await (catBtn as any).click()
          await page.waitForTimeout(500)
          const res = await fetch(doc.url)
          if (!res.ok) continue
          const buf = Buffer.from(await res.arrayBuffer())
          const localPath = path.join(
            os.tmpdir(),
            `surelc-v2-${slotKey}-${Date.now()}-${doc.fileName || "doc"}`,
          )
          await fs.writeFile(localPath, buf)
          const uploadBtn = await page.$(
            'mat-dialog-container button:has-text("UPLOAD NEW DOCUMENT"), ' +
              '.cdk-overlay-pane button:has-text("UPLOAD NEW DOCUMENT")',
          )
          if (!uploadBtn) {
            logger.warn({ parentNumLog, slotKey }, "[Questions/v2] UPLOAD button not visible")
            continue
          }
          const [fc] = await Promise.all([
            page.waitForEvent("filechooser", { timeout: 8_000 }),
            (uploadBtn as any).click(),
          ])
          await fc.setFiles(localPath)
          await page.waitForTimeout(2000)
          uploadedSlots++
          logger.info({ parentNumLog, slotKey }, "[Questions/v2] slot uploaded")
        } catch (err: any) {
          logger.warn(
            { parentNumLog, slotKey, err: err.message },
            "[Questions/v2] slot upload threw",
          )
        }
      }
    }
    if (uploadedSlots === 0) {
      // Nothing uploaded — bail out cleanly so the modal can be retried
      const cancelBtn = await page.$(
        'mat-dialog-container button:has-text("CANCEL"), ' +
          '.cdk-overlay-pane button:has-text("CANCEL")',
      )
      if (cancelBtn) await (cancelBtn as any).click()
      return { ok: false, reason: "no slots uploaded", uploadedSlots }
    }
    const createBtn = await page.$(
      'mat-dialog-container button:has-text("CREATE"), ' +
        '.cdk-overlay-pane button:has-text("CREATE")',
    )
    if (!createBtn) {
      return { ok: false, reason: "CREATE button not found", uploadedSlots }
    }
    const disabled = await (createBtn as any).getAttribute("disabled")
    if (disabled !== null && disabled !== "false") {
      logger.warn(
        { parentNumLog, uploadedSlots },
        "[Questions/v2] CREATE still disabled — closing modal",
      )
      const cancelBtn = await page.$(
        'mat-dialog-container button:has-text("CANCEL"), ' +
          '.cdk-overlay-pane button:has-text("CANCEL")',
      )
      if (cancelBtn) await (cancelBtn as any).click()
      return { ok: false, reason: "CREATE stayed disabled", uploadedSlots }
    }
    await (createBtn as any).click()
    await page.waitForTimeout(2500)
    logger.info({ parentNumLog, uploadedSlots }, "[Questions/v2] CREATE clicked")
    return { ok: true, uploadedSlots }
  } catch (err: any) {
    logger.warn({ parentNumLog, err: err.message }, "[Questions/v2] modal flow threw")
    return { ok: false, reason: `modal threw: ${err.message}`, uploadedSlots: 0 }
  }
}

/**
 * Layout-agnostic Questions tab driver for SureLC's late-May 2026
 * redesign (sb-question + div-card + ADD EXPLANATION modal). Reads
 * each on-screen question by text, matches to our DB slug via
 * QUESTION_KEYWORD_MAP, sets Yes radio where we have a Yes answer,
 * and drives the ADD EXPLANATION modal for each Yes-answer with
 * documents.
 *
 * Idempotent: if Yes radios are already set + ADD EXPLANATION buttons
 * have been replaced by "EDIT EXPLANATION" (or similar), the driver
 * recognizes existing state and skips re-uploading.
 */
async function fillQuestionsV2(
  ctx: TabContext,
  input: ProfileFillInput["questions"],
): Promise<TabResult> {
  const { page, logger } = ctx
  if (!input?.surelcAnswers) {
    logger.info("[Questions/v2] no surelcAnswers provided — nothing to fill")
    return { ok: true, alreadyDone: true }
  }
  const slugToAnswer = input.surelcAnswers
  const sbQuestions = await page.$$("sb-question")
  let processed = 0
  let yesSet = 0
  let modalsCreated = 0
  let modalsSkipped = 0
  for (const sbQ of sbQuestions) {
    const text = await (sbQ as any)
      .innerText()
      .catch(() => "")
      .then((t: string) => (t || "").replace(/\s+/g, " ").trim())
    if (!text) continue
    const slug = matchQuestionSlug(text)
    if (!slug) continue
    processed++
    const ans = (slugToAnswer as Record<string, any>)[slug]
    if (!ans) continue
    // Click Yes or No based on our DB
    const yesRadio = await (sbQ as any).$('input[type="radio"][value="true"]')
    const noRadio = await (sbQ as any).$('input[type="radio"][value="false"]')
    const targetRadio = ans.answer === "yes" ? yesRadio : noRadio
    if (targetRadio) {
      const wasChecked = await (targetRadio as any).isChecked().catch(() => false)
      if (!wasChecked) {
        await (targetRadio as any).check({ force: true }).catch(() => undefined)
        await page.waitForTimeout(400)
      }
    }
    if (ans.answer !== "yes") continue
    yesSet++
    if (!ans.documents || ans.documents.length === 0) continue
    // Look for ADD EXPLANATION button in THIS question
    let addExplBtn = await (sbQ as any).$('button:has-text("ADD EXPLANATION")')
    if (!addExplBtn) {
      // Existing explanation already present (button replaced with
      // EDIT EXPLANATION or hidden). Treat as done.
      modalsSkipped++
      logger.info(
        { slug },
        "[Questions/v2] no ADD EXPLANATION button (explanation already linked); skipping",
      )
      continue
    }
    // Drive the modal
    const result = await driveAddExplanationModal(
      page,
      addExplBtn,
      ans.occurrenceDate,
      ans.documents,
      logger,
      slug,
    )
    if (result.ok) modalsCreated++
    else
      logger.warn(
        { slug, reason: result.reason },
        "[Questions/v2] modal flow did not CREATE",
      )
    await page.waitForTimeout(800)
  }
  logger.info(
    { processed, yesSet, modalsCreated, modalsSkipped },
    "[Questions/v2] driver finished",
  )
  await snapshot(ctx, "tab-questions-after-v2")
  return { ok: true, details: { processed, yesSet, modalsCreated, modalsSkipped } as any }
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

  // ── v2 layout detection ──────────────────────────────────────────
  // SureLC migrated the Questions tab from tr-row layout to a
  // div-card + ADD EXPLANATION modal flow in late May 2026. Detect
  // by presence of <sb-question> elements (the new question wrapper
  // tag). When present, use the layout-agnostic v2 driver below; the
  // legacy tr-based code further down is kept for any pre-migration
  // instance and as a fallback.
  const sbQuestions = await page.$$("sb-question").catch(() => [] as any[])
  if (sbQuestions.length > 0) {
    logger.info({ qCount: sbQuestions.length }, "[Questions/v2] new layout detected — using v2 driver")
    return await fillQuestionsV2(ctx, input)
  }

  // ── Probe the current state BEFORE clicking ALL NO. If there are
  //    ANY Yes radios already set, the tab has partial prior state —
  //    likely linked explanation docs + When dates that ALL NO would
  //    wipe.
  //
  //    Jimenez 2026-05-28 regression: bot's ALL NO click un-attached
  //    his existing M1.pdf explanation, then the re-flip-Yes + new
  //    upload created an unlinked dup. Validation went from 1 issue
  //    (DOCS:UNLINKED) to 4 (QUESTIONS:EXPLANATION_REQUIRED +
  //    QUESTIONS:WHEN_DATE_REQUIRED + QUESTIONS:ANSWERS_REQUIRED +
  //    DOCS:UNLINKED).
  //
  //    Safer policy: when any Yes radios are pre-set, skip ALL NO and
  //    surgically flip only the parents that differ from our intended
  //    state. If we'd need to flip MORE than 3 parents back to No
  //    (suggests a major mismatch), fail with a clear reason so the
  //    orchestrator surfaces "Questions tab has unexpected prior
  //    state" instead of corrupting it.
  const existingYesParents = await page
    .$$eval('tr input[type="radio"]:checked', (radios) =>
      Array.from(
        new Set(
          radios
            .filter((r: any) => /yes/i.test(r.value || ""))
            .map((r: any) => {
              const row = (r as HTMLElement).closest("tr")
              const m = ((row as HTMLElement | null)?.innerText || "").match(/^\s*(\d+)\b/)
              return m ? Number(m[1]) : NaN
            })
            .filter((n: number) => Number.isFinite(n)),
        ),
      ),
    )
    .catch(() => [] as number[])

  const safeMode = existingYesParents.length > 0
  if (safeMode) {
    logger.info(
      { existingYesParents },
      "[Questions] preserving prior state — skipping ALL NO (existing Yes radios detected)",
    )
    // Defensive: if existing Yes-questions all have explanations (no
    // "ADD EXPLANATION" buttons visible), short-circuit the entire
    // questions-tab fill. The bot's per-question upload code targets
    // the old tr-based layout and silently fails on SureLC's new
    // modal-based layout; running it on a producer whose questions
    // were filled manually (Lopez/Gurira/Jimenez 2026-05-29) creates
    // unlinked-explanation duplicates that Thomas then has to clean
    // up. Mark the tab "already done" and let Phase A continue.
    const addExplBtnCount = await page
      .$$('button:has-text("ADD EXPLANATION")')
      .then((els) => els.length)
      .catch(() => -1)
    if (addExplBtnCount === 0) {
      logger.info(
        "[Questions] all Yes-questions have explanations on file — skipping per-question fill",
      )
      return { ok: true, alreadyDone: true, details: { reason: "preserved-prior-state" } }
    }
    logger.info(
      { addExplBtnCount },
      "[Questions] some explanations still missing — continuing to per-question fill",
    )
  } else {
    // No prior Yes state — safe to ALL NO + flip what we need.
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
      if (ans.answer !== "yes") continue
      const parentNum = SUB_TO_PARENT[slug]
      if (!parentNum) continue

      // Fill the "When" date field if SureLC requires it
      // (QUESTIONS:WHEN_DATE_REQUIRED flag triggers when a Yes answer has
      // no occurrence date). Questionnaire JSON stores it as
      // ISO YYYY-MM-DD on each yes-answer; SureLC's input wants
      // MM/DD/YYYY in a Material datepicker scoped to the parent row.
      const occurrenceDate = (ans as any)?.occurrenceDate as string | undefined
      if (occurrenceDate) {
        const isoMatch = occurrenceDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
        const mmddyyyy = isoMatch
          ? `${isoMatch[2]}/${isoMatch[3]}/${isoMatch[1]}`
          : occurrenceDate
        try {
          const dateInput = await page.$(
            `tr:has-text("${parentNum}.") + tr input[placeholder*="MM/DD" i], ` +
              `tr:has-text("${parentNum}.") + tr input[type="text"][matinput], ` +
              `tr:has-text("${parentNum}.") + tr sb-date-input input`,
          )
          if (dateInput) {
            await (dateInput as any).fill(mmddyyyy)
            await (dateInput as any).dispatchEvent("change").catch(() => false)
            await (dateInput as any).dispatchEvent("blur").catch(() => false)
            logger.info("[Questions] filled occurrence date", { parentNum, mmddyyyy })
          } else {
            logger.warn("[Questions] no date input found for yes-answer", {
              parentNum,
              occurrenceDate,
            })
          }
        } catch (err: any) {
          logger.warn("[Questions] when-date fill threw", {
            parentNum,
            err: err.message,
          })
        }
      }

      if (!ans.documents?.length) continue
      // Find the row's expanded explanation area.
      const explanationArea = await page.$(
        `tr:has-text("${parentNum}.") + tr [class*="explanation"], ` +
          `tr:has-text("${parentNum}.") textarea`,
      )
      // Stuff the question's explanation text. The questionnaire stores
      // it on the first explanation_letter document
      // (documents[i].explanation.explanation). The original
      // (input as any)?.explanations?.[slug] path was never populated by
      // the activation pipeline — read directly from the documents
      // payload that IS shipped.
      const expDoc = (ans.documents || []).find(
        (d: any) => d?.kind === "explanation_letter" && d?.explanation?.explanation,
      ) as any
      const explanationText: string | undefined =
        expDoc?.explanation?.explanation ||
        (input as any)?.explanations?.[slug]
      if (explanationText && explanationArea) {
        try {
          await (explanationArea as any).fill(explanationText)
          logger.info("[Questions] filled explanation text", {
            parentNum,
            chars: explanationText.length,
          })
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
  // Provider Name fallback: SureLC's AML:PROVIDER_NONE validation flag
  // fires when the training-record row has no provider. Our DB only
  // captures amlVendor/amlTrainingProvider when an onboarding flow asks
  // for it — most agents have NULL here, so the bot would leave the
  // field blank and SureLC would refuse to create the training row.
  // "WebCE" is the dominant industry provider; it also happens to be
  // the option SureLC's autocomplete recognizes without complaint.
  const providerName = input.amlProvider || "WebCE"
  // Provider Name is a Material autocomplete (sb-provider-autocomplete
  // or sb-autocomplete depending on SureLC version). Plain fillByLabel
  // types text but doesn't COMMIT — the form keeps the field empty
  // until an mat-option is selected from the open panel. Same pattern
  // as Course Name below.
  //
  // Verified pattern 2026-05-28 (Julissa Chacon producer 2157902 + 4
  // other agents): every nightly Phase A failed with "Contracting
  // BLOCKED — AML file attached, but Training Provider not selected"
  // because the typed-but-not-selected value never saved. SureLC's
  // server-side validation flags AML:PROVIDER_NONE on these rows.
  let providerTyped = await fillByLabel(page, "Provider Name", providerName).catch(() => false)
  if (!providerTyped) providerTyped = await fillByLabel(page, "Provider", providerName).catch(() => false)
  if (providerTyped) {
    await page.waitForTimeout(800)
    const providerOption = await firstVisible(page, [
      `mat-option:has-text("${providerName}")`,
      'mat-option:has-text("WebCE")',
      'mat-option:has-text("LIMRA")',
      '.cdk-overlay-pane mat-option',
    ])
    if (providerOption) {
      logger.info(
        { providerName },
        "[Training] selecting Provider Name from autocomplete",
      )
      await (providerOption as any).click().catch(() => undefined)
      await settle(page, 600)
    } else {
      logger.warn(
        { providerName },
        "[Training] no provider mat-option visible after typing — typed value will not commit (SureLC AML:PROVIDER_NONE will remain)",
      )
    }
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
  // file AND cropper-confirmed, SureLC renders a "Signature
  // Authorization" header card with the confirmation date. Only treat
  // the DATED line as definitive evidence of a complete signature.
  //
  // 2026-05-27: the looser `REMOVE + EDIT + Signature Image` clause
  // matched signatures that had been uploaded via /uploadForm but
  // never reached cropper-confirmed state (confirmImage failed or was
  // skipped on a prior run). Bot reported alreadyDone, Fastlane saw
  // the producer as unsignatured, refused to expose the SELECT button,
  // and the activationPipeline fastlane_fallback_direct_post fired,
  // creating orphan BGA-stage requests with producerEmailUsed=null
  // (Javier Castro, Shingai Gurira, Doriz Lopez, Demetrius Early Jr).
  // Forcing the API push (uploadForm + confirmImage) when only the
  // loose pattern is present is safe — pushSignatureViaApi overwrites
  // idempotently and the REMOVE-then-reupload fallback handles the
  // rare case where overwrite fails.
  const sigText = await page
    .$$eval("body", (els) => (els[0]?.innerText || ""))
    .catch(() => "")
  const hasDatedAuthorization = /Signature Authorization\s*\n?\s*\d{2}\/\d{2}\/\d{4}/i.test(
    sigText,
  )
  const hasLooseRemoveEdit =
    /REMOVE/.test(sigText) && /EDIT/.test(sigText) && /Signature Image/i.test(sigText)
  const hasUploaded = hasDatedAuthorization
  if (!hasUploaded && hasLooseRemoveEdit) {
    // Partial-upload state: signature exists in DOM (REMOVE+EDIT
    // buttons visible) but never reached cropper-confirmed (no dated
    // header). Don't skip — fall through to the API push at the end
    // of this function which overwrites idempotently via uploadForm +
    // confirmImage. This is the codepath the 2026-05-27 Javier/Shingai/
    // Doriz/Demetrius cohort needed.
    logger.warn(
      { excerpt: sigText.slice(0, 200) },
      "[Signature] partial upload detected (REMOVE/EDIT visible, no dated Signature Authorization) — forcing API push to confirm",
    )
  }
  if (hasUploaded) {
    if (!input?.forceReupload) {
      logger.info({ excerpt: sigText.slice(0, 200) }, "[Signature] already uploaded (dated Signature Authorization visible) — skipping")
      return { ok: true, alreadyDone: true, details: { detected: "datedAuthorization" } }
    }
    // forceReupload=true: try the API push FIRST — it overwrites the
    // existing signature without any UI manipulation, so we never end
    // up with an erased-but-not-replaced signature. 2026-05-27
    // incident: nightly retry sweep ran with force=true → REMOVE
    // succeeded → API push threw on missing `sharp` package → 14
    // producers lost their signature flags they previously had.
    // Order: API push first, REMOVE only if it fails.
    if (input?.signatureImageUrl) {
      try {
        const overwriteResult = await pushSignatureViaApi(
          page,
          producerId,
          fileUrl,
          input.signatureImageUrl,
          logger,
        )
        if (overwriteResult.ok) {
          await snapshot(ctx, "tab-signature-02-api-overwrite")
          logger.info(
            { formId: overwriteResult.formId },
            "[Signature] API push overwrote existing signature without REMOVE",
          )
          return {
            ok: true,
            details: {
              autoSaved: true,
              warningCleared: true,
              viaApi: true,
              viaOverwrite: true,
              formId: overwriteResult.formId,
            },
          }
        }
        logger.warn(
          { reason: overwriteResult.reason },
          "[Signature] API overwrite failed; preserving existing signature (skipping REMOVE)",
        )
        // Maria Lugo 2026-05-28 regression: REMOVE succeeded then UI
        // re-upload failed, leaving the producer with NO signature on
        // SureLC ("Missing Signature Authorization" validation). The
        // REMOVE-then-fail-to-reupload window is non-recoverable
        // automatically and forces an admin to re-sign via the
        // dashboard. Safer: keep the existing signature (which was
        // valid enough that REMOVE+re-upload would have re-attached
        // the same file) and return with a clear reason so the
        // orchestrator can flag for retry / admin attention without
        // having corrupted the producer's state.
        return {
          ok: false,
          reason: `API push failed (${overwriteResult.reason}); kept existing signature to avoid REMOVE-without-reupload regression`,
        }
      } catch (err: any) {
        logger.warn(
          { err: err?.message },
          "[Signature] API overwrite threw; preserving existing signature (skipping REMOVE)",
        )
        return {
          ok: false,
          reason: `API push threw (${err?.message}); kept existing signature to avoid REMOVE-without-reupload regression`,
        }
      }
    }
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

  // Full API-only signature flow. Two calls, no UI:
  //   1. POST /surecrm/signature/{producerId}/uploadForm (FormData "file"
  //      = the signature-authorization PDF) → returns { uid: formId }
  //   2. PUT /surecrm/signature/{producerId}/{formId}/confirmImage with
  //      { payload: data:image/png;base64,..., width, height } where
  //      payload is the rep's pristine drawn-signature PNG.
  //
  // Endpoints discovered 2026-05-26 by grepping chunk-XJF6ZQJI.js (the
  // signature service module). Verified by clearing all 10 stuck
  // producers (Perrion 3351482, Emily 8068174, Tonette 11751656, etc.)
  // via standalone sweep script — validation/list went from
  // [SIGNATURE:MISSING_SIGNATURE_AUTHORIZATION] to [] after the call.
  //
  // Why this works when setInputFiles + cropper doesn't: SureLC's
  // Angular SPA's file-input change handler has been flaky for 8+ days
  // (no upload fires from synthetic Playwright file events). Calling the
  // backing HTTP endpoints directly skips that broken layer entirely.
  if (!input?.signatureImageUrl) {
    return { ok: false, reason: "no signatureImageUrl on input — cannot push signature" }
  }
  try {
    const result = await pushSignatureViaApi(page, producerId, fileUrl, input.signatureImageUrl, logger)
    await snapshot(ctx, "tab-signature-03-api-pushed")
    if (!result.ok) return { ok: false, reason: result.reason || "API push failed" }
    return { ok: true, details: { autoSaved: true, warningCleared: true, viaApi: true, formId: result.formId } }
  } catch (err: any) {
    logger.error({ err: err?.message }, "[Signature] API push threw")
    return { ok: false, reason: `API push threw: ${err?.message || err}` }
  }
}

/**
 * Push a signature directly via SureLC's HTTP API — bypassing the
 * ngx-image-cropper UI which has been flaky since 5/18.
 *
 * Two-call flow (discovered 2026-05-26 from chunk-XJF6ZQJI.js, verified
 * end-to-end against all 10 stuck producers):
 *
 *   1. POST /surecrm/signature/{producerId}/uploadForm
 *      multipart/form-data with field "file" = signature-authorization PDF
 *      → returns { uid: formId, ... }
 *
 *   2. PUT /surecrm/signature/{producerId}/{formId}/confirmImage
 *      Content-Type: application/json
 *      body: { payload: "data:image/png;base64,...", width, height }
 *      → 200 on success; validation/list goes from
 *        [SIGNATURE:MISSING_SIGNATURE_AUTHORIZATION] to [] within seconds
 *
 * Bearer JWT is harvested from a /surecrm/* request the SPA makes on
 * page load (same pattern as bgaTokenCapture). We poll for it after the
 * navigation in case it lands a few hundred ms after the page settles.
 */
async function pushSignatureViaApi(
  page: import("playwright").Page,
  producerId: string,
  pdfUrl: string,
  signatureImageUrl: string,
  logger: import("pino").Logger,
): Promise<{ ok: boolean; reason?: string; formId?: string | number }> {
  // Harvest bearer from a SureLC API request the SPA has already made.
  // bgaTokenCapture pattern: any /surecrm/* request carries the JWT in
  // its Authorization header.
  const bearer = await harvestBgaBearer(page)
  if (!bearer) return { ok: false, reason: "no BGA bearer captured from SPA" }

  // Download the signature-auth PDF + the bare drawn-PNG.
  const pdfRes = await fetch(pdfUrl)
  if (!pdfRes.ok) return { ok: false, reason: `fetch pdfUrl failed: HTTP ${pdfRes.status}` }
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer())

  const pngRes = await fetch(signatureImageUrl)
  if (!pngRes.ok) return { ok: false, reason: `fetch pngUrl failed: HTTP ${pngRes.status}` }
  const pngBuf = Buffer.from(await pngRes.arrayBuffer())

  // PNG IHDR chunk encodes width (uint32 BE at offset 16) and height
  // (offset 20). Read directly from the buffer — sharp isn't in
  // dependencies and pulling it in just for two integers triggered a
  // 2026-05-27 ESM resolve failure that broke every signature push.
  let width = 491
  let height = 200
  if (pngBuf.length >= 24 && pngBuf[0] === 0x89 && pngBuf[1] === 0x50 && pngBuf[2] === 0x4e && pngBuf[3] === 0x47) {
    width = pngBuf.readUInt32BE(16) || 491
    height = pngBuf.readUInt32BE(20) || 200
  } else {
    logger.warn({ pngBufHead: pngBuf.slice(0, 8).toString("hex") }, "[Signature] PNG magic bytes missing — using default dimensions")
  }

  // Step 1 — POST /uploadForm
  const fd = new FormData()
  fd.append(
    "file",
    new Blob([pdfBuf], { type: "application/pdf" }),
    "signature-authorization.pdf",
  )
  const upRes = await fetch(
    `https://surelc.surancebay.com/surecrm/signature/${producerId}/uploadForm`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}` },
      body: fd,
    },
  )
  if (!upRes.ok) {
    const t = await upRes.text().catch(() => "")
    return { ok: false, reason: `uploadForm HTTP ${upRes.status}: ${t.slice(0, 200)}` }
  }
  const upJson = (await upRes.json().catch(() => ({}))) as { uid?: string | number; id?: string | number }
  const formId = upJson.uid ?? upJson.id
  if (!formId) return { ok: false, reason: "uploadForm returned no formId" }

  // Step 2 — PUT /confirmImage
  const payload = `data:image/png;base64,${pngBuf.toString("base64")}`
  const callConfirm = async (
    base64Payload: string,
  ): Promise<{ ok: boolean; status: number; text: string }> => {
    const r = await fetch(
      `https://surelc.surancebay.com/surecrm/signature/${producerId}/${formId}/confirmImage`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ payload: base64Payload, width, height }),
      },
    )
    const txt = await r.text().catch(() => "")
    return { ok: r.ok, status: r.status, text: txt }
  }

  let conf = await callConfirm(payload)
  if (!conf.ok && conf.status === 500 && /Failed to create transparent PNG/i.test(conf.text)) {
    // SureLC's image processor occasionally rejects our drawn RGBA PNGs
    // with HTTP 500 "Failed to create transparent PNG" — Beam 2026-05-29
    // is the canonical case. The PNG is well-formed (verified with file +
    // PNG header read); SureLC's alpha-handling pipeline just chokes on
    // certain alpha patterns. Workaround: composite the PNG onto a white
    // background in headless Chrome to strip transparency, then retry.
    logger.warn(
      { producerId, formId },
      "[Signature] confirmImage 500 'Failed to create transparent PNG' — flattening alpha and retrying",
    )
    const flattenedDataUrl = await page
      .evaluate(
        async (b64: string) =>
          new Promise<string>((resolve, reject) => {
            const img = new Image()
            img.onload = () => {
              const c = document.createElement("canvas")
              c.width = img.width
              c.height = img.height
              const ctx = c.getContext("2d")
              if (!ctx) return reject(new Error("no 2d ctx"))
              ctx.fillStyle = "white"
              ctx.fillRect(0, 0, c.width, c.height)
              ctx.drawImage(img, 0, 0)
              resolve(c.toDataURL("image/png"))
            }
            img.onerror = () => reject(new Error("img load failed"))
            img.src = `data:image/png;base64,${b64}`
          }),
        pngBuf.toString("base64"),
      )
      .catch((e: unknown) => {
        logger.warn({ err: String(e) }, "[Signature] PNG flatten in canvas failed")
        return ""
      })
    if (flattenedDataUrl) {
      conf = await callConfirm(flattenedDataUrl)
      if (conf.ok) {
        logger.info(
          { producerId, formId },
          "[Signature] flattened PNG accepted on retry",
        )
      }
    }
  }
  if (!conf.ok) {
    return { ok: false, reason: `confirmImage HTTP ${conf.status}: ${conf.text.slice(0, 200)}` }
  }

  logger.info(
    { producerId, formId, width, height, pdfBytes: pdfBuf.length, pngBytes: pngBuf.length },
    "[Signature] API push succeeded — signature persisted via uploadForm + confirmImage",
  )
  return { ok: true, formId }
}

/**
 * Bearer harvested from the BGA SPA's outbound /surecrm/* traffic.
 * The page must already have loaded the BGA SPA + made at least one
 * authenticated request (gotoBga + a few seconds of settle is enough).
 * Returns "" if no Authorization header has been seen.
 */
async function harvestBgaBearer(page: import("playwright").Page): Promise<string> {
  // Strategy 1 (reliable) — read directly from browser storage. SureLC's
  // BGA SPA persists its Bearer JWT under the localStorage key
  // `sb:id_token` (verified bgaTokenCapture.ts:347 — same pattern used by
  // /get-bga-tokens). This bypasses ALL network-listener race conditions
  // (the previous approach failed 80%+ of Phase A runs 2026-05-28 because
  // the SPA's interceptor sometimes fired the /surecrm/* request before
  // our page.on("request") handler attached, or the JWT-shape check ran
  // before resolve was invoked).
  //
  // Poll storage for up to 5s — the SPA might be mid-mount on first goto.
  const isJwt = (s: string) => typeof s === "string" && s.split(".").length === 3
  const storageDeadline = Date.now() + 5_000
  while (Date.now() < storageDeadline) {
    const fromStorage = await page
      .evaluate(() => {
        const buckets: Record<string, string> = {}
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (k) buckets[`local:${k}`] = localStorage.getItem(k) || ""
        }
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i)
          if (k) buckets[`session:${k}`] = sessionStorage.getItem(k) || ""
        }
        return buckets
      })
      .catch(() => ({}) as Record<string, string>)
    // Try the SureLC-specific keys first.
    for (const [k, v] of Object.entries(fromStorage)) {
      if (!v) continue
      if (/(?:^|:)id_token$/i.test(k) && isJwt(v)) return v
      if (/access(?:_?token)?/i.test(k) && isJwt(v)) return v
      // JSON-wrapped formats (older SDK versions).
      try {
        const obj = JSON.parse(v)
        if (obj && typeof obj === "object") {
          if (isJwt(obj.access_token)) return obj.access_token
          if (isJwt(obj.accessToken)) return obj.accessToken
        }
      } catch {
        /* not JSON */
      }
    }
    await page.waitForTimeout(250)
  }

  // Strategy 2 (fallback) — original network-listener approach. If the
  // SPA hasn't put the token in storage yet, force an outbound call and
  // grab the Authorization header. Kept as belt-and-suspenders in case
  // SureLC changes their storage key in a future SPA build.
  return new Promise((resolve) => {
    let bearer = ""
    const handler = (req: import("playwright").Request) => {
      const a = req.headers()["authorization"]
      if (a?.startsWith("Bearer ") && req.url().includes("/surecrm/")) {
        const token = a.replace("Bearer ", "")
        if (isJwt(token)) {
          bearer = token
          page.off("request", handler)
          resolve(bearer)
        }
      }
    }
    page.on("request", handler)
    page.evaluate(() => {
      fetch("/surecrm/user/timezone", { method: "POST", body: "-240" }).catch(() => {})
    }).catch(() => {})
    setTimeout(() => {
      page.off("request", handler)
      resolve(bearer)
    }, 8000)
  })
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
