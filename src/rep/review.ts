/**
 * Rep-side Producer Review wizard.
 *
 * Entered via the temporary signed URL embedded in SureLC's email
 * "{carrier} Contract Request" (sender contracts@assurancebay.com).
 *
 * The bot runs this in a SEPARATE browser context from the admin flow
 * — different cookies, different origin, no admin session leakage.
 *
 * Steps (per Loom spec):
 *   0  — Auth: last 6 SSN + DOB
 *   0b — Policy Accept (one-time per rep)
 *   1  — Overview (just Next)
 *   2  — Training (auto-filled if AML in profile)
 *   3  — E&O (auto-filled if E&O in profile)
 *   4  — Carrier Questions (default No on every red field)
 *   5  — Document Generation (PDF viewer — RETRY-PRONE)
 *   6  — Document Review + "Apply My Signature"
 *
 * After step 6, SureLC may show a "more pending requests, continue?"
 * link — repeat from step 1 for each pending request.
 */

import type { Page, Browser } from "playwright"
import type pino from "pino"
import {
  firstVisible,
  settle,
  snapshot,
  type TabContext,
  type TabResult,
} from "../tabs/helpers.js"

export interface RepReviewInput {
  /** "Start Your Review" URL extracted from SureLC's contract email. */
  reviewUrl: string
  /**
   * Additional review URLs to process after the first one. Each one
   * targets a different `appointmentId` (one per carrier). After
   * signing the first carrier, the bot opens the next URL in this
   * list. Defaults to [] (single-carrier mode).
   */
  additionalReviewUrls?: string[]
  /** Last 6 of SSN, used for the auth gate. */
  ssnLast6: string
  /** DOB in MM-DD-YYYY format. */
  dob: string
  /** Has the rep already accepted the SureLC software/privacy policy once? */
  policyAccepted?: boolean
  /** When set, run only this many carrier reviews then stop. */
  maxCarriers?: number
  /**
   * Pre-fill the wizard for the rep WITHOUT signing. Bot walks steps
   * 1-5 (welcome, training, E&O, carrier questions, questionnaire),
   * letting SureLC auto-save each step's data, then bails BEFORE Step
   * 6 (Review & Sign). When the rep logs in via their SureLC email
   * link, they land on Step 6 with all earlier data already filled —
   * they only have to scroll the PDF + click "Apply My Signature".
   *
   * Use case: 2026-05-23 — owner manually sent rep-review emails for
   * 46 stuck producers. Without pre-fill, each rep has to slog
   * through 5 wizard steps per carrier (9 carriers × 5 steps = 45
   * clicks per rep). With pre-fill they sign in one click per carrier.
   */
  prefillOnly?: boolean
  /**
   * Optional producer profile fields used to fill carrier-specific
   * required text inputs on Step 4 (e.g. Occidental requires cellPhone
   * + placeOfBirth in addition to the standard Y/N questions). Map keys
   * are SureLC's `formcontrolname` attributes — see step4-carrier-
   * questions-answered.html dumps to discover which keys a given
   * carrier asks for.
   */
  producerProfile?: {
    cellPhone?: string
    homePhone?: string
    placeOfBirth?: string
    residentCounty?: string
    /** Agent's email — fills required email inputs some carriers add to
     *  the Carrier-Questions step (e.g. Americo "BENEFICIARY DESIGNATION:
     *  Email Address"), which the N/A fallback can't satisfy. */
    email?: string
    /** Free-form fallback for any other required text input. */
    fallback?: string
  }
  /**
   * Background-disclosure answers from the rep's onboarding questionnaire.
   * Keys mirror the columns on `questionnaire_responses`; values are the
   * rep's actual onboarding answer (true = Yes / disclosed, false = No).
   *
   * Used to answer SureLC's carrier-questions (Step 4) and the rep's
   * personal questionnaire (Step 5) accurately. Without these the bot
   * defaults every Y/N to "N" — that works for clean agents but is a
   * misrepresentation for any agent who actually disclosed something.
   *
   * The bot matches each on-screen question's label text against this
   * map's keys (felony, bankruptcy, judgment, etc.); a matched-and-true
   * disclosure → Yes, otherwise No.
   */
  disclosures?: {
    q1_felony?: boolean
    q2_misdemeanor?: boolean
    q3_regulatory_action?: boolean
    /**
     * Securities/investment-regulation VIOLATION — split out from the
     * coarse q3_regulatory_action (which also carries consumer-complaint
     * and regulatory-discipline disclosures). Fed ONLY by the securities
     * detailed slugs so a genuine consumer-complaint disclosure can't
     * spuriously answer a securities-violation question Yes and strand the
     * rep at Producer on an unsatisfiable explanation card (Estell
     * 2026-06-03: hadComplaint=yes wrongly drove the securities Q Yes).
     */
    q3_securities_violation?: boolean
    q4_license_denied?: boolean
    q5_license_revoked?: boolean
    q6_insurer_terminated?: boolean
    /**
     * Bankruptcy is THREE distinct SureLC questions, not one:
     *   Q15/Q15a — did YOU personally file/declare bankruptcy  → q7_bankruptcy_personal
     *   Q15b      — did a brokerage FIRM you were associated with go bankrupt → q7_firm_bankruptcy
     *   Q15c      — is the bankruptcy currently PENDING         → q7_bankruptcy_pending
     * The old coarse `q7_bankruptcy` + /bankrupt/i pattern answered ALL of
     * them "Yes" off a single personal-bankruptcy disclosure — a false
     * statement on the firm + pending questions for anyone with a personal,
     * discharged bankruptcy (Johnson 2026-06-18). `q7_bankruptcy` is retained
     * as the legacy/back-compat synonym for the personal answer so older app
     * payloads (which only send it) still answer Q15/Q15a correctly while the
     * firm/pending questions correctly default No.
     */
    q7_bankruptcy?: boolean
    q7_bankruptcy_personal?: boolean
    q7_firm_bankruptcy?: boolean
    q7_bankruptcy_pending?: boolean
    q8_bond_denied?: boolean
    q9_unpaid_premiums?: boolean
    q10_fiduciary_breach?: boolean
    q11_fraud_investigation?: boolean
    q12_consent_order?: boolean
    q13_ce_violation?: boolean
    q14_lawsuit_pending?: boolean
    q15_eo_claim?: boolean
    q16_unsatisfied_judgments?: boolean
    q17_financial_institution?: boolean
    q18_other_names?: boolean
    q19_irs_matters?: boolean
  }
  /**
   * Per-disclosure explanation letters + supporting docs from the rep's
   * onboarding (`questionnaire_responses.surelc_answers`). When a carrier's
   * Carrier-Questions step (Step 4) answers "Yes", SureLC shows a red
   * `sb-info-message[action="Add"]` card demanding "provide description
   * or/and attach files" — without filling it the request can't reach
   * Review & Sign (Americo/AmAm et al. stall at Producer; the whole
   * red-flag backlog 2026-06-02). The bot drives that ADD modal with these.
   *
   * `questionText` is the rep's onboarding question wording, used to
   * best-match a card; entries also serve as a fallback pool since the
   * criminal-history explanations are usually one shared letter.
   */
  carrierQuestionExplanations?: Array<{
    questionText?: string
    /** ISO YYYY-MM-DD; rendered MM/DD/YYYY into the modal's date field. */
    occurrenceDate?: string
    /** The letter-of-explanation body text. */
    explanation?: string
    /** Fetchable URL of a supporting doc to attach (e.g. DISCHARGE.pdf). */
    docUrl?: string
    fileName?: string
  }>
}

/**
 * Map each disclosure key to a regex that matches the typical SureLC
 * carrier-question / questionnaire prompt text. If a question's label
 * matches a regex AND the corresponding disclosure is true, answer Yes.
 *
 * Verified against the Foresters contract PDF (Sydney 2026-05-07 — all
 * answers No, matched her clean DB record).
 */
const DISCLOSURE_LABEL_PATTERNS: Array<{
  key: keyof NonNullable<RepReviewInput["disclosures"]>
  pattern: RegExp
}> = [
  // Felony / criminal — covers "convicted of a felony", "no contest to any
  // Felony", "18 USC 1033", "violation of...".
  { key: "q1_felony", pattern: /felon|convict|no\s*contest|18\s*usc\s*1033|criminal/i },
  // Misdemeanor distinct prompt (often combined with felony in carriers).
  { key: "q2_misdemeanor", pattern: /misdemeanor/i },
  // Regulatory action / commissioner / department of insurance complaint.
  { key: "q3_regulatory_action", pattern: /(?:state\s+(?:insurance|securities)|commissioner|department\s+of\s+insurance|sanction|disciplinary)/i },
  { key: "q4_license_denied", pattern: /licen[sc]e\s+(?:denied|refused\s+to\s+issue)/i },
  // License suspended/canceled/revoked.
  { key: "q5_license_revoked", pattern: /licen[sc]e\s+(?:suspend|cancel|revok)/i },
  // Insurance company canceled your contract / terminated.
  { key: "q6_insurer_terminated", pattern: /(?:insurance\s+company|insurer)\s+(?:cancel|terminat).*(?:contract|appointment)/i },
  // Bankruptcy — PERSONAL "filed/declared bankruptcy" (Q15/Q15a). The
  // firm (Q15b) and pending (Q15c) variants are peeled off by explicit
  // early-return branches in pickYnForLabel/disclosureKeyForLabel BEFORE
  // this generic pattern runs, so they don't inherit the personal answer.
  { key: "q7_bankruptcy_personal", pattern: /bankrupt/i },
  // Bond denied / surety refused.
  { key: "q8_bond_denied", pattern: /(?:bond|surety).*(?:denied|refused)/i },
  // Unpaid premiums / indebted to insurance company.
  { key: "q9_unpaid_premiums", pattern: /(?:unpaid\s+premium|indebted.*insur|debit\s+balance)/i },
  // Fiduciary breach.
  { key: "q10_fiduciary_breach", pattern: /fiduciary/i },
  // Fraud investigation / subject of any investigation.
  { key: "q11_fraud_investigation", pattern: /(?:fraud|subject\s+of\s+(?:any\s+)?investigation)/i },
  // Consent order / order of any kind.
  { key: "q12_consent_order", pattern: /consent\s+order/i },
  // Continuing-education violation.
  { key: "q13_ce_violation", pattern: /continu(?:ing|ed)\s+education|CE\s+violation/i },
  // Lawsuit / litigation pending / defendant.
  { key: "q14_lawsuit_pending", pattern: /(?:defendant|lawsuit|litigation|civil\s+action)/i },
  // E&O claim.
  { key: "q15_eo_claim", pattern: /(?:e&o|errors\s+and\s+omissions).*claim/i },
  // Judgments / tax liens / bad debts.
  { key: "q16_unsatisfied_judgments", pattern: /(?:judgment|tax\s*lien|bad\s*debt|collection)/i },
  // Financial-institution related.
  { key: "q17_financial_institution", pattern: /financial\s+institution/i },
  // Other names / aliases / DBAs.
  { key: "q18_other_names", pattern: /(?:other\s+names?|alias|dba|prior\s+business\s+name)/i },
  // IRS / tax matters.
  { key: "q19_irs_matters", pattern: /irs|tax\s+matter/i },
]

/**
 * Decide the right Y/N answer for a question based on its visible label
 * + the rep's onboarding disclosures. Returns "Y" only when a disclosure
 * regex matches AND the corresponding flag is true; otherwise "N" (the
 * safe default for all the questions on a typical clean producer).
 */
/**
 * Carrier sub-opt-in questions are NOT background disclosures — they
 * ask which underwriting entities under the umbrella carrier the rep
 * wants to appoint with. Default = YES (include every sub-carrier).
 *
 * Variants seen in the wild (2026-05-23 Kimberly verification):
 *   - American Amicable: "ISSUING COMPANY (Pioneer American): Select
 *     YES to include Pioneer American Ins Co with this request"
 *   - Transamerica: "COMPANY APPOINTMENT REQUEST (Select ALL that
 *     apply): Transamerica Casualty Insurance" (and Life / Financial)
 *
 * Match on either phrasing so we don't have to enumerate every
 * sub-carrier name.
 */
