/**
 * Which Fastlane producer card is the producer we were asked to file for?
 *
 * ─── Why this exists (2026-10-02, Carlos Tovar) ──────────────────────
 *
 * Agent 539, Carlos Tovar, is SureLC producer 11383068 (SureLC holds him under
 * the name "Carlos Alvarez"). Three Fastlane runs (10-01 17:47 and 17:53 UTC,
 * two admin_setup jobs running at once, then 10-02 01:12) each searched
 * "TOVAR", got one card back — "NUNEZ-TOVAR, CARLOS EDUARDO, SR.", producer
 * 5861981, a different agent of ours — and clicked SELECT on it. 22 carrier
 * requests were filed on the wrong man; none on Tovar.
 *
 * Every gate fell through:
 *   - the "exact" name test was a substring test, and "TOVAR, CARLOS" is a
 *     substring of "NUNEZ-TOVAR, CARLOS EDUARDO, SR.";
 *   - the producer-id guard added after the Carlos Murray incident read the id
 *     "off the card" and, when it found none, logged a warning and clicked
 *     anyway. It found none on 20 of 20 clicks, because there is none to find:
 *     a <bga-producer-card> renders the name, the "Soliciting for" line, the
 *     BGA hierarchy and the producer's EMAIL — no producer id, no NPN, no
 *     /producers/<id> link (checked against the bot's own snapshots of those
 *     runs, fastlane-02b-after-search.html);
 *   - the bot then listed requests on 11383068, found none new, and still
 *     reported success.
 *
 * ─── What identifies a card now ──────────────────────────────────────
 *
 * Before Fastlane opens, the bot reads producer <producerId> from SureLC's own
 * API (GET /surecrm/producers/{id}/model, read-only, the same call
 * /create-appointment-requests has used since 2026-05-27). That record is the
 * id-linked truth: its name, its email, its NPN.
 *
 *   1. If the backoffice sent an NPN, the record's NPN must equal it — else the
 *      producerId on our agent row belongs to somebody else. Refuse.
 *   2. A card is OUR producer only when the email it renders equals the
 *      record's email (or effectiveEmail). Exactly one card may match.
 *   3. That card's name must also agree with the record's name, whole token by
 *      whole token on the surname ("NUNEZ-TOVAR" is not "TOVAR").
 *
 * Anything short of that is `producer_identity_unverified`, and nothing is
 * filed. A refusal is a ticket; a wrong click is somebody else's compliance
 * record.
 *
 * Everything below the API helpers is pure, so the policy is testable without
 * a browser (producerIdentity.test.ts).
 */
import type { Page } from "playwright"

export const PRODUCER_IDENTITY_UNVERIFIED = "producer_identity_unverified"
export const PRODUCER_AMBIGUOUS = "producer_ambiguous"
export const PRODUCER_NOT_FOUND = "producer_not_found"
export const FILED_ON_WRONG_PRODUCER_SUSPECTED = "filed_on_wrong_producer_suspected"
export const FASTLANE_SUBMIT_UNVERIFIED = "fastlane_submit_unverified"

export type ProducerSelectionCode =
  | typeof PRODUCER_IDENTITY_UNVERIFIED
  | typeof PRODUCER_AMBIGUOUS
  | typeof PRODUCER_NOT_FOUND

// ─── name handling ─────────────────────────────────────────────────

/** Strip diacritics so "MUÑOZ" and "MUNOZ" compare equal. */
export function foldAscii(s: string): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
}

function normToken(t: string): string {
  return foldAscii(t).toUpperCase().replace(/\.+$/, "").trim()
}

/** Whitespace-separated tokens. A hyphen does NOT split: NUNEZ-TOVAR is one surname token. */
function tokens(s: string): string[] {
  return foldAscii(s || "")
    .toUpperCase()
    .split(/\s+/)
    .map(normToken)
    .filter(Boolean)
}

/** "LAST, FIRST MIDDLE, SR." → { last: "LAST", first: "FIRST MIDDLE" }. */
export function splitProducerName(name: string): { last: string; first: string } {
  const parts = (name || "").split(",")
  return { last: (parts[0] || "").trim(), first: (parts[1] || "").trim() }
}

/**
 * Whole-token name agreement between a card and a wanted "LAST, FIRST".
 *
 *   - surname: the FIRST surname token of each side must be equal, whole
 *     token. "LANDINO" ↔ "LANDINO VALBUENA" agree (Paula, 2026-08); "TOVAR" ↔
 *     "NUNEZ-TOVAR" do not (2026-10-02); "MURRAY" ↔ "MURPHY" do not.
 *   - given name: when both sides have one, their first tokens must be equal.
 *
 * Accent-folded and case-insensitive. Generational suffixes live after the
 * second comma on SureLC's cards and are ignored here — the email decides
 * between a father and a son, not the name.
 */
