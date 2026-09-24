/**
 * Conviction Date / County / State on a carrier's Carrier-Questions step,
 * and which of the rep's letters belongs on which explanation card.
 * Run the test with: `npx tsx src/rep/review.convictionFields.test.ts`
 *
 * WHAT HAPPENED (2026-09-23, Carlos Murray Sr, American Amicable 123441828)
 *
 * The felony "Yes" on AmAm's Carrier Questions opens three REQUIRED fields
 * under the answer — Conviction Date, Conviction County, Conviction State.
 * The bot had no data for them, left them empty, NEXT stayed disabled, and
 * every run died at "red notices indicate what is required" without saying
 * which three fields. It also attached his PROBATION letter to the FELONY
 * card: the modal lists every letter the rep uploaded, and the bot clicked
 * the first SELECT.
 *
 * These are compliance answers signed under the rep's name. They are filled
 * ONLY from `convictionDetails` the backoffice passes (the rep's record,
 * questionnaire_responses.surelc_answers.felony.conviction). Nothing is
 * inferred here: fields present with no details → the carrier fails with a
 * reason that names the three fields.
 */
import type { Page } from "playwright"
import type pino from "pino"

export interface ConvictionDetails {
  /** ISO YYYY-MM-DD — the date of conviction (judgment), not the offence. */
  date: string
  county: string
  /** Two-letter code or full name. */
  state: string
}

const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", PR: "Puerto Rico",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
}

/** "KY" / "ky" / "Kentucky" → { code: "KY", name: "Kentucky" }, else null. */
export function normalizeState(s: string): { code: string; name: string } | null {
  const t = (s || "").trim()
  if (!t) return null
  const up = t.toUpperCase()
  if (STATES[up]) return { code: up, name: STATES[up] }
  const hit = Object.entries(STATES).find(([, n]) => n.toLowerCase() === t.toLowerCase())
  return hit ? { code: hit[0], name: hit[1] } : null
}