const ISSUING_COMPANY_PATTERN =
  /(?:select\s+yes\s+to\s+include|issuing\s+company|include\s+this\s+(?:carrier|entity).*?with\s+this\s+request|company\s+appointment\s+request)/i

/**
 * Issuing companies S4L is NOT contracted with, even when they ride
 * along on a bundled request. American Amicable's request bundles four
 * issuing-company opt-ins; per Ana's authoritative screenshot of the
 * correct application answers (2026-07-08), only Occidental Life of NC
 * should be YES — Pioneer American, Pioneer Security, AND IA American
 * Life must all be NO (S4L doesn't carry them). The default "include
 * everything" YES wrongly opted agents into them. Answer NO for these
 * specific issuers; all other issuing companies still default YES (we
 * contract with the whole group on every other bundled carrier). Scoped
 * to the issuing-company branch below so it can't affect any other
 * question.
 */
const NON_CONTRACTED_ISSUER_PATTERN =
  /pioneer\s+(?:american|security)|\bia\s+american/i

/**
 * Affirmative product-line questions ("Will you be selling Final
 * Expense products through this Marketing Organization relationship?",
 * carrier-asked variants of "Will you sell <product> with us?", etc).
 * Set4Life agents sell across the full life product line through
 * their MGA (Quility), so these always default to YES.
 *
 * Verified against Mutual of Omaha's Producer Questions screen
 * 2026-05-23 (Kimberly Bates): the FE question was the ONE answer
 * the bot defaulted to N when it should have been Y. Background
 * disclosures + the BMO152.017 agreement checkbox both filled
 * correctly.
 */
const PRODUCT_OPT_IN_PATTERN =
  /will\s+you\s+be\s+selling\s+(?:final\s+expense|life|annuity|medicare|whole\s+life|term)\s+products?/i

export function pickYnForLabel(
  label: string,
  disclosures: RepReviewInput["disclosures"] | undefined,
): "Y" | "N" {
  // Carrier sub-opt-in defaults YES (rep wants the appointment included) —
  // EXCEPT issuers we're not contracted with (e.g. the Pioneer entities
  // bundled under American Amicable), which must be NO so we stop opting
  // agents into carriers S4L doesn't carry.
  if (ISSUING_COMPANY_PATTERN.test(label)) {
    return NON_CONTRACTED_ISSUER_PATTERN.test(label) ? "N" : "Y"
  }
  // Product-line opt-in always YES — Set4Life agents sell the
  // standard life portfolio (FE, Term, Whole Life, Annuity, etc).
  if (PRODUCT_OPT_IN_PATTERN.test(label)) return "Y"
  // "Did you FILE a 1033 form / 1033 waiver?" is a FACTUAL filing
  // question, distinct from the felony background disclosure. The
  // q1_felony regex below otherwise over-matches the literal "1033"
  // (and "felony") in this prompt and wrongly answers Yes — which is a
  // false statement of fact, not a conservative over-disclosure
  // (Jimenez 2026-06-02 Americo: form1033Filed=no but bot answered Yes,
  // creating a spurious red explanation-required flag). A 1033 waiver
  // is filed by very few reps; default No. (Background "have you ever
  // been convicted" felony questions don't contain file/filing/waiver
  // and still match the disclosure pattern correctly.)
  if (/(?:\bfile|\bfiled|\bfiling)\b.{0,40}1033|1033\s*(?:form|waiver)/i.test(label))
    return "N"
  // Securities/investment-regulation VIOLATION question — answer ONLY
  // from the dedicated securities flag. Its wording ("convicted ... no
  // contest", "state securities") otherwise matches the felony (q1) and
  // regulatory (q3) patterns below, so a genuine consumer-complaint
  // disclosure (which sets q3_regulatory_action) — or the literal
  // "convict" token — wrongly answers this Yes, creating an unsatisfiable
  // explanation card that stalls the rep at Producer (Estell 2026-06-03:
  // hadComplaint=yes → securities-violation Q answered Yes → stuck).
  if (/securities\s+or\s+investment(?:\s+related)?\s+regulation/i.test(label)) {
    return disclosures?.q3_securities_violation ? "Y" : "N"
  }
  if (!disclosures) return "N"
  // Back-fill personal-bankruptcy from the legacy coarse flag so older app
  // payloads (which only send q7_bankruptcy) still answer Q15/Q15a "Yes".
  const d = {
    ...disclosures,
    q7_bankruptcy_personal:
      disclosures.q7_bankruptcy_personal ?? disclosures.q7_bankruptcy,
  }
  // Bankruptcy is three separate questions; peel the firm + pending variants
  // off BEFORE the generic /bankrupt/i pattern so they answer from their own
  // flags instead of inheriting the personal answer.
  // Q15b — a brokerage/insurance FIRM you were associated with went bankrupt.
  // Distinguished from the Q15 parent ("...personally OR any...firm...") and
  // Q15a ("personally filed...") by the ABSENCE of "personal" in the label.
  if (
    /(?:firm|brokerage)\b[\s\S]{0,80}bankrupt/i.test(label) &&
    !/personal/i.test(label)
  ) {
    return d.q7_firm_bankruptcy ? "Y" : "N"
  }
  // Q15c — is the bankruptcy currently PENDING (a discharged bankruptcy is
  // NOT pending; answering Yes here is both false and triggers an
  // unsatisfiable explanation card).
  if (/(?:is\s+the\s+)?bankruptcy\s+(?:is\s+)?pending|pending\s+bankruptcy/i.test(label)) {
    return d.q7_bankruptcy_pending ? "Y" : "N"
  }
  for (const { key, pattern } of DISCLOSURE_LABEL_PATTERNS) {
    if (pattern.test(label) && d[key]) return "Y"
  }
  return "N"
}

/**
 * Which background-disclosure key (if any) this visible question label
 * maps to AND the rep flagged true — i.e. the key that makes
 * pickYnForLabel answer "Y" *because of a disclosure* (NOT the always-Yes
 * carrier/product opt-ins, which aren't disclosures). Returns null for an
 * opt-in, an unrecognized question, or a disclosure whose flag is false.
 *
 * This exists to AUDIT coverage. pickYnForLabel silently returns "N" for
 * any label it doesn't recognize — so when a carrier phrases a background
 * question outside DISCLOSURE_LABEL_PATTERNS (e.g. Foresters' "protection
 * from creditors" vs /bankrupt/), a rep's TRUE disclosure is answered
 * "No" with no signal: a false compliance statement. By recording which
 * true keys actually landed on a label, the caller can detect a true
 * disclosure that matched NOTHING and route to a human instead of signing
 * a wrong "No" (Tamara Chinchilla / Foresters 2026-06-10 — and note the
 * earlier "verified against Foresters" pass was an all-No rep, where the
 * silent-No default hid the gap).
 *
 * Kept in lockstep with pickYnForLabel's disclosure branches above; any
 * change there must change here too.
 */
export function disclosureKeyForLabel(
  label: string,
  disclosures: RepReviewInput["disclosures"] | undefined,
): string | null {
  if (!disclosures) return null
  if (ISSUING_COMPANY_PATTERN.test(label)) return null
  if (PRODUCT_OPT_IN_PATTERN.test(label)) return null
  if (/(?:\bfile|\bfiled|\bfiling)\b.{0,40}1033|1033\s*(?:form|waiver)/i.test(label))
    return null
  if (/securities\s+or\s+investment(?:\s+related)?\s+regulation/i.test(label)) {
    return disclosures.q3_securities_violation ? "q3_securities_violation" : null
  }
  // Lockstep with pickYnForLabel's bankruptcy split: back-fill personal from
  // the legacy flag, then peel firm (Q15b) + pending (Q15c) off before the
  // generic /bankrupt/i loop so the coverage-audit signal stays correct.
  const d = {
    ...disclosures,
    q7_bankruptcy_personal:
      disclosures.q7_bankruptcy_personal ?? disclosures.q7_bankruptcy,
  }
  if (
    /(?:firm|brokerage)\b[\s\S]{0,80}bankrupt/i.test(label) &&
    !/personal/i.test(label)
  ) {
    return d.q7_firm_bankruptcy ? "q7_firm_bankruptcy" : null
  }
  if (/(?:is\s+the\s+)?bankruptcy\s+(?:is\s+)?pending|pending\s+bankruptcy/i.test(label)) {
    return d.q7_bankruptcy_pending ? "q7_bankruptcy_pending" : null
  }
  for (const { key, pattern } of DISCLOSURE_LABEL_PATTERNS) {
    if (pattern.test(label) && d[key]) return key
  }
  return null
}

/**
 * Step-4 Carrier-Questions explanation-modal filler.
 *
 * A "Yes" carrier-question answer makes SureLC render a red
 * `<sb-info-message type="error" action="Add">` card ("Please, provide
 * description or/and attach files" + an ADD button). The request cannot
 * advance to Review & Sign until every such card is satisfied — this is
 * what strands disclosure-Yes reps at Producer across the whole red-flag
 * backlog (Americo/AmAm et al., 2026-06-02). SureLC moved this to a modal
 * the old fill logic never touched.
 *
 * Drives the ADD modal per card: set occurrence date, type the
 * explanation text, attach a supporting doc (preferring an
 * already-uploaded one to avoid orphans), then CREATE via the full
 * pointer sequence Angular Material needs. Fully defensive: only acts
 * when red cards exist, never throws, and closes a stuck modal so it
 * can't block subsequent cards or the Next button. Captures the modal
 * DOM/screenshot for validation.
 */