export function nameTokensMatch(cardName: string, wantName: string): boolean {
  const card = splitProducerName(cardName)
  const want = splitProducerName(wantName)
  const cardLast = tokens(card.last)
  const wantLast = tokens(want.last)
  if (!cardLast.length || !wantLast.length) return false
  if (cardLast[0] !== wantLast[0]) return false
  const cardFirst = tokens(card.first)
  const wantFirst = tokens(want.first)
  if (cardFirst.length && wantFirst.length && cardFirst[0] !== wantFirst[0]) return false
  return true
}

// ─── emails ────────────────────────────────────────────────────────

const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

export function normEmail(e: string | null | undefined): string {
  return (e || "").trim().toLowerCase()
}

/** Every email address printed in a card's text. */
export function emailsInText(text: string): string[] {
  return Array.from(new Set((text.match(EMAIL_RE) || []).map(normEmail)))
}

// ─── the producer record ───────────────────────────────────────────

/**
 * The fields of GET /surecrm/producers/{id}/model this module reads. Since the
 * 2026-10-05 SureLC redesign the record is keyed `producerId` and carries
 * `email` only (no `id` / `effectiveEmail` / `fullName`); the old names stay
 * optional so a legacy-shaped record still parses.
 */
export interface SureLcProducerRecord {
  producerId?: number | string
  id?: number | string
  npn?: string | number | null
  email?: string | null
  effectiveEmail?: string | null
  fullName?: string | null
  firstName?: string | null
  lastName?: string | null
}

export interface ExpectedProducerIdentity {
  producerId: string
  /** Emails SureLC holds for producerId (email + effectiveEmail), lowercased. */
  emails: string[]
  /** SureLC's own "LAST, FIRST" for producerId. */
  displayName: string
  npn: string | null
}

export type IdentityFromRecord =
  | { ok: true; identity: ExpectedProducerIdentity }
  | { ok: false; code: typeof PRODUCER_IDENTITY_UNVERIFIED; reason: string }

function digits(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "")
}

/**
 * Turn the record SureLC returned for producerId into what a card must show.
 * Refuses when there is no record, when it carries no email to check a card
 * against, or when its NPN disagrees with the NPN the backoffice holds.
 */
export function identityFromRecord(
  producerId: string,
  record: SureLcProducerRecord | null | undefined,
  expectedNpn?: string | null,
): IdentityFromRecord {
  const unverified = (reason: string): IdentityFromRecord => ({
    ok: false,
    code: PRODUCER_IDENTITY_UNVERIFIED,
    reason: `[${PRODUCER_IDENTITY_UNVERIFIED}] ${reason} Nothing was filed.`,
  })
  if (!producerId) return unverified("No SureLC producer id was given for this agent.")
  if (!record || typeof record !== "object") {
    return unverified(`Could not read producer ${producerId} from SureLC, so no Fastlane card can be checked against it.`)
  }
  for (const returned of [record.producerId, record.id]) {
    if (returned != null && String(returned) !== String(producerId)) {
      return unverified(`SureLC returned producer ${returned} when asked for ${producerId}.`)
    }
  }
  if (record.producerId == null && record.id == null) {
    return unverified(`SureLC's record for ${producerId} carries no producer id, so it cannot be confirmed as that producer.`)
  }
  const recNpn = digits(record.npn)
  const wantNpn = digits(expectedNpn)
  if (wantNpn) {
    if (!recNpn) {
      return unverified(`Producer ${producerId} has no NPN in SureLC; this agent's NPN is ${wantNpn}, so the id cannot be confirmed as theirs.`)
    }
    if (recNpn !== wantNpn) {
      return unverified(`Producer ${producerId} carries NPN ${recNpn} in SureLC, but this agent's NPN is ${wantNpn} — the producer id on the agent row belongs to someone else.`)
    }
  }
  const emails = Array.from(
    new Set([normEmail(record.email), normEmail(record.effectiveEmail)].filter(Boolean)),
  )
  if (!emails.length) {
    return unverified(`Producer ${producerId} has no email in SureLC, and the email is the only identifier a Fastlane card shows.`)
  }
  const displayName =
    (record.lastName && record.firstName
      ? `${record.lastName}, ${record.firstName}`
      : record.fullName || "").trim()
  if (!displayName) {
    return unverified(`Producer ${producerId} has no name in SureLC.`)
  }
  return {
    ok: true,
    identity: { producerId: String(producerId), emails, displayName, npn: recNpn || null },
  }
}

// ─── picking the card ──────────────────────────────────────────────

export interface FastlaneCardInfo {
  /** `.producer__name` text, e.g. "NUNEZ-TOVAR, CARLOS EDUARDO, SR." */
  name: string
  /** Emails printed on the card, lowercased. */
  emails: string[]
}

