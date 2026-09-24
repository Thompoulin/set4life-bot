/**
 * Conviction fields are filled only from the rep's record, and each
 * explanation card gets its own letter.
 * Run with: `npx tsx src/rep/review.convictionFields.test.ts`
 *
 * Carlos Murray Sr, American Amicable 123441828 (2026-09-23): the felony Yes
 * required Conviction Date / County / State the bot had no data for, and the
 * bot attached his PROBATION letter to the FELONY card. See convictionFields.ts.
 */
import { readFileSync } from "node:fs"
import { isoToMmDdYyyy, normalizeState, pickDocumentIndex, scoreDocumentForCard } from "./convictionFields.js"

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

// ── Date / state ───────────────────────────────────────────────────────
check("ISO date renders MM/DD/YYYY", isoToMmDdYyyy("2007-03-08"), "03/08/2007")
check("a non-ISO date is refused, not guessed", isoToMmDdYyyy("03/08/2027"), null)
check("an impossible month is refused", isoToMmDdYyyy("2007-13-08"), null)
check("state code", normalizeState("ky"), { code: "KY", name: "Kentucky" })
check("state name", normalizeState("Kentucky"), { code: "KY", name: "Kentucky" })
check("unknown state", normalizeState("Kentuckee"), null)

// ── Letter pick (the two real letters on Carlos's SureLC profile) ──────
const PROBATION =
  "LETTER OF EXPLANATION Date: August 30, 2026 Question: Have you ever been on probation? REASON: Federal felony conviction and supervised release, 2006. EXPLANATION: I was placed on federal supervision in connection with my felony conviction. I successfully completed all requirements of my sentence and supervision. SELECT"
const FELONY =
  "LETTER OF EXPLANATION Date: August 30, 2026 Question: Have you ever been convicted of or plead guilty or no contest to any Felony? REASON: Federal felony conviction, February 28, 2006 EXPLANATION: Carlos Alexander Murray was convicted of a federal felony arising from an incident in 2006. SELECT"
const FELONY_CARD =
  "Have you ever been convicted of a misdemeanor (other than a minor traffic offense), a felony or violation of 18 USC 1033? Yes No Please, provide description or/and attach files ADD"
const PROBATION_CARD = "Have you ever been on probation? Yes No Please, provide description or/and attach files ADD"

check("felony card picks the felony letter, listed second", pickDocumentIndex(FELONY_CARD, [PROBATION, FELONY]), 1)
check("felony card picks the felony letter, listed first", pickDocumentIndex(FELONY_CARD, [FELONY, PROBATION]), 0)
check("probation card picks the probation letter", pickDocumentIndex(PROBATION_CARD, [FELONY, PROBATION]), 1)
check(
  "the felony letter outscores the probation letter on the felony card",
  scoreDocumentForCard(FELONY_CARD, FELONY) > scoreDocumentForCard(FELONY_CARD, PROBATION),
  true,
)
check("one listed document is still attached", pickDocumentIndex(FELONY_CARD, [PROBATION]), 0)
check("several, none on topic → attach none", pickDocumentIndex("Do you have a drivers license?", [FELONY, PROBATION]), null)
check("no documents → none", pickDocumentIndex(FELONY_CARD, []), null)

// ── Source locks ───────────────────────────────────────────────────────
const review = readFileSync(new URL("./review.ts", import.meta.url), "utf8")
check(
  "the first-SELECT click is gone",
  /button:has-text\("SELECT"\)'\)\s*\.first\(\)/.test(review),
  false,
)
check("the modal uses pickDocumentIndex", review.includes("pickDocumentIndex(questionText, docTexts, pick.explanation)"), true)
check("conviction fields are filled only from input.convictionDetails", review.includes("input.convictionDetails"), true)
check("a missing conviction field is named in the failure", review.includes("for the felony disclosure — not on file"), true)
const conv = readFileSync(new URL("./convictionFields.ts", import.meta.url), "utf8")
check("no fallback value is invented for a field", /details\?\.\w+\s*\|\|\s*"/.test(conv), false)
const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8")
check("server schema lets convictionDetails through zod", /convictionDetails:\s*z/.test(server), true)

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log("\nall passed")

// ── Questionnaire confirm (AmAm, Carlos Murray Sr, 2026-09-24) ─────────
{
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(new URL("./review.ts", import.meta.url), "utf8")
  const ok =
    src.includes("export async function needsQuestionnaireConfirm(") &&
    /for \(let attempt = 0; attempt < 2 && \(await needsQuestionnaireConfirm\(page\)\); attempt\+\+\)/.test(src)
  if (!ok) {
    console.error("FAIL questionnaire confirm: second NEXT press is not wired")
    process.exit(1)
  }
  console.log("ok   questionnaire asks to confirm → NEXT pressed again (max 2)")
}

// ── Question label is never a field caption (Carlos Sr retry, 2026-09-24) ──
{
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(new URL("./review.ts", import.meta.url), "utf8")
  const m = src.match(/const FIELD_CAPTION =\s*\n?\s*(\/.*\/i)/)
  if (!m) { console.error("FAIL label guard: FIELD_CAPTION missing"); process.exit(1) }
  const re = eval(m[1]) as RegExp
  const bad = ["Description", "Attachments", "Conviction Date", "Conviction County*", "Conviction State"]
  const good = ["Have you ever been convicted of a misdemeanor (other than a minor traffic offense), a felony or violation of 18 USC 1033?"]
  const ok = bad.every((t) => re.test(t)) && good.every((t) => !re.test(t))
    && src.includes('for (const sel of [".question__text", "label.question__text", "mat-label", "label"])')
    && src.includes('el.closest("sb-info-message, sb-date-input, mat-dialog-container")')
  if (!ok) { console.error("FAIL label guard: captions/priority not enforced"); process.exit(1) }
  console.log("ok   a field caption (Description, Conviction …) is never read as the question")
}