async function fillCarrierQuestionExplanations(
  ctx: TabContext,
  input: RepReviewInput,
  idx: number,
): Promise<{ cards: number; filled: number; unsatisfied: string[] }> {
  const { page, logger } = ctx
  const pool = input.carrierQuestionExplanations || []

  // Names of explanation-required cards we could NOT satisfy this run.
  // Stashed on the page so the Step-6 wizard-block classifier can name
  // the exact blocking card in its reason (instead of the generic
  // "stuck on /wizard/welcome"). Reset each call; the classifier reads
  // (page as any)._lastUnsatisfiedCards.
  const unsatisfied: string[] = []
  ;(page as any)._lastUnsatisfiedCards = unsatisfied

  // Matches the explanation-required card on BOTH the Carrier-Questions
  // step (action="Add") and the Questionnaire step (action="ADD
  // EXPLANATION") — same sb-info-message component, both type="error".
  const ADD_SEL = 'sb-info-message[type="error"] button.message__button'
  const initialCards = await page.locator(ADD_SEL).count().catch(() => 0)
  if (initialCards === 0) return { cards: 0, filled: 0, unsatisfied }

  logger.info(
    { idx, cards: initialCards, poolSize: pool.length },
    "[Rep step4] explanation-required cards present; driving ADD modal(s)",
  )
  await snapshot(ctx, `rep-carrier${idx}-step4-add-cards`)

  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()

  let filled = 0
  // Re-query each pass — satisfying a card mutates the DOM. Bound the
  // loop so an unfillable card can never spin forever.
  for (let pass = 0; pass < initialCards + 2; pass++) {
    const addBtn = page.locator(ADD_SEL).first()
    if ((await addBtn.count().catch(() => 0)) === 0) break

    const questionText = await addBtn
      .evaluate((btn) => {
        const card =
          btn.closest("sb-question, .question, .details_content, mat-card") ||
          btn.closest("div")
        const root =
          (card?.parentElement &&
            card.parentElement.closest("sb-question, .question, mat-card")) ||
          card
        return (root?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240)
      })
      .catch(() => "")

    const qn = norm(questionText)
    const pick =
      pool.find(
        (e) => e.questionText && qn.includes(norm(e.questionText).slice(0, 28)),
      ) ||
      pool.find((e) => e.explanation) ||
      pool[0]

    if (!pick || !pick.explanation) {
      unsatisfied.push(questionText.slice(0, 120) || "(unnamed card)")
      logger.warn(
        { idx, questionText, poolSize: pool.length },
        "[Rep step4] no explanation in pool for card — cannot satisfy; stopping",
      )
      break
    }

    try {
      await addBtn.click({ timeout: 5000, force: true })
      await page.waitForTimeout(1200)
      await snapshot(ctx, `rep-carrier${idx}-add-modal-p${pass}`)

      // All modal interactions are scoped to the visible
      // mat-dialog-container so we never touch the underlying card's "ADD"
      // button (clicking ADD just re-opens the modal — the prior
      // filled:N/remaining:1 churn) or a textarea behind the overlay.
      const dialog = page.locator("mat-dialog-container:visible").last()

      // 1) Occurrence date, if the modal exposes one.
      if (pick.occurrenceDate) {
        const m = pick.occurrenceDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
        const mmddyyyy = m ? `${m[2]}/${m[3]}/${m[1]}` : pick.occurrenceDate
        try {
          const dateInp = dialog
            .locator('input[placeholder*="Occurrence" i], input[placeholder*="date" i]')
            .first()
          if (await dateInp.count()) await dateInp.fill(mmddyyyy)
        } catch {
          /* no date field on this modal — fine */
        }
      }

      // 2) Explanation text → the Description textarea. Playwright .fill()
      //    drives Angular's form control properly; a raw value-set is
      //    dropped by ngModel, so DONE would save an empty description and
      //    the red card would persist (verified Jimenez 2026-06-02).
      let descFilled = false
      try {
        const ta = dialog.locator("textarea").first()
        if (await ta.count()) {
          await ta.fill(pick.explanation)
          descFilled = true
        }
      } catch (err: any) {
        logger.warn({ idx, err: err?.message }, "[Rep step4] description fill threw")
      }

      // 3) Attach an existing uploaded doc via its inline SELECT button.
      //    The modal lists the rep's already-uploaded explanation/DISCHARGE
      //    docs under "Other documents available"; reusing one needs no
      //    filechooser (the prior UPLOAD-new path timed out). The card is
      //    "or/and" so the description alone can satisfy it — this is
      //    belt-and-braces and harmless when the list is empty.
      let attached = false
      try {
        const sel = dialog.locator('button:has-text("SELECT")').first()
        if (await sel.count()) {
          await sel.click({ timeout: 4000 }).catch(() => undefined)
          await page.waitForTimeout(700)
          attached = true
        }
      } catch (err: any) {
        logger.warn({ idx, err: err?.message }, "[Rep step4] SELECT existing-doc threw")
      }

      // 4) Commit via the modal's DONE button, scoped to the dialog so we
      //    never hit the underlying card's ADD button (which re-opens the
      //    modal). Playwright's click runs the full pointer sequence
      //    Material's handler expects.
      let saved = false
      try {
        // Step-4 carrier-questions modal commits via DONE; the
        // Questionnaire (step-5) modal commits via CREATE. Click
        // whichever ENABLED primary button this modal exposes (a
        // disabled one means required fields are still missing).
        const commit = dialog
          .locator(
            'button:has-text("DONE"):not([disabled]), button:has-text("CREATE"):not([disabled])',
          )
          .first()
        await commit.click({ timeout: 5000 })
        saved = true
      } catch (err: any) {
        logger.warn({ idx, err: err?.message }, "[Rep step4] commit (DONE/CREATE) click threw")
      }
      await page.waitForTimeout(1500)

      if (saved && (descFilled || attached)) {
        filled++
        logger.info(
          { idx, descFilled, attached, q: questionText.slice(0, 80) },
          "[Rep step4] explanation modal submitted",
        )
      } else {
        unsatisfied.push(questionText.slice(0, 120) || "(unnamed card)")
        logger.warn(
          { idx, saved, descFilled, attached, q: questionText.slice(0, 80) },
          "[Rep step4] explanation modal not satisfied — capturing + closing",
        )
        await snapshot(ctx, `rep-carrier${idx}-add-modal-p${pass}-unfilled`)
        await page
          .evaluate(() => {
            const c = Array.from(document.querySelectorAll("button")).find(
              (b) =>
                /CANCEL|CLOSE/.test((b.textContent || "").trim().toUpperCase()) &&
                (b as HTMLElement).offsetWidth > 0,
            )
            if (c) (c as HTMLElement).click()
          })
          .catch(() => undefined)
        await page.waitForTimeout(800)
        // Discard any "unsaved changes" confirm.
        await page
          .evaluate(() => {
            const y = Array.from(document.querySelectorAll("button")).find(
              (b) =>
                b.textContent?.trim().toUpperCase() === "YES" &&
                (b as HTMLElement).offsetWidth > 0,
            )
            if (y) (y as HTMLElement).click()
          })
          .catch(() => undefined)
        await page.waitForTimeout(600)
        break
      }
    } catch (err: any) {
      logger.warn(
        { idx, err: err?.message },
        "[Rep step4] explanation-card handling threw",
      )
      break
    }
  }

  const remaining = await page.locator(ADD_SEL).count().catch(() => 0)
  logger.info(
    { idx, filled, remaining, unsatisfied },
    "[Rep step4] explanation modal pass complete",
  )
  return { cards: initialCards, filled, unsatisfied }
}

export async function repReview(
  browser: Browser,
  input: RepReviewInput,
  parentLogger: pino.Logger,
  jobId: string,
): Promise<{ ok: boolean; signed: number; failed: Array<{ reason: string }>; skipped: Array<{ reason: string }> }> {
  const logger = parentLogger.child({ component: "rep-review" })
  const ctxBrowser = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  })
  const page = await ctxBrowser.newPage()
  page.setDefaultTimeout(30_000)

  // Use a writable temp dir so snapshots actually land somewhere. The
  // Dokku herokuish runtime user can't write to /app; previous runs
  // looked like they were creating snapshots but were silently dropping
  // them on permission errors.
  const evidenceDir = `/tmp/surelc-bot-rep-${jobId}`
  const ctx: TabContext = {
    page,
    logger,
    jobId,
    evidenceDir,
    evidenceFiles: [],
  }

  let signed = 0
  const failed: Array<{ reason: string }> = []
  // Carriers that were withdrawn/discarded by the agency — never a
  // failure, never retryable. Kept separate from `failed[]` so a
  // withdrawn dupe can't flip an otherwise-clean run to failed (which
  // would churn the daily sweep and falsely demote the agent).
  const skipped: Array<{ reason: string }> = []

  try {
    // ── Step 0 — Auth ──────────────────────────────────────────────
    // The /sbweb/login.jsp URL bootstraps an Angular SPA (ar-review
    // bundle) that renders the auth form ~3-5s after page load. The
    // initial DOM is just a loading spinner; if we look for SSN inputs
    // before Angular mounts, firstVisible returns nothing. Wait for
    // any Material input field to appear, then take the snapshot so
    // future debugging sees the actual form, not the spinner.
    await page.goto(input.reviewUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    logger.info({ landingUrl: page.url() }, "[Rep auth] navigated to review URL")
    // Wait for the Angular form to mount. Material inputs use either
    // `<input matinput>` (older themes) or `<input class="mat-mdc-input-element">`
    // (MDC theme — the variant SureLC uses on review.surelc).
    const matInputAppeared = await page
      .waitForSelector(
        'input[matinput], input.mat-mdc-input-element, input[type="password"], mat-form-field input, sb-auth input, auth-component input',
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false)
    await settle(page, 3000)
    logger.info(
      {
        finalUrl: page.url(),
        matInputAppeared,
      },
      "[Rep auth] post-mount state",
    )
    await snapshot(ctx, "rep-step0-auth-page")
    // Diagnostic: log every visible <input> attribute set so future
    // selector tweaks have ground truth from the actual DOM.
    try {
      const inputAttrs = await page.$$eval('input', (els: any[]) =>
        els
          .filter((el: any) => el.offsetParent !== null)
          .map((el: any) => ({
            type: el.getAttribute("type"),
            name: el.getAttribute("name"),
            id: el.id,
            placeholder: el.getAttribute("placeholder"),
            ariaLabel: el.getAttribute("aria-label"),
            autocomplete: el.getAttribute("autocomplete"),
            classes: el.className,
          })),
      )
      logger.info({ inputAttrs }, "[Rep auth] visible inputs on auth page")
    } catch (err: any) {
      logger.warn({ err: err?.message }, "[Rep auth] failed to enumerate inputs")
    }

    // SureLC's rep auth form (verified Sydney 2026-05-07 12:02 from
    // the actual DOM dump at accounts.surancebay.com/oauth/authorize):
    //
    //   <auth-ssn-input id="auth-ssn-input-0" name="ssn">
    //     <input class="hidden">          ← keystrokes go here (Material mask)
    //     <input class="visible" readonly> ← display only
    //   </auth-ssn-input>
    //
    //   <auth-date-input formcontrolname="dob">
    //     <input matinput type="text" id="mat-input-0">  ← DOB text input
    //     <input matnativecontrol id="mat-input-1">      ← datepicker shadow
    //   </auth-date-input>
    //
    //   <button mat-flat-button>LOGIN</button>
    //
    // The custom auth-ssn-input component routes keystrokes from
    // either inner input into the masked formcontrol. We click the
    // outer component to focus, then keyboard.type() the 6 digits.
    // For DOB, mat-input-0 is a plain text input; .fill works.

    // RETRY for SureLC's intermittent email/password gate: the login.jsp
    // bypass (and sometimes the emailed link) lands on the standard
    // email/password login instead of the rep SSN/DOB gate — there's no
    // auth-ssn-input then. Re-navigating the review URL re-triggers the
    // OAuth flow and yields the SSN/DOB gate on a later attempt (verified
    // manually 2026-06-03; the 2nd open reliably gave SSN/DOB). Without
    // this the run no-ops on the email-skew/bypass path.
    let ssnHost = await page.$('auth-ssn-input')
    for (let gateAttempt = 1; gateAttempt <= 3 && !ssnHost; gateAttempt++) {
      logger.warn(
        { gateAttempt, url: page.url() },
        "[Rep auth] SSN/DOB gate not present (email/password gate?) — re-navigating review URL",
      )
      await page.waitForTimeout(1500 * gateAttempt)
      await page
        .goto(input.reviewUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
        .catch(() => undefined)
      await page
        .waitForSelector(
          'auth-ssn-input, input[matinput], input.mat-mdc-input-element, input[type="password"]',
          { timeout: 30_000 },
        )
        .catch(() => undefined)
      await settle(page, 2500)
      ssnHost = await page.$('auth-ssn-input')
    }
    if (!ssnHost) {
      return { ok: false, signed, failed: [{ reason: "SSN field not found at auth (email/password gate persisted after retries)" }], skipped }
    }
    // Focus the inner masked input directly (the .hidden one is the
    // event-target; the .visible one is readonly and the outer host
    // doesn't receive keystrokes). Use evaluate to focus regardless of
    // Playwright's visibility heuristic.
    const ssnFocused = await page
      .evaluate(() => {
        const el = document.querySelector(
          "auth-ssn-input input.hidden, auth-ssn-input input:not([readonly])",
        ) as HTMLInputElement | null
        if (!el) return false
        el.focus()
        return true
      })
      .catch(() => false)
    if (!ssnFocused) {
      // Last-resort: click the host element so Material catches focus.
      await ssnHost.click().catch(() => undefined)
    }
    await page.waitForTimeout(300)
    await page.keyboard.type(input.ssnLast6, { delay: 100 })
    await page.waitForTimeout(500)
    await snapshot(ctx, "rep-step0a-after-ssn")

    // DOB — auth-date-input has TWO inner inputs:
    //   - id="mat-input-0"  type="text" matinput → THIS is the typeable one
    //   - id="mat-input-1"  matnativecontrol      → datepicker shadow input
    // Target by id specifically. fill() on mat-input-0 with force:true
    // bypasses Material's "element not editable" check (which it
    // sometimes reports while the parent form-field hasn't switched
    // out of the "empty" state yet).
    const dobSlashed = input.dob.replace(/-/g, "/")
    const dobInput = await page.$(
      'auth-date-input input#mat-input-0, auth-date-input input[type="text"]:not([readonly]):not([matnativecontrol])',
    )
    if (!dobInput) {
      return { ok: false, signed, failed: [{ reason: "DOB field not found at auth" }], skipped }
    }
    try {
      await (dobInput as any).fill(dobSlashed, { force: true, timeout: 10_000 })
    } catch {
      // Fallback — set value via JS, dispatch input/change events so
      // Angular's reactive form picks it up.
      await page.evaluate((val: string) => {
        const el = document.querySelector(
          'auth-date-input input#mat-input-0, auth-date-input input[type="text"]:not([readonly]):not([matnativecontrol])',
        ) as HTMLInputElement | null
        if (!el) return
        const proto = Object.getPrototypeOf(el)
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
        setter?.call(el, val)
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
        el.dispatchEvent(new Event("blur", { bubbles: true }))
      }, dobSlashed)
    }
    // Tab to commit datepicker / trigger validation.
    await page.keyboard.press("Tab").catch(() => undefined)
    await page.waitForTimeout(500)
    await snapshot(ctx, "rep-step0a-fields-filled")

    const authBtn = await firstVisible(page, [
      'button:has-text("LOGIN")',
      'button:has-text("Login")',
      'button:has-text("Sign In")',
      'button:has-text("Authenticate")',
      'button:has-text("Verify")',
      'button:has-text("Continue")',
      'button:has-text("Submit")',
      'button[type="submit"]',
      'button.mat-flat-button.mat-primary',
    ])
    if (!authBtn) {
      return { ok: false, signed, failed: [{ reason: "LOGIN button not found at auth" }], skipped }
    }
    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {}),
      authBtn.click(),
    ])
    await settle(page, 3000)
    logger.info({ urlAfterAuth: page.url() }, "[Rep auth] post-LOGIN URL")
    await snapshot(ctx, "rep-step0b-after-auth")

    // ── Step 0b — Policy Accept (conditional, one-time) ────────────
    if (!input.policyAccepted) {
      await acceptPoliciesIfShown(page)
    }

    // ── Multi-carrier loop ─────────────────────────────────────────
    // Build the queue: first URL we already navigated to, then any
    // additional URLs the caller passed (one per carrier). After
    // signing each one, SureLC routes us to /reviewed where there's
    // no obvious "next pending" CTA — so we drive directly via URL.
    // If no additional URLs were passed, we still try the historical
    // "next pending request" button for backwards compatibility.
    const additional = input.additionalReviewUrls ?? []
    const max = input.maxCarriers ?? Math.max(20, 1 + additional.length)
    const totalIterations = Math.min(max, 1 + additional.length)
    for (let i = 0; i < totalIterations; i++) {
      try {
        const result = await reviewOneCarrier(ctx, i, input)
        if (result.skipped) {
          // Withdrawn / structurally-unsignable — not a failure.
          skipped.push({ reason: result.skipReason || result.reason || "skipped" })
        } else if (result.ok) {
          signed += 1
        } else {
          failed.push({ reason: result.reason || "unknown" })
        }

        // Move to the next appointment.
        if (i + 1 < totalIterations) {
          const nextUrl = additional[i] // i=0 has been done by initial goto; additional[0] is carrier #2
          if (nextUrl) {
            logger.info({ nextUrl }, "[Rep loop] navigating to next pending appointment")
            await page.goto(nextUrl, {
              waitUntil: "domcontentloaded",
              timeout: 60_000,
            })
            // Auth + policies should be remembered via cookies — no
            // need to re-enter SSN/DOB. Just settle and the wizard
            // resumes.
            await settle(page, 3000)
          } else {
            // Fallback: legacy "next pending" CTA scan.
            const next = await firstVisible(page, [
              'button:has-text("View Pending")',
              'button:has-text("Next Request")',
              'button:has-text("Continue")',
              'a:has-text("next")',
            ])
            if (!next) {
              logger.info("no more pending requests visible — exiting rep loop")
              break
            }
            await next.click()
            await settle(page, 1500)
          }
        } else {
          logger.info(
            { signed, attempted: i + 1 },
            "[Rep loop] all queued carriers processed",
          )
        }
      } catch (err: any) {
        failed.push({ reason: err?.message || "exception" })
        logger.warn({ err: err?.message, iteration: i }, "rep review iteration failed")
        break
      }
    }

    // A run is OK when there were no GENUINE failures and we either
    // signed something or had only skips (all carriers withdrawn → a
    // benign "nothing to sign", not a failure to retry/demote on).
    // Genuine failures (browser crash, live-request PDF stall, carrier
    // wizard red-notice) stay in `failed[]` and keep the run retryable.
    const ok = failed.length === 0 && (signed > 0 || skipped.length > 0)
    return { ok, signed, failed, skipped }
  } finally {
    await ctxBrowser.close().catch(() => {})
  }
}