export type CardDecision =
  | { ok: true; index: number }
  | { ok: false; code: ProducerSelectionCode; reason: string }

const show = (c: FastlaneCardInfo) => `${c.name || "(no name)"} <${c.emails.join(", ") || "no email"}>`

/**
 * The one card we may click SELECT on, or the reason there is none.
 *
 * Positive identification only: the card must print an email SureLC holds for
 * producerId, be the only card that does, and carry the record's name.
 * There is no "only one card rendered, take it" and no name-only fallback —
 * those are exactly what filed on Murray II (2026-09) and Nunez-Tovar
 * (2026-10).
 */
export function decideProducerCard(
  cards: FastlaneCardInfo[],
  expected: ExpectedProducerIdentity | null | undefined,
): CardDecision {
  if (!expected || !expected.producerId || !expected.emails.length) {
    return {
      ok: false,
      code: PRODUCER_IDENTITY_UNVERIFIED,
      reason: `[${PRODUCER_IDENTITY_UNVERIFIED}] No verified SureLC identity (producer id + email) to check a Fastlane card against. Nothing was filed.`,
    }
  }
  const want = new Set(expected.emails.map(normEmail))
  const byEmail = cards
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.emails.some((e) => want.has(normEmail(e))))
  const byName = cards.filter((c) => nameTokensMatch(c.name, expected.displayName))

  if (byEmail.length > 1) {
    return {
      ok: false,
      code: PRODUCER_AMBIGUOUS,
      reason:
        `[${PRODUCER_AMBIGUOUS}] ${byEmail.length} Fastlane cards show producer ${expected.producerId}'s email ` +
        `(${expected.emails.join(", ")}): ${byEmail.map(({ c }) => show(c)).join(" | ")}. ` +
        `Cannot tell which one is producer ${expected.producerId}. Nothing was filed.`,
    }
  }
  if (byEmail.length === 1) {
    const { c, index } = byEmail[0]
    if (!nameTokensMatch(c.name, expected.displayName)) {
      return {
        ok: false,
        code: PRODUCER_IDENTITY_UNVERIFIED,
        reason:
          `[${PRODUCER_IDENTITY_UNVERIFIED}] The Fastlane card with producer ${expected.producerId}'s email is ` +
          `"${c.name}", but SureLC names producer ${expected.producerId} "${expected.displayName}". ` +
          `Email and name disagree, so the card is not positively ours. Nothing was filed.`,
      }
    }
    return { ok: true, index }
  }
  if (byName.length > 0) {
    return {
      ok: false,
      code: PRODUCER_IDENTITY_UNVERIFIED,
      reason:
        `[${PRODUCER_IDENTITY_UNVERIFIED}] No Fastlane card shows producer ${expected.producerId}'s email ` +
        `(${expected.emails.join(", ")}). Card(s) matching the name: ${byName.map(show).join(" | ")} — ` +
        `a name match alone is not proof of identity (2026-10-02: "TOVAR" filed on "NUNEZ-TOVAR"). Nothing was filed.`,
    }
  }
  return {
    ok: false,
    code: PRODUCER_NOT_FOUND,
    reason:
      `[${PRODUCER_NOT_FOUND}] Producer ${expected.producerId} ("${expected.displayName}", ${expected.emails.join(", ")}) ` +
      `was not among the Fastlane cards: ${cards.length ? cards.map(show).join(" | ") : "(none rendered)"}. Nothing was filed.`,
  }
}

/**
 * Search box terms, most specific first: SureLC's own surname for the
 * producer (what the card prints), its first token, accent-folded forms,
 * then our name's terms, then the email. Each is tried until a term renders
 * a card that decideProducerCard accepts.
 */
export function identitySearchTerms(
  expected: ExpectedProducerIdentity | null | undefined,
  ourDisplayName: string,
): string[] {
  const out: string[] = []
  const push = (t: string | undefined) => {
    const v = (t || "").trim()
    if (v.length >= 2 && !out.some((x) => x.toUpperCase() === v.toUpperCase())) out.push(v)
  }
  const surnameTerms = (display: string) => {
    const last = splitProducerName(display).last
    const first = last.split(/\s+/)[0] || ""
    return [last, first, foldAscii(last), foldAscii(first)]
  }
  if (expected?.displayName) surnameTerms(expected.displayName).forEach(push)
  if (ourDisplayName) surnameTerms(ourDisplayName).forEach(push)
  for (const e of expected?.emails ?? []) push(e)
  return out.slice(0, 8)
}

// ─── after submit ──────────────────────────────────────────────────

export type SubmitVerification =
  | { ok: true; newRequestIds: number[] }
  | {
      ok: false
      code: typeof FILED_ON_WRONG_PRODUCER_SUSPECTED | typeof FASTLANE_SUBMIT_UNVERIFIED
      reason: string
      newRequestIds: number[]
    }