/** "2007-03-08" → "03/08/2007"; anything else → null (never guessed). */
export function isoToMmDdYyyy(iso: string): string | null {
  const m = (iso || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const [, y, mo, d] = m
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null
  return `${mo}/${d}/${y}`
}

/**
 * Score how well a listed document belongs on a card. The card's question
 * decides the topic; a document is on-topic when its own text names that
 * topic ("convicted…felony" vs "probation"). Returns a number; higher wins,
 * 0 = no evidence.
 */
const TOPICS: Array<{ card: RegExp; doc: RegExp }> = [
  { card: /felon|convicted|18 usc 1033/i, doc: /felon|convicted|conviction/i },
  { card: /misdemeanor/i, doc: /misdemeanor/i },
  { card: /probation|parole|supervis/i, doc: /probation|parole|supervis/i },
  { card: /bankrupt/i, doc: /bankrupt|discharge/i },
  { card: /lien|judg(e)?ment/i, doc: /lien|judg(e)?ment/i },
]
export function scoreDocumentForCard(cardText: string, docText: string, letterStart?: string): number {
  const card = cardText || ""
  const doc = docText || ""
  let score = 0
  for (const t of TOPICS) {
    const cardHas = t.card.test(card)
    const docHas = t.doc.test(doc)
    if (cardHas && docHas) score += 10
    // A letter about another topic is wrong for this card even if it also
    // mentions the word (the probation letter says "felony conviction").
    if (!cardHas && docHas) score -= 4
  }
  // The letter's own "Question:" line is the strongest signal we have.
  const q = doc.match(/Question:\s*([^?]*\?)/i)?.[1]
  if (q) {
    for (const t of TOPICS) if (t.card.test(card) && t.card.test(q)) score += 20
    for (const t of TOPICS) if (!t.card.test(card) && t.card.test(q)) score -= 20
  }
  if (letterStart) {
    const a = letterStart.replace(/\s+/g, " ").trim().slice(0, 60).toLowerCase()
    if (a && doc.replace(/\s+/g, " ").toLowerCase().includes(a)) score += 15
  }
  return score
}

/**
 * Index of the document to SELECT, or null to select none. With a single
 * listed document it is that one (the old behaviour, still right then).
 * With several, only a positive, unique best score qualifies.
 */
export function pickDocumentIndex(cardText: string, docTexts: string[], letterStart?: string): number | null {
  if (docTexts.length === 0) return null
  if (docTexts.length === 1) return 0
  const scores = docTexts.map((d) => scoreDocumentForCard(cardText, d, letterStart))
  const best = Math.max(...scores)
  if (best <= 0) return null
  if (scores.filter((s) => s === best).length > 1) return null
  return scores.indexOf(best)
}

/**
 * Fill Conviction Date / County / State when the step shows them. Returns
 * the names of required conviction fields left EMPTY (because no details
 * were supplied or a fill failed) — the caller turns that into the reason.
 */
export async function fillConvictionFields(
  page: Page,
  details: ConvictionDetails | undefined,
  logger: pino.Logger,
): Promise<string[]> {
  const present = await page
    .evaluate(() => {
      const txt = (document.body.innerText || "").replace(/\s+/g, " ")
      return {
        date: /Conviction Date/i.test(txt),
        county: !!document.querySelector('input[name="felony_county"]') || /Conviction County/i.test(txt),
        state: /Conviction State/i.test(txt),
      }
    })
    .catch(() => ({ date: false, county: false, state: false }))
  const wanted = (Object.keys(present) as Array<keyof typeof present>).filter((k) => present[k])
  if (wanted.length === 0) return []

  const label = { date: "Conviction Date", county: "Conviction County", state: "Conviction State" }
  if (!details) {
    logger.warn({ wanted }, "[Rep step4] conviction fields required but no convictionDetails on file")
    return wanted.map((k) => label[k])
  }

  // Anchor each control on its OWN label and take the next input of the right
  // kind after it. Filtering containers by hasText matched the outer felony
  // question wrapper first (it contains every label), whose first input is a
  // hidden radio — the State click waited 30s and failed on Carlos Murray Sr's
  // American Amicable run, 2026-09-24.
  const inputAfterLabel = (lab: string, predicate = "") =>
    page
      .locator(
        `xpath=//*[normalize-space(text())="${lab}"]/following::input${predicate}[1]`,
      )
      .first()
  const missing: string[] = []

  if (present.date) {
    const v = isoToMmDdYyyy(details.date)
    try {
      if (!v) throw new Error(`unusable date ${details.date}`)
      let inp = inputAfterLabel("Conviction Date", '[@data-cy="date-input"]')
      if (!(await inp.count())) inp = page.locator('sb-date-input input[data-cy="date-input"]').first()
      await inp.fill(v)
      await inp.blur()
    } catch (err: any) {
      logger.warn({ err: err?.message }, "[Rep step4] conviction date fill failed")
      missing.push(label.date)
    }
  }
  if (present.county) {
    try {
      let inp = page.locator('input[name="felony_county"]').first()
      if (!(await inp.count())) inp = inputAfterLabel("Conviction County", '[@type="text"]')
      await inp.fill(details.county.trim())
      await inp.blur()
    } catch (err: any) {
      logger.warn({ err: err?.message }, "[Rep step4] conviction county fill failed")
      missing.push(label.county)
    }
  }
  if (present.state) {
    const st = normalizeState(details.state)
    try {
      if (!st) throw new Error(`unknown state ${details.state}`)
      const inp = inputAfterLabel("Conviction State", '[@role="combobox"]')
      if (!(await inp.count())) throw new Error("no combobox after the Conviction State label")
      await inp.click({ timeout: 8000 })
      await inp.fill(st.name)
      await page.waitForTimeout(600)
      const opt = page
        .locator("mat-option")
        .filter({ hasText: new RegExp(`^\\s*(${st.name}|${st.code})\\b`, "i") })
        .first()
      if (!(await opt.count())) throw new Error(`no option for ${st.name}`)
      await opt.click()
    } catch (err: any) {
      logger.warn({ err: err?.message }, "[Rep step4] conviction state pick failed")
      missing.push(label.state)
    }
  }
  logger.info({ wanted, missing }, "[Rep step4] conviction fields")
  return missing
}