async function reviewOneCarrier(
  ctx: TabContext,
  idx: number,
  input: RepReviewInput,
): Promise<TabResult> {
  const { page, logger } = ctx
  // Fast-path: if this appointment was already signed in a prior run,
  // SureLC redirects /sbweb/login.jsp?... straight to /ar-review/
  // appointment/{id}/reviewed, skipping the wizard entirely. Detect
  // that and return ok early so the chain moves on without timing out
  // on selectors that won't appear.
  await page.waitForTimeout(2000)
  const url = page.url()
  // Withdrawn fast-path: when the agency has discarded this
  // appointment-request, SureLC redirects the review link to
  // /ar-review/appointment/<id>/withdrawn-request. No PDF/wizard will
  // ever load. Detect the redirect up front and SKIP (not fail) before
  // entering the 4-minute PDF budget — this is the dominant Phase-B
  // churn source (stale follow-up emails point at discarded dupes).
  if (/\/appointment\/[^/]+\/withdrawn-request/.test(url)) {
    logger.info({ url }, "[Rep step6] appointment withdrawn by agency (URL redirect) — skipping")
    await snapshot(ctx, `rep-carrier${idx}-withdrawn`)
    return {
      ok: false,
      skipped: true,
      skipReason: "appointment_withdrawn",
      reason: `appointment_withdrawn (URL redirect to /withdrawn-request): ${url}`,
    }
  }
  // No-states fast-path: when the appointment-request was created with
  // NO licensing states attached (Fastlane state-checkbox sweep missed
  // them for a sparse-license rep), SureLC redirects the review link to
  // /ar-review/appointment/<id>/no-states and the welcome step shows a
  // red "states required" notice the bot can't clear from rep data. The
  // fix is the agency-admin PATCH that sets the appointment's states to
  // the rep's resident state (/patch-appointments-to-resident-state),
  // which the backoffice fires reactively. For that to work it needs an
  // extractable appointment id and a distinct token to key on — emit
  // both here, and bail before wasting the 4-minute PDF budget. This is
  // a FAILURE (not a skip): the carrier can be signed once states are
  // populated, so it should trigger the patch + targeted retry.
  const noStatesMatch = url.match(/\/appointment\/([^/]+)\/no-states/)
  if (noStatesMatch) {
    logger.warn({ url, appointmentId: noStatesMatch[1] }, "[Rep step6] appointment has no licensing states (URL redirect to /no-states) — needs resident-state PATCH")
    await snapshot(ctx, `rep-carrier${idx}-no-states`)
    return {
      ok: false,
      reason: `appointment_no_states: the appointment-request has no licensing states attached, so the carrier wizard blocks on /no-states. Needs a resident-state PATCH. appointment/${noStatesMatch[1]} ${url}`,
    }
  }
  if (/\/appointment\/[^/]+\/reviewed/.test(url)) {
    // prefillOnly mode wants to walk EVERY carrier's wizard fresh —
    // SureLC sometimes redirects to /reviewed for in-progress
    // appointments (not just fully-signed ones), and we lose the
    // opportunity to update prefill answers when we short-circuit
    // here. Kimberly 2026-05-23: every retry hit this fast-path
    // even though her contracts were all PRODUCER stage.
    if (input.prefillOnly) {
      // Navigate explicitly to /wizard/welcome to force the bot
      // through the step-by-step flow.
      const match = url.match(/\/appointment\/([^/]+)/)
      const appt = match ? match[1] : null
      if (appt) {
        const welcomeUrl = `https://surelc.surancebay.com/ar-review/appointment/${appt}/wizard/welcome`
        logger.info({ url, welcomeUrl }, "[Rep prefillOnly] forcing walk via /wizard/welcome (skipping fast-path)")
        await page.goto(welcomeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined)
        await page.waitForTimeout(3000)
      } else {
        logger.warn({ url }, "[Rep prefillOnly] couldn't extract appointmentId from /reviewed URL — proceeding anyway")
      }
    } else {
      logger.info(
        { url },
        "[Rep step6] appointment already signed (auth landed on /reviewed) — skipping",
      )
      await snapshot(ctx, `rep-carrier${idx}-already-signed`)
      return { ok: true, alreadyDone: true }
    }
  }

  // SureLC ar-review wizard (verified Sydney 2026-05-07 step5-pdf.html
  // — the navigator showed Step 5 of 6 = "questionnaire", Step 6 =
  // "review & sign"). The 6 steps:
  //
  //   1) welcome           → Next
  //   2) training          → Next (pre-filled if AML on profile)
  //   3) errors & omissions → Next (pre-filled if E&O cert attached)
  //   4) carrier questions → Y/N/A radios (value="N") + Next
  //   5) questionnaire     → true/false radios (value="false") + Next
  //   6) review & sign     → wait for PDF + Apply My Signature
  await snapshot(ctx, `rep-carrier${idx}-step1-welcome`)

  // URL-aware navigation: keep clicking NEXT until we land on
  // /misc/info (the Carrier Questions URL slug). Previous
  // implementation called clickNextWhenEnabled a fixed 4 times,
  // which overshot Carrier Questions on carriers without a Counties
  // step (most). Each over-click advanced to the next step, so
  // fillRadios ran on Questionnaire or Review&Sign and reported
  // answered:0. Kimberly 2026-05-24 verification: confirmed the
  // bot was reaching wrong page; local harness with URL-aware loop
  // reaches CQ reliably + radio clicks persist.
  for (let i = 0; i < 6; i++) {
    if (/\/wizard\/misc\/info/.test(page.url())) break
    // tickTelemarketingOnlyIfPresent handles the FL Counties step
    // (no-op when not present). Run on every iteration since the
    // step can appear anywhere between Welcome and Training.
    await tickTelemarketingOnlyIfPresent(ctx)
    await clickNextWhenEnabled(ctx)
  }
  await snapshot(ctx, `rep-carrier${idx}-step4-carrier-questions-entry`)
  logger.info(
    { url: page.url(), step: "step4-entry" },
    "[Rep prefillOnly] reached carrier-questions step",
  )

  // Belt-and-suspenders: SureLC's Carrier Questions page makes a
  // heavier per-step API call (fetching carrier question templates
  // + saved answers). Wait for that to settle before reading the
  // DOM.
  await page
    .waitForLoadState("networkidle", { timeout: 15_000 })
    .catch(() => undefined)
  await snapshot(ctx, `rep-carrier${idx}-step4-carrier-questions`)

  // Step 4 — Carrier Questions: per-question Y/N from the rep's
  // disclosures. Any flagged disclosure whose label-pattern matches a
  // visible question becomes Y; everything else stays N. With no
  // disclosures passed (legacy callers), every question defaults to N
  // — the same behavior as before.
  const step4Filled = await fillRadiosByLabelLookup(
    page,
    "yn",
    input.disclosures,
  )
  logger.info(
    { ...step4Filled },
    "[Rep step4] carrier questions answered from disclosures",
  )
  // Some carriers (e.g. Occidental Life) require additional text
  // inputs on this same step — cellPhone, placeOfBirth, residentCounty.
  await fillCarrierProfileText(ctx, input.producerProfile)
  await page.waitForTimeout(800)
  await snapshot(ctx, `rep-carrier${idx}-step4-carrier-questions-answered`)
  // Any "Yes" answer that demands a written description/attachment shows a
  // red sb-info-message[action="Add"] card; SureLC blocks Review & Sign
  // until each is filled via its ADD modal. This is the carrier-questions
  // analog of the profile Questions explanation flow and the single
  // biggest cause of disclosure-Yes reps stalling at Producer (2026-06-02).
  try {
    await fillCarrierQuestionExplanations(ctx, input, idx)
    await page.waitForTimeout(600)
  } catch (err: any) {
    ctx.logger.warn(
      { idx, err: err?.message },
      "[Rep step4] fillCarrierQuestionExplanations threw (non-fatal)",
    )
  }
  await clickNextWhenEnabled(ctx)
  // Same wait pattern for step 5 — Questionnaire is another heavy
  // page transition; without networkidle the radios race the fill.
  await page
    .waitForLoadState("networkidle", { timeout: 15_000 })
    .catch(() => undefined)
  await snapshot(ctx, `rep-carrier${idx}-step5-questionnaire`)

  // Step 5 — Questionnaire: SureLC uses value="true" / value="false"
  // here. Same disclosure-aware fill — true matches any flagged
  // disclosure, false everywhere else.
  const step5Filled = await fillRadiosByLabelLookup(
    page,
    "tf",
    input.disclosures,
  )
  logger.info(
    { ...step5Filled },
    "[Rep step5] questionnaire answered from disclosures",
  )

  // Compliance guard — every TRUE disclosure must have landed on a
  // recognized question across Step 4 + Step 5. A true flag that matched
  // NO label means this carrier words that question outside our patterns,
  // so pickYnForLabel silently answered "No" — a false statement we must
  // never sign. Route the carrier to a human instead (Foresters dropped
  // Tamara Chinchilla's Yes answers this way, 2026-06-10). Clean reps (no
  // true disclosures) are unaffected — automation proceeds exactly as
  // before.
  if (input.disclosures) {
    // Biographical disclosures are NOT material adverse-event questions, so
    // a carrier wizard that doesn't surface them must NOT hard-block the
    // sign. "Have you ever used other names / aliases / DBAs" (q18) is
    // biographical: the actual names are already captured on the producer
    // profile + the SureLC questionnaire (priorFinancialNames), and many
    // carriers don't ask it on their Step 4/5 wizard at all. Treating it
    // like felony/fraud/bankruptcy needlessly stranded every alias-flagged
    // rep at Producer (Julia Davis 2026-06-17 — 8 carriers blocked solely
    // on q18_other_names). It is STILL answered "Yes" whenever a matching
    // question appears (DISCLOSURE_LABEL_PATTERNS unchanged); it just no
    // longer blocks when none does. All adverse disclosures (felony, fraud,
    // bankruptcy, license/regulatory actions, judgments, E&O claims, etc.)
    // remain strictly guarded exactly as before.
    // q19_irs_matters added 2026-07-08 (owner-approved, Option A): several
    // carriers' wizards have NO IRS-matters question at all — verified
    // American Amicable's full Step-4/5 question list (its only tax item is
    // the "judgments / tax liens / bad debts / collections" question, which
    // maps to q16 and is answered separately). When a carrier simply doesn't
    // ask about IRS matters, there is nothing to answer, so leaving it
    // unplaced is not a false statement and must not hard-block the sign
    // (was stranding Claudia Martinez on AmAm 2026-07-07). It is STILL
    // answered "Yes" whenever a matching IRS/tax-matter question appears
    // (DISCLOSURE_LABEL_PATTERNS unchanged); it just no longer blocks when
    // none does — same treatment as q18_other_names. All truly-adverse
    // disclosures (felony, fraud, bankruptcy, license/regulatory actions,
    // judgments/tax liens q16, E&O claims, etc.) remain strictly guarded.
    const NON_BLOCKING_UNPLACED_KEYS = new Set([
      "q18_other_names",
      "q19_irs_matters",
    ])
    const trueKeys = Object.entries(input.disclosures)
      .filter(([k, v]) => v === true && !NON_BLOCKING_UNPLACED_KEYS.has(k))
      .map(([k]) => k)
    const placed = new Set<string>([
      ...step4Filled.placedKeys,
      ...step5Filled.placedKeys,
    ])
    const unplaced = trueKeys.filter((k) => !placed.has(k))
    if (unplaced.length > 0) {
      await snapshot(ctx, `rep-carrier${idx}-disclosure-unplaced`)
      // Log the ACTUAL question labels this carrier surfaced so we can see
      // how it worded the unmatched disclosure (e.g. the IRS/tax question)
      // and widen the DISCLOSURE_LABEL_PATTERNS regex precisely — instead
      // of guessing at synonyms on a compliance-sensitive question.
      const seenLabels = [...step4Filled.labels, ...step5Filled.labels].filter(Boolean)
      logger.warn(
        { idx, unplaced, placed: [...placed], seenLabels },
        "[Rep] true disclosure(s) matched no carrier question — routing to human, not signing",
      )
      return {
        ok: false,
        reason:
          `Questionnaire disclosure(s) [${unplaced.join(", ")}] were flagged true at onboarding ` +
          `but matched NO question on this carrier's Step 4/5 wizard — the carrier likely phrases ` +
          `them outside the bot's label patterns, so they would be silently answered "No" (a false ` +
          `compliance statement). A human must answer this carrier's questionnaire by hand. Do NOT auto-sign.`,
      }
    }
  }

  await page.waitForTimeout(800)
  await snapshot(ctx, `rep-carrier${idx}-step5-questionnaire-answered`)
  // The Questionnaire step also shows red "ADD EXPLANATION" cards for any
  // legitimately-Yes answer (e.g. the felony question, q1) — same
  // sb-info-message component as step 4. Without filling them SureLC blocks
  // Review & Sign (Jimenez Transamerica 2026-06-03). Reuse the same handler.
  try {
    await fillCarrierQuestionExplanations(ctx, input, idx)
    await page.waitForTimeout(600)
  } catch (err: any) {
    ctx.logger.warn(
      { idx, err: err?.message },
      "[Rep step5] fillCarrierQuestionExplanations threw (non-fatal)",
    )
  }
  await clickNextWhenEnabled(ctx)

  // Pre-fill mode bails here. Steps 1-5 are auto-saved by SureLC on
  // each Next click, so when the rep returns via their email link
  // they land on Step 6 with disclosures + carrier-questions already
  // answered. The rep only has to scroll the PDF + Apply Signature.
  if (input.prefillOnly) {
    logger.info(
      { carrier: idx },
      "[Rep prefillOnly] steps 1-5 saved; skipping Step 6 sign",
    )
    await snapshot(ctx, `rep-carrier${idx}-prefill-complete`)
    return { ok: true, details: { prefilled: true } }
  }

  // Step 6 — Review & Sign: PDF viewer renders, then Apply My
  // Signature button enables once the rep has scrolled to the bottom.
  await snapshot(ctx, `rep-carrier${idx}-step6-review-loading`)
  const pdfReady = await waitForPdfViewer(page)
  if (!pdfReady) {
    const diag = (page as any)._lastPdfDiag
    const diagSummary = diag
      ? Object.entries(diag)
          .filter(([, v]) => Array.isArray(v) ? v.length : !!v)
          .map(([k, v]) => {
            if (Array.isArray(v)) {
              const joined = v
                .map((item) =>
                  typeof item === "object" && item !== null
                    ? JSON.stringify(item)
                    : String(item),
                )
                .join(" | ")
              return `${k}: ${joined}`
            }
            return `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`
          })
          .join(" || ")
          .slice(0, 800)
      : ""
    // Classify: not a PDF speed issue but a wizard validation block?
    // Keyon Foresters 2026-05-10: bot stuck on /wizard/welcome with
    // "Red notices indicate what is required". Means the carrier's
    // wizard rejected the rep's profile data before reaching Step 6
    // (PDF render). Surface a specific reason so admin doesn't try
    // to fix imaginary PDF-render problems.
    const url = String(diag?.url || "")
    const errorsBlob = (diag?.errors || []).join(" ").toLowerCase()
    const bodyExcerpt = String(diag?.bodyExcerpt || "")
    // Withdrawn-appointment detection: when SureLC's review page
    // renders for an appointment-request that the agency has discarded
    // (via /surecrm/appointments-requests DELETE), the page shows
    // "Agency has withdrawn this request for review. Please contact
    // your agency for details" instead of the contract PDF. Verified
    // Maria Lugo 2026-05-21: her mailbox had stale SureLC emails from
    // prior-day discarded appointments; the bot followed those links
    // (the URLs in the emails still auth-resolve to the appointment
    // record, the page just renders the withdrawn-banner), waited
    // 90s+30s for the PDF viewer, then bailed with the generic "PDF
    // viewer did not load" — which sent admins chasing imaginary
    // rendering bugs. Surface this as its own reason so the
    // server-side orchestrator can skip-and-move-on instead of
    // patching state / retrying.
    const isWithdrawn =
      (diag as any)?.withdrawn === true ||
      /agency has withdrawn this request/i.test(bodyExcerpt) ||
      /contact your agency for details/i.test(bodyExcerpt)
    if (isWithdrawn) {
      return {
        ok: false,
        skipped: true,
        skipReason: "appointment_withdrawn",
        reason: `appointment_withdrawn: the appointment-request was discarded by the agency before signing. The follow-up email the bot followed points at the withdrawn record; SureLC will issue a fresh email for the new appointment-request created by the most recent Phase A run. URL: ${url}`,
      }
    }
    const isWizardBlock =
      url.includes("/wizard/welcome") ||
      url.includes("/wizard/profile") ||
      /red\s*notice|required.*continue|invalid.*profile/i.test(errorsBlob)
    if (isWizardBlock) {
      // Name the exact blocker instead of the generic "stuck on welcome".
      // Two sources: (1) explanation cards fillCarrierQuestionExplanations
      // couldn't satisfy (no pool entry / modal failed), (2) red required
      // fields per wizard step from the PDF-viewer diag. This converts the
      // reason into an actionable inventory for the admin / needs-human tab.
      const unsatisfiedCards = ((page as any)._lastUnsatisfiedCards || []) as string[]
      const redByStep = (Array.isArray(diag?.stepContents) ? diag.stepContents : [])
        .filter((s: any) => Array.isArray(s?.redFields) && s.redFields.length)
        .map((s: any) => `${s.stepLabel}: ${s.redFields.join("; ")}`)
      const blockedOn = [
        unsatisfiedCards.length
          ? `unsatisfiable carrier-question card(s): ${unsatisfiedCards.join(" || ")}`
          : "",
        redByStep.length ? `red required fields → ${redByStep.join(" || ")}` : "",
      ]
        .filter(Boolean)
        .join(". ")
      return {
        ok: false,
        reason: `Carrier wizard rejected the rep's profile on ${url.split("/").pop() || "wizard step"} — not a PDF issue.${blockedOn ? ` BLOCKED ON — ${blockedOn}.` : ""} Diag: ${diagSummary}`,
      }
    }
    return {
      ok: false,
      reason: `PDF viewer did not load after retries${diagSummary ? `. Diag: ${diagSummary}` : ""}`,
    }
  }
  await snapshot(ctx, `rep-carrier${idx}-step6-review-loaded`)

  // Scroll to the bottom of the PDF viewer multiple times — SureLC
  // tracks scroll position and only enables sign once user has seen
  // every page. Some viewers lazy-load pages on scroll so we may need
  // a few passes for the bottom to actually be the bottom.
  for (let pass = 0; pass < 5; pass++) {
    await scrollViewerToBottom(page)
    await page.waitForTimeout(1500)
  }
  await snapshot(ctx, `rep-carrier${idx}-step6-after-scroll`)

  // Sign button. Verified Sydney 2026-05-07: SureLC ar-review's button
  // is a <button mat-flat-button color="primary"> with inner
  // <span class="mdc-button__label"> Apply my signature </span>.
  //
  // Selector engines (getByRole, :has-text) race with Angular's late
  // mount of <sb-ar-sign> after PDF render. We poll the DOM ourselves
  // for an enabled button matching the text, then click it via
  // Playwright (NOT JS .click() — Material's ripple-bound handler
  // needs the full pointer event sequence Playwright dispatches).
  let signHandle: any = null
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    signHandle = await page
      .evaluateHandle(() => {
        return (
          Array.from(
            document.querySelectorAll<HTMLButtonElement>("button"),
          ).find(
            (b) =>
              !b.disabled &&
              !b.classList.contains("mat-mdc-button-disabled") &&
              /apply.*signature/i.test(b.textContent || ""),
          ) ?? null
        )
      })
      .catch(() => null)
    if (signHandle && (await signHandle.asElement?.())) {
      const el = signHandle.asElement()
      if (el) {
        await el.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined)
        await el.click({ force: true, timeout: 5_000 }).catch(async () => {
          // Last resort — synthesize a full pointer event sequence
          // through Playwright's input.dispatchEvent so Material's
          // _RippleRenderer + click handler both fire.
          await el.dispatchEvent("pointerdown")
          await el.dispatchEvent("pointerup")
          await el.dispatchEvent("click")
        })
        break
      }
    }
    await page.waitForTimeout(1000)
  }
  const clicked = signHandle && (await signHandle.asElement?.())

  if (!clicked) {
    // Diagnostic — log every visible button so future debugging knows
    // exactly what to add to the selector list.
    try {
      const visibleBtns = await page.$$eval('button', (btns: any[]) =>
        btns
          .filter((b: any) => b.offsetParent !== null && !b.disabled)
          .map((b: any) => b.textContent?.trim().slice(0, 60)),
      )
      logger.warn(
        { visibleEnabledButtons: visibleBtns },
        "[Rep step6] no Apply Signature button matched",
      )
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      reason: "Apply My Signature button not enabled / not found",
    }
  }
  logger.info("[Rep step6] Apply my signature clicked — handling dialog chain")
  // SureLC's signature flow opens up to TWO dialogs in sequence:
  //
  //   Dialog A (sometimes): "Please Review & Sign — This contract
  //     request will not be submitted until you review the following
  //     documents and apply your signature. [OK]"
  //   Dialog B (always):    "Apply Your Signature — By selecting SIGN,
  //     I, {Name}, agree to adopt the electronic representation of my
  //     signature... [SIGN] [CANCEL]"
  //
  // Click OK on Dialog A → re-click "Apply my signature" → click SIGN
  // on Dialog B. Loop with retries because Material's dialog open is
  // animated and Playwright sees a transient empty dialog.
  await page.waitForTimeout(1500)
  await dismissReviewSignWarning(ctx)
  await clickSignConsentDialog(ctx)

  // Give SureLC a generous window — submitting the signature triggers a
  // server round-trip + page transition (often to a confirmation banner
  // or to the next pending request). 12s is comfortably above the
  // 6-9s the manual flow shows in Thomas's Loom.
  await settle(page, 12_000)
  logger.info({ urlAfterSign: page.url() }, "[Rep step6] post-sign URL")
  await settle(page, 2500)
  await snapshot(ctx, `rep-carrier${idx}-step6-signed`)

  // Look for confirmation.
  const confirm = await page.$(
    'text=/sent|submitted|thank you|complete|success|received|signed/i',
  )
  if (!confirm) {
    return { ok: false, reason: "no confirmation marker after signing" }
  }
  return { ok: true }
}