/**
 * Did the carriers we just added land on the producer we meant?
 *
 * Fastlane files one request per carrier (or more). Fewer new requests on the
 * intended producer than carriers added means they went somewhere else — the
 * Tovar runs added 7-8 carriers and 0 appeared on 11383068, yet each reported
 * "submitted". A run that cannot read the list afterwards cannot claim
 * success either.
 */
export function verifyNewRequests(input: {
  producerId: string
  addedCount: number
  beforeIds: number[] | null
  afterIds: number[] | null
}): SubmitVerification {
  if (input.beforeIds == null || input.afterIds == null) {
    return {
      ok: false,
      code: FASTLANE_SUBMIT_UNVERIFIED,
      reason:
        `[${FASTLANE_SUBMIT_UNVERIFIED}] Fastlane submitted ${input.addedCount} carrier(s), but the bot could not ` +
        `read producer ${input.producerId}'s appointment requests ${input.beforeIds == null ? "before" : "after"} ` +
        `the submit, so it cannot confirm they landed on this producer. Check SureLC before re-running.`,
      newRequestIds: [],
    }
  }
  const before = new Set(input.beforeIds)
  const newRequestIds = input.afterIds.filter((id) => !before.has(id)).sort((a, b) => a - b)
  if (newRequestIds.length < input.addedCount) {
    return {
      ok: false,
      code: FILED_ON_WRONG_PRODUCER_SUSPECTED,
      reason:
        `[${FILED_ON_WRONG_PRODUCER_SUSPECTED}] Fastlane submitted ${input.addedCount} carrier(s) but only ` +
        `${newRequestIds.length} new appointment request(s) appeared on producer ${input.producerId}` +
        `${newRequestIds.length ? ` (${newRequestIds.join(", ")})` : ""}. The rest were probably filed on a ` +
        `different producer — find and withdraw them in SureLC. Do not re-run until that is resolved.`,
      newRequestIds,
    }
  }
  return { ok: true, newRequestIds }
}

// ─── read-only SureLC SPA helpers ──────────────────────────────────

/**
 * Capture the BGA SPA's Bearer JWT by nudging it to fire a /surecrm/* call.
 * Navigates the SPA to the producer's appointments page (pushState — no
 * server write). Same technique dedupAppointmentRequests has used since
 * 2026-05-09.
 */
export async function captureSurecrmBearer(
  page: Page,
  producerId: string,
): Promise<string | null> {
  let bearer: string | null = null
  const handler = (req: import("playwright").Request) => {
    const a = req.headers()["authorization"]
    if (req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
      const b = a.replace("Bearer ", "")
      if (!bearer && b.split(".").length === 3) {
        bearer = b
        page.off("request", handler)
      }
    }
  }
  page.on("request", handler)
  // Since the 2026-10-05 redesign the appointments route can render without
  // any /surecrm/ call, so fall back to the profile route, whose
  // /surecrm/producers/{id}/model call is what /diagnose-producer harvests.
  for (const view of ["appointments", "profile"]) {
    if (bearer) break
    try {
      await page.evaluate(
        ([id, v]) => {
          history.pushState({}, "", `/bga/producers/${id}/${v}`)
          window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
        },
        [String(producerId), view] as const,
      )
      for (let i = 0; i < 20 && !bearer; i++) await page.waitForTimeout(500)
    } catch {
      /* try the next view */
    }
  }
  page.off("request", handler)
  return bearer
}

/** GET /surecrm/producers/{id}/model. Read-only. null on any failure. */
export async function fetchProducerRecord(
  bearer: string,
  producerId: string,
): Promise<SureLcProducerRecord | null> {
  try {
    const r = await fetch(`https://surelc.surancebay.com/surecrm/producers/${producerId}/model`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    if (!r.ok) return null
    const body = (await r.json()) as SureLcProducerRecord
    return body && typeof body === "object" ? body : null
  } catch {
    return null
  }
}

/** Every appointment-request id on the producer (any stage). Read-only. null on failure. */
export async function listAppointmentRequestIds(
  bearer: string,
  producerId: string,
  gaId: string | number,
): Promise<number[] | null> {
  try {
    const r = await fetch(
      `https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${producerId}&gaId=${gaId}`,
      { headers: { Authorization: `Bearer ${bearer}` } },
    )
    if (!r.ok) return null
    const data: unknown = await r.json()
    const rows = Array.isArray(data)
      ? data
      : ((data as { content?: unknown[] })?.content ?? null)
    if (!Array.isArray(rows)) return null
    return rows
      .map((x: any) => Number(x?.appointmentRequestId ?? x?.id))
      .filter((n) => Number.isFinite(n) && n > 0)
  } catch {
    return null
  }
}