async function acceptPoliciesIfShown(page: Page): Promise<void> {
  // SureLC's /ar-review/policies page (verified Sydney 2026-05-07):
  //   <sb-policies>
  //     <iframe class="policyFrame" src=".../announcement_viewer.jsp?policyId=N">
  //     <mat-checkbox class="acceptCheckbox">
  //       <input type="checkbox" id="mat-mdc-checkbox-0-input">
  //     </mat-checkbox>
  //     <button class="acceptPolicyButton" disabled>Accept policy</button>
  //   </sb-policies>
  //
  // The Accept button is disabled until the "I have read" checkbox
  // is checked. May appear multiple times in sequence (e.g. Terms of
  // Use → Privacy Policy). Loop until it disappears.
  for (let i = 0; i < 4; i++) {
    const onPolicies =
      page.url().includes("/policies") ||
      (await page.$("sb-policies, .acceptPolicyButton")) !== null
    if (!onPolicies) return

    // Check the "I have read" checkbox. The `mat-checkbox` host has
    // class `acceptCheckbox`; clicking the host toggles the inner
    // input. Use a JS click as Material's MDC ripple sometimes
    // intercepts Playwright's hit test.
    await page
      .evaluate(() => {
        const cb = document.querySelector(
          ".acceptCheckbox input[type='checkbox'], mat-checkbox.acceptCheckbox input",
        ) as HTMLInputElement | null
        if (cb && !cb.checked) cb.click()
      })
      .catch(() => undefined)
    await page.waitForTimeout(500)

    // Wait for the Accept button to enable, then click it.
    const acceptEnabled = await page
      .waitForSelector(
        'button.acceptPolicyButton:not([disabled]):not(.mat-mdc-button-disabled)',
        { timeout: 10_000 },
      )
      .catch(() => null)
    if (!acceptEnabled) {
      // Last resort — click via JS bypassing visibility/enabled gates.
      await page
        .evaluate(() => {
          const btn = Array.from(
            document.querySelectorAll<HTMLButtonElement>(
              "button.acceptPolicyButton",
            ),
          ).find((b) => !b.disabled)
          btn?.click()
        })
        .catch(() => undefined)
    } else {
      await acceptEnabled.click().catch(() => undefined)
    }
    await page.waitForTimeout(2000)
  }
}

/**
 * Fill required text inputs that some carriers add to Step 4 (carrier
 * questions). Standard carriers only need Y/N radios; carriers like
 * Occidental Life add cellPhone, placeOfBirth, residentCounty, etc.
 *
 * Strategy: enumerate every visible matinput on the page, and for each
 * one with a `formcontrolname` we recognize (or any required-empty
 * one), fill from the producerProfile or fall back to a placeholder
 * that passes validation but is obviously a placeholder so admins can
 * fix it later if needed.
 */
async function fillCarrierProfileText(
  ctx: TabContext,
  profile: RepReviewInput["producerProfile"],
): Promise<void> {
  const { page, logger } = ctx
  if (!profile) return
  // Map formcontrolname → value. Empty values get skipped.
  const map: Record<string, string | undefined> = {
    cellPhone: profile.cellPhone,
    homePhone: profile.homePhone,
    placeOfBirth: profile.placeOfBirth,
    residentCounty: profile.residentCounty,
  }
  let filled = 0
  for (const [fc, val] of Object.entries(map)) {
    if (!val) continue
    // Carriers vary on whether they expose Angular's formcontrolname or
    // the plain HTML name attribute. Match either.
    const input = await page.$(
      `input[matinput][name="${fc}"], input[matinput][formcontrolname="${fc}"], mat-form-field input[name="${fc}"], mat-form-field input[formcontrolname="${fc}"]`,
    )
    if (!input) continue
    try {
      await input.fill(val, { force: true, timeout: 5_000 })
      // Tab so Material's reactive form picks it up + validation runs.
      await page.keyboard.press("Tab").catch(() => undefined)
      filled++
    } catch {
      /* ignore */
    }
  }
  if (filled > 0) {
    logger.info({ filled }, "[Rep step4] filled carrier-specific text inputs")
  }
  // Some carriers (e.g. Mutual of Omaha) add a required checkbox on
  // the same step — typically a single "I confirm" / "I agree" tick.
  // Tick every required checkbox that's still in the ng-pristine
  // (untouched) state.
  const ticked = await page.evaluate(() => {
    const cbs = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"][required]',
      ),
    )
    let count = 0
    for (const cb of cbs) {
      if (!cb.checked && cb.offsetParent !== null) {
        cb.click()
        count++
      }
    }
    return count
  })
  if (ticked > 0) {
    logger.info({ ticked }, "[Rep step4] ticked required checkboxes")
  }

  // Sweep: any "Type here" text inputs that are still empty and
  // ng-invalid (visible required fields). Some carriers (e.g.
  // Corebridge) require emergency-contact text inputs the producer
  // profile doesn't carry — fill with "N/A" so the form validates.
  // Only touches invalid + empty fields — pre-filled inputs are not
  // overwritten.
  const naFilled = await page.evaluate(
    ({ email, phone }: { email?: string; phone?: string }) => {
      const setNative = (el: HTMLInputElement, val: string) => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set
        if (setter) setter.call(el, val)
        else el.value = val
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
        el.dispatchEvent(new Event("blur", { bubbles: true }))
      }
      const inputs = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          'input[matinput], input.mat-mdc-input-element',
        ),
      )
      let count = 0
      for (const i of inputs) {
        if (i.type === "checkbox" || i.type === "radio") continue
        if (i.value && i.value.trim().length > 0) continue
        if (i.offsetParent === null) continue
        const ff = i.closest("mat-form-field") as HTMLElement | null
        // Target both already-invalid AND required-but-empty fields:
        // validation often hasn't fired yet on a freshly-loaded step, so
        // required-empty is the reliable signal (Americo's phone +
        // BENEFICIARY-email block step 4 this way — S.Way 2026-06-02).
        const required =
          i.required ||
          i.getAttribute("aria-required") === "true" ||
          !!ff?.querySelector(
            ".mat-mdc-form-field-required-marker, .mat-form-field-required-marker",
          )
        const invalid =
          ff?.classList.contains("mat-form-field-invalid") ||
          i.classList.contains("ng-invalid")
        if (!required && !invalid) continue
        const hay = (
          (i.getAttribute("placeholder") || "") +
          " " +
          (i.getAttribute("name") || "") +
          " " +
          (i.getAttribute("formcontrolname") || "") +
          " " +
          (i.type || "") +
          " " +
          (ff?.textContent || "")
        ).toLowerCase()
        // Type-aware value: an email field needs a valid email (N/A fails
        // validation), a phone field needs digits; everything else N/A.
        let val = "N/A"
        if (i.type === "email" || /e-?mail/.test(hay))
          val = email || "agent@set4lifeagency.com"
        else if (i.type === "tel" || /phone|cell|mobile|fax/.test(hay))
          val = (phone || "0000000000").replace(/\D/g, "") || "0000000000"
        setNative(i, val)
        count++
      }
      return count
    },
    { email: profile.email, phone: profile.cellPhone },
  )
  if (naFilled > 0) {
    logger.info(
      { naFilled },
      "[Rep step4] filled required text fields (type-aware email/phone/N-A)",
    )
  }

  // Re-click any radio group still in `.question__select--invalid`
  // OR `mat-radio-group.ng-pristine` state. The Playwright click in
  // fillRadiosByLabelLookup occasionally lands on an Angular form
  // model that hasn't bound yet (Sydney 2026-05-07 Corebridge: bot
  // logged answered:3 but NEW BUSINESS group stayed ng-pristine
  // ng-invalid). The retry uses a more aggressive sequence:
  // scrollIntoView → click on the inner native control → dispatch
  // change event manually.
  const recovered = await page.evaluate(() => {
    const invalidGroups = Array.from(
      document.querySelectorAll<HTMLElement>(
        "mat-radio-group.ng-pristine.ng-invalid, mat-radio-group.question__select--invalid",
      ),
    )
    let fixed = 0
    for (const g of invalidGroups) {
      // Default to "No" / "false" — disclosure-true cases were already
      // handled by the labeled fill; anything still invalid is an N/false.
      const noInput = g.querySelector<HTMLInputElement>(
        'input[type="radio"][value="N"], input[type="radio"][value="false"]',
      )
      if (!noInput) continue
      noInput.scrollIntoView({ block: "center" })
      const host = noInput.closest("mat-radio-button") as HTMLElement | null
      if (host) {
        host.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
        host.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
        host.click()
      }
      // Force the input itself too — covers cases where the host's click
      // handler is shadowed by an overlay.
      noInput.click()
      noInput.checked = true
      noInput.dispatchEvent(new Event("input", { bubbles: true }))
      noInput.dispatchEvent(new Event("change", { bubbles: true }))
      fixed++
    }
    return fixed
  })
  if (recovered > 0) {
    logger.info(
      { recovered },
      "[Rep step4] re-bound radio groups that stayed ng-pristine after first click",
    )
  }
}

/**
 * If the "Please Review & Sign" warning dialog is open, click OK to
 * dismiss it, then re-click "Apply my signature" so the SIGN consent
 * dialog opens. No-op if the dialog isn't shown.
 */
async function dismissReviewSignWarning(ctx: TabContext): Promise<void> {
  const { page, logger } = ctx
  const okBtn = await page
    .locator(
      "mat-dialog-container button, .mat-mdc-dialog-container button, .cdk-overlay-pane button",
    )
    .filter({ hasText: /^\s*(OK|Ok|Continue|I Understand)\s*$/ })
    .first()
    .elementHandle({ timeout: 4_000 })
    .catch(() => null)
  if (!okBtn) return
  logger.info("[Rep step6] dismissing 'Please Review & Sign' warning dialog")
  await okBtn.click({ force: true }).catch(() => undefined)
  await page.waitForTimeout(1500)
  // Re-click Apply my signature so the SIGN consent dialog opens.
  const reSign = await page
    .evaluateHandle(() => {
      return (
        Array.from(
          document.querySelectorAll<HTMLButtonElement>("button"),
        ).find(
          (b) =>
            !b.disabled &&
            !b.classList.contains("mat-mdc-button-disabled") &&
            /apply.*signature/i.test(b.textContent || ""),
        ) ?? null
      )
    })
    .catch(() => null)
  const reSignEl = reSign?.asElement?.()
  if (reSignEl) {
    logger.info("[Rep step6] re-clicking Apply my signature post-warning-OK")
    await reSignEl
      .scrollIntoViewIfNeeded({ timeout: 3_000 })
      .catch(() => undefined)
    await reSignEl.click({ force: true, timeout: 5_000 }).catch(() => undefined)
    await page.waitForTimeout(1500)
  }
}

/**
 * Click SIGN inside the "Apply Your Signature" e-signature consent
 * dialog. This is the actual submit — after this fires, SureLC posts
 * the signed document and shows the next pending request (or done).
 *
 * The dialog text reads:
 *   "Apply Your Signature — By selecting SIGN, I, <Name>, agree to
 *    adopt the electronic representation of my signature ..."
 *
 * Use a JS scan for an enabled button labelled SIGN inside any open
 * Material dialog/overlay.
 */
async function clickSignConsentDialog(ctx: TabContext): Promise<void> {
  const { page, logger } = ctx
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const handle = await page
      .evaluateHandle(() => {
        const dialogs = document.querySelectorAll(
          'mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane',
        )
        for (const d of Array.from(dialogs)) {
          const btn = Array.from(
            d.querySelectorAll<HTMLButtonElement>("button"),
          ).find(
            (b) =>
              !b.disabled &&
              !b.classList.contains("mat-mdc-button-disabled") &&
              /^\s*sign\s*$/i.test(b.textContent || ""),
          )
          if (btn) return btn
        }
        return null
      })
      .catch(() => null)
    const el = handle?.asElement?.()
    if (el) {
      logger.info("[Rep step6] clicking SIGN in consent dialog")
      await el.click({ force: true, timeout: 5_000 }).catch(() => undefined)
      return
    }
    await page.waitForTimeout(500)
  }
  logger.warn("[Rep step6] SIGN consent dialog never appeared — signature may have already submitted on first click")
}

/**
 * Walk every <mat-radio-group> on the current step, read its question
 * label text, decide the right answer (Y/N for Step 4, true/false for
 * Step 5) using `pickYnForLabel`, and click the matching radio.
 *
 * Returns counts so the bot's log shows {answered, yes, no} for the
 * step — admins can see at a glance whether any disclosures triggered
 * a Yes.
 */
async function fillRadiosByLabelLookup(
  page: Page,
  scheme: "yn" | "tf",
  disclosures: RepReviewInput["disclosures"] | undefined,
): Promise<{ answered: number; yes: number; no: number; placedKeys: string[]; labels: string[] }> {
  const yesValue = scheme === "yn" ? "Y" : "true"
  const noValue = scheme === "yn" ? "N" : "false"

  // Wait for at least one mat-radio-group to render. Without this,
  // the enumerate-then-click logic can race past Angular's bind step
  // and find zero groups on a page that visibly has multiple Y/N
  // questions (Paul Magistri 2026-05-08 Corebridge: 3 unanswered
  // radios but bot reported 0; Kimberly Bates 2026-05-23 MoO: same
  // 3 radios, same answered:0). Bumped from 8s → 20s after the
  // 2026-05-23 incident where the step 4 page took ~12s to settle
  // on MoO and the bot lost every prefill answer for that carrier.
  await page
    .waitForSelector("mat-radio-group input[type=\"radio\"]", { timeout: 20_000 })
    .catch(() => undefined)

  // Collect (label, group-name) pairs from the live DOM.
  const groups = await page.evaluate(() => {
    const out: Array<{ name: string; label: string; values: string[] }> = []
    const seen = new Set<string>()
    const radioGroups = Array.from(document.querySelectorAll("mat-radio-group"))
    for (const g of radioGroups) {
      const firstInput = g.querySelector(
        "input[type=\"radio\"]",
      ) as HTMLInputElement | null
      if (!firstInput) continue
      const name = firstInput.name
      if (!name || seen.has(name)) continue
      seen.add(name)
      // Find the question label — bot saw class="question__text" in
      // step5-questionnaire and similar markup in step4. Walk up the
      // tree to find the closest sb-question / .wrap container, then
      // pull its label text.
      const container =
        g.closest("sb-question, .wrap, mat-form-field, mat-card") || g.parentElement
      const labelEl =
        container?.querySelector(
          ".question__text, label.question__text, mat-label, label",
        )
      const label = (labelEl?.textContent || "").trim().slice(0, 300)
      const values = Array.from(
        g.querySelectorAll('input[type="radio"]'),
      ).map((i) => (i as HTMLInputElement).value)
      out.push({ name, label, values })
    }
    return out
  })

  let yes = 0
  let no = 0
  // Disclosure keys we actually placed a "Yes" on (label recognized +
  // committed). The caller diffs this against the rep's true flags to
  // catch a disclosure that matched no on-screen question.
  const placed = new Set<string>()
  for (const { name, label, values } of groups) {
    const ans = pickYnForLabel(label, disclosures)
    const placedKey = ans === "Y" ? disclosureKeyForLabel(label, disclosures) : null
    // Per-group value detection: a single wizard step can MIX schemes —
    // carrier Y/N questions alongside background-disclosure questions
    // rendered with value="true"/"false" on the SAME step (American
    // Amicable & others put the felony/securities/sanction questions on
    // step 4 with true/false radios, not Y/N). The page-level `scheme`
    // is only a fallback hint; pick THIS group's actual yes/no value so a
    // true/false disclosure question on a "yn" step still gets answered.
    // Otherwise the click selector ([value="N"]) matches nothing, the
    // question keeps its pre-set Yes, and its unsatisfiable explanation
    // card strands the rep at Producer (Estell/Bates 2026-06-03 — 10
    // disclosure groups on step 4 went unanswered, 8 stayed Yes).
    const noVal = values.find((v) => /^(n|no|false|0)$/i.test(v)) ?? noValue
    const yesVal = values.find((v) => /^(y|yes|true|1)$/i.test(v)) ?? yesValue
    const targetValue = ans === "Y" ? yesVal : noVal
    // Click the radio with matching value within this group. We do
    // this via Playwright's locator.click() — the previous host.click()
    // from page.evaluate fired a synthetic DOM event that Angular
    // Material would intermittently miss in change-detection (verified
    // Sydney 2026-05-07: 9 click ops returned ok:true but the group
    // for DRIVERS LICENSE stayed ng-touched ng-pristine ng-invalid →
    // "Next" disabled → Phase B blocked at step 4 + bot mistakenly
    // reported "PDF viewer did not load" because step 6 was unreachable).
    // Playwright's pointer events go through the full mousedown/up/click
    // sequence Material's ripple-bound handler expects.
    const radioSel = `input[type="radio"][name="${name}"][value="${targetValue}"]`
    let clicked = false
    try {
      const locator = page.locator(`mat-radio-button:has(${radioSel})`).first()
      await locator.click({ timeout: 5000, force: true })
      clicked = true
    } catch {
      /* fall back to JS click below */
    }
    // Verify the TARGET value actually committed — not just that the
    // group left ng-pristine. Angular Material commits a radio only on
    // a <label> click; a Playwright pointer-click on the host or the
    // hidden <input> can leave a question that was PRE-answered Yes
    // (stored from an earlier run / carrier default) unchanged. That
    // stranded the whole red-flag backlog: the regulatory "violation"
    // questions stayed Yes, kept their red explanation card, and the
    // carrier never reached Review & Sign (2026-06-02; verified by hand
    // that input.click/host.click did NOT flip a stored Yes but
    // label.click did). Re-click the matching radio's <label> until its
    // native input reports checked.
    for (let attempt = 0; attempt < 3; attempt++) {
      const committed = await page
        .evaluate(({ groupName, value }) => {
          const r = document.querySelector(
            `input[type="radio"][name="${groupName}"][value="${value}"]`,
          ) as HTMLInputElement | null
          return !!r && r.checked
        }, { groupName: name, value: targetValue })
        .catch(() => false)
      if (committed) {
        clicked = true
        break
      }
      await page
        .evaluate(({ groupName, value }) => {
          const r = document.querySelector(
            `input[type="radio"][name="${groupName}"][value="${value}"]`,
          ) as HTMLInputElement | null
          const host = r?.closest("mat-radio-button") as HTMLElement | null
          const label = host?.querySelector("label") as HTMLElement | null
          ;(label || host || r)?.click()
        }, { groupName: name, value: targetValue })
        .catch(() => undefined)
      await page.waitForTimeout(300)
    }
    if (clicked) {
      if (ans === "Y") {
        yes++
        if (placedKey) placed.add(placedKey)
      } else no++
    }
  }
  return {
    answered: yes + no,
    yes,
    no,
    placedKeys: [...placed],
    // Raw question labels seen on this step — surfaced so the caller can
    // log exactly how a carrier worded a question that matched no
    // disclosure pattern (e.g. an IRS/tax question phrased outside the
    // q19_irs_matters regex), which is what we need to widen the pattern
    // safely instead of guessing.
    labels: groups.map((g) => g.label).filter(Boolean),
  }
}

/**
 * Click every Material radio with the given native value attribute.
 * SureLC's Y/N/A questions and true/false questionnaires both use
 * <mat-radio-button> with native <input type="radio" value="X">. The
 * .hidden inner inputs aren't visible to Playwright's default
 * isVisible check, so use force:true on .check.
 */
async function defaultRadiosToValue(
  page: Page,
  value: string,
): Promise<number> {
  const sel = `input[type="radio"][value="${value}"], input.mdc-radio__native-control[value="${value}"]`
  const radios = await page.$$(sel)
  let clicked = 0
  for (const r of radios) {
    try {
      await r.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined)
      await r.check({ force: true, timeout: 5_000 })
      clicked++
    } catch {
      try {
        const id = await r.evaluate((el: HTMLInputElement) => el.id)
        if (id) {
          await page.evaluate((rid: string) => {
            const inp = document.getElementById(rid) as HTMLInputElement | null
            inp?.click()
          }, id)
          clicked++
        }
      } catch {
        /* ignore */
      }
    }
  }
  return clicked
}

async function clickNext(ctx: TabContext): Promise<void> {
  const next = await firstVisible(ctx.page, [
    'button:has-text("Next"):not([disabled]):not(.mat-mdc-button-disabled)',
    'button:has-text("Continue"):not([disabled]):not(.mat-mdc-button-disabled)',
    'button:has-text("Next")',
    'button:has-text("Continue")',
  ])
  if (next) {
    await next.click().catch(() => undefined)
    await settle(ctx.page, 800)
  }
}

/**
 * Like clickNext but waits up to 15s for the button to become enabled
 * (after Angular's reactive form validation runs). Used after pages
 * that require input — questions, signature, etc. — where the NEXT
 * button starts disabled.
 */
/**
 * Some carriers slot in a county-selection step (FL-resident reps,
 * Transamerica especially) where the rep must pick counties OR tick
 * "No Personal Sells, telemarketing/online/phone only" to proceed.
 * Set4Life agents always sell over the phone — telemarketing is the
 * correct answer. This helper finds that checkbox by label text and
 * ticks it. Returns silently when not present (most carriers, and
 * non-FL reps).
 *
 * Verified Paul Magistri 2026-05-08: bot was stuck silently after
 * Welcome step because Transamerica's wizard refused to advance
 * without a county or telemarketing-tick.
 */
async function tickTelemarketingOnlyIfPresent(ctx: TabContext): Promise<void> {
  const { page, logger } = ctx
  // Playwright locator + force-click — matches the rep-step4 radio
  // fix from earlier today. page.evaluate's host.click() fires a
  // synthetic event Angular Material's change-detection sometimes
  // misses; Playwright's pointer event sequence binds reliably.
  const TARGET_RX = /no\s+personal\s+sells.*telemarketing|telemarketing.*online.*phone/i
  const checkbox = page
    .locator("mat-checkbox")
    .filter({ hasText: TARGET_RX })
    .first()
  const handle = await checkbox.elementHandle({ timeout: 2_000 }).catch(() => null)
  if (!handle) return  // page doesn't have this step / not present
  // If already checked, skip.
  const alreadyChecked = await page
    .evaluate((el) => {
      const input = el?.querySelector<HTMLInputElement>('input[type="checkbox"]')
      return !!input?.checked
    }, handle)
    .catch(() => false)
  if (alreadyChecked) return
  try {
    await checkbox.click({ force: true, timeout: 5_000 })
    // Verify it stuck. If Angular still didn't bind (rare), fall
    // back to clicking the inner input directly.
    const stillUnchecked = await page
      .evaluate((el) => {
        const input = el?.querySelector<HTMLInputElement>('input[type="checkbox"]')
        return input ? !input.checked : true
      }, handle)
      .catch(() => false)
    if (stillUnchecked) {
      await page
        .evaluate((el) => {
          const input = el?.querySelector<HTMLInputElement>('input[type="checkbox"]')
          if (input) {
            input.click()
            input.dispatchEvent(new Event("change", { bubbles: true }))
          }
        }, handle)
        .catch(() => {})
    }
    logger.info("[Rep] ticked 'No Personal Sells / telemarketing only' on county step")
  } catch (err: any) {
    logger.warn(
      { err: err?.message },
      "[Rep] tickTelemarketingOnlyIfPresent: Playwright click failed",
    )
  }
}

async function clickNextWhenEnabled(ctx: TabContext): Promise<void> {
  const { page } = ctx
  // The previous selector picked the FIRST visible "Next"/"Continue"
  // button on the page — but SureLC's ar-review SPA renders a
  // decorative "Next" button at the top-right (header navigation
  // chevron) AND the actual wizard NEXT button at the bottom-right
  // of the page content area. The selector reliably matched the top
  // one, whose click does nothing for wizard progression. Verified
  // 2026-05-24 (Kimberly): clicks succeeded selector-side but the
  // wizard URL never advanced past /welcome.
  //
  // Pick the BOTTOM-MOST enabled Next/Continue/Submit button via
  // in-page JS. The wizard's primary action button is always the
  // farthest down the viewport.
  //
  // Also: clicking via in-page JS bypasses Playwright's visibility
  // check, which intermittently rejects the wizard's Material button
  // even with force:true (the ripple's stability check is finicky).
  await page
    .waitForSelector(
      'button:has-text("NEXT"), button:has-text("Next"), button:has-text("Continue"), button:has-text("Submit")',
      { timeout: 15_000 },
    )
    .catch(() => null)
  const clicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("button")).filter((b) => {
      if (b.disabled) return false
      if (b.classList.contains("mat-mdc-button-disabled")) return false
      const txt = (b.textContent || "").trim()
      return /^(NEXT|Next|Continue|Submit)$/.test(txt)
    })
    if (candidates.length === 0) return false
    // Bottom-most candidate is the wizard's primary action button.
    candidates.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)
    candidates[0].click()
    return true
  })
  if (clicked) {
    // SureLC's wizard step transition takes 2-3s for the new step's
    // Angular Material components to render. Without a sufficient wait
    // the next operation (fillRadios) reads the OUTGOING page's DOM
    // and finds zero radio groups even though the new step has many.
    // 1s settle (the old value) was the root cause of answered:0
    // across every carrier (Kimberly 2026-05-24 verification).
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined)
    await settle(page, 2500)
    return
  }
  // Fallback to clickNext to keep the flow moving (and fail loudly later).
  await clickNext(ctx)
}

async function waitForPdfViewer(page: Page, maxRetries = 2): Promise<boolean> {
  // SureLC ar-review's Step 6 (review & sign) renders the contract
  // inside <sb-sign-viewer> with an inner <div class="pdf-viewer">
  // and a <sb-page-loader> showing "Loading PDF...". The "pdf-viewer"
  // div exists from initial render — waiting for it returns
  // immediately while the actual content is still loading. We need
  // to wait for the LOADER to GO AWAY, then for at least one rendered
  // PDF page (canvas) to appear.
  //
  // 2 retries × (90s loader + 30s render) = 4 min ceiling. Sydney
  // 2026-05-10 successfully signed all 9 carriers within this budget
  // today, so pure render speed is fine. When PDF rendering fails
  // (Keyon Foresters 2026-05-10), it's almost always a state issue:
  // dialog blocking, network error, prior-carrier handoff stuck.
  // The diagnostic block below captures the actual page state when
  // we bail so the next iteration of this function knows what to fix.
  //
  // Fast-path: if the page already renders the "Agency has withdrawn
  // this request" banner (Maria Lugo pattern 2026-05-21 — stale
  // SureLC follow-up email pointed at a withdrawn appointment), bail
  // immediately. No PDF will ever load on a withdrawn appointment,
  // so the 4-min budget is pure waste — 20 carriers stacking up
  // to 80 min of dead retry per Phase B run. Short-circuiting here
  // saves the budget AND populates _lastPdfDiag with the body text
  // so the caller's classifier picks the right specific reason.
  try {
    const earlyDiag = await page.evaluate(() => ({
      url: location.href,
      bodyExcerpt: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300),
    }))
    if (
      /agency has withdrawn this request/i.test(earlyDiag.bodyExcerpt) ||
      /contact your agency for details/i.test(earlyDiag.bodyExcerpt)
    ) {
      ;(page as any)._lastPdfDiag = { ...earlyDiag, withdrawn: true }
      return false
    }
  } catch {
    /* page not ready — fall through to the slow path below */
  }
  for (let i = 0; i < maxRetries; i++) {
    try {
      await page
        .waitForFunction(
          () => {
            const loader = document.querySelector(
              "sb-page-loader, .pane__spinner-text, .container__spinner-text",
            ) as HTMLElement | null
            if (!loader) return true
            const r = loader.getBoundingClientRect?.()
            return !r || r.width === 0 || r.height === 0
          },
          { timeout: 90_000 },
        )
        .catch(() => undefined)
      await page.waitForSelector(
        [
          ".pdf-viewer canvas",
          ".pdf-viewer .page",
          ".pdf-viewer .textLayer",
          ".pdf-viewer img",
          'sb-sign-viewer canvas',
          'sb-document-viewer canvas',
          'iframe[src*="pdf" i]',
          'iframe[src*="viewer" i]',
        ].join(", "),
        { timeout: 30_000 },
      )
      return true
    } catch {
      try {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 })
        await page.waitForTimeout(5000)
      } catch {
        /* ignore */
      }
    }
  }
  // Diagnostic capture — when PDF wait fails, dump what's visible on
  // the page so the next debugging pass knows whether it's a blocking
  // dialog, network error banner, or genuine slow render. Logged at
  // warn level so it shows up in dokku logs alongside the failure.
  try {
    const diag = await page.evaluate(() => {
      const sample = (sel: string) =>
        Array.from(document.querySelectorAll(sel))
          .slice(0, 3)
          .map(
            (n) =>
              ((n as HTMLElement).innerText || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 200),
          )
          .filter(Boolean)
      // Walk EVERY visible element with non-trivial text and check if
      // its computed foreground color is in the red range. This catches
      // SureLC's actual red-icon notices (which use computed CSS color,
      // not class names). Filter to elements with parents that might
      // give the field-label context.
      const redByColor: Array<{ text: string; parentText: string; color: string }> = []
      const seenText = new Set<string>()
      const all = document.querySelectorAll("*")
      for (const el of Array.from(all)) {
        const node = el as HTMLElement
        if (!node.offsetParent && node.tagName !== "BODY") continue // hidden
        const text = (node.innerText || "").replace(/\s+/g, " ").trim()
        if (!text || text.length < 2 || text.length > 80) continue
        // Skip if element has children with text (we want leaf-ish nodes)
        const childText = Array.from(node.children)
          .map((c) => (c as HTMLElement).innerText || "")
          .join("")
          .trim()
        if (childText.length > 0 && childText.length === text.length) continue
        const style = window.getComputedStyle(node)
        const color = style.color
        // rgb(r, g, b) where r > 150 and g, b < 100 = red-ish
        const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
        if (!m) continue
        const r = +m[1], g = +m[2], b = +m[3]
        if (r < 140 || g > 110 || b > 110) continue // not red
        if (seenText.has(text)) continue
        seenText.add(text)
        // Get parent label for context
        const parent = node.parentElement
        const parentText = parent
          ? (parent.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120)
          : ""
        redByColor.push({ text: text.slice(0, 80), parentText, color })
        if (redByColor.length >= 12) break
      }
      return {
        redByColor,
        dialogs: sample("mat-dialog-container, [role=dialog]"),
        snackbars: sample("mat-snack-bar-container, .snack-bar"),
        errors: sample("mat-error, .error, [class*=error-banner]"),
        loaderText: sample(
          "sb-page-loader, .pane__spinner-text, .container__spinner-text",
        ),
        url: location.href,
        title: document.title,
        bodyExcerpt: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300),
      }
    })
    ;(page as any)._lastPdfDiag = diag
    // Also save a fullPage screenshot so the operator can visually
    // identify what's flagged red.
    try {
      const m = page.url().match(/appointment\/(\d+)/)
      const apptId = m?.[1] || "unknown"
      await page.screenshot({
        path: `/tmp/wizard-failure-${apptId}-${Date.now()}.png`,
        fullPage: true,
      })
    } catch {}

    // Capture content of EACH wizard step by clicking through the
    // left-side step navigator. Each step that has "error" in its
    // label may have fillable fields the bot's blind-Next missed.
    // Stash per-step content in _lastPdfDiag.stepContents.
    try {
      const stepNavSelectors =
        'sb-stepper button, .step-nav button, .stepper button, [class*="step-list"] button, mat-step-header'
      const stepCount = await page.$$eval(stepNavSelectors, (els) => els.length)
      const stepContents: Array<{ stepLabel: string; redFields: string[]; allFields: string[] }> = []
      for (let i = 0; i < Math.min(stepCount, 8); i++) {
        try {
          const navHandles = await page.$$(stepNavSelectors)
          if (i >= navHandles.length) break
          const label = await navHandles[i].evaluate(
            (el) => (el as HTMLElement).innerText.replace(/\s+/g, " ").trim().slice(0, 80),
          )
          await navHandles[i].click({ force: true }).catch(() => undefined)
          await page.waitForTimeout(800)
          const content = await page.evaluate(() => {
            const redFields: string[] = []
            const allFields: string[] = []
            // Find inputs/labels that are red
            const all = document.querySelectorAll("mat-label, label, mat-error, input, textarea, .field-label")
            for (const el of Array.from(all).slice(0, 40)) {
              const node = el as HTMLElement
              const text = (node.innerText || "").replace(/\s+/g, " ").trim()
              if (!text || text.length > 100) continue
              const style = window.getComputedStyle(node)
              const m = style.color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/)
              const isRed = m && +m[1] > 140 && +m[2] < 110 && +m[3] < 110
              if (isRed) redFields.push(text.slice(0, 80))
              else if (text.length > 5) allFields.push(text.slice(0, 80))
              if (redFields.length >= 10 && allFields.length >= 15) break
            }
            return { redFields, allFields: allFields.slice(0, 15) }
          })
          stepContents.push({ stepLabel: label, ...content })
        } catch {
          /* continue */
        }
      }
      ;(page as any)._lastPdfDiag = {
        ...((page as any)._lastPdfDiag || {}),
        stepContents,
      }
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
  return false
}

async function scrollViewerToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Find every scrollable container in priority order. SureLC's
    // ar-review uses <div class="pdf-viewer"> with overflow:auto;
    // the lazy-load watcher fires on .scroll() inside that div.
    const selectors = [
      ".pdf-viewer",
      "sb-sign-viewer .pdf-viewer",
      'div[sb-pdf-viewer-with-scroll]',
      '[class*="pdf-viewer"]',
      '[class*="document-viewer"]',
      '[class*="review-content"]',
      '[class*="review-container"]',
      ".content-container",
      "main",
      "body",
    ]
    for (const sel of selectors) {
      const el = document.querySelector(sel) as HTMLElement | null
      if (el && el.scrollHeight > el.clientHeight) {
        el.scrollTop = el.scrollHeight
        return
      }
    }
    window.scrollTo(0, document.body.scrollHeight)
  })
}
