/**
 * A question we could not read must never be answered.
 * Run with: `npx tsx src/rep/review.unreadableLabels.test.ts`
 *
 * No test runner in this repo (build = tsc), so this is a self-contained
 * assertion script that exits non-zero on failure — same shape as
 * review.disclosureLabels.test.ts next door.
 *
 * WHAT HAPPENED (2026-09-22, Carlos Murray Sr, American Amicable)
 *
 * The label lookup for a radio group ended in a bare `label` selector.
 * Every mat-radio-button carries its own <label> reading "Yes" / "No", so
 * on a step whose markup has no `.question__text` and no `mat-label`,
 * `querySelector("label")` returned THE FIRST RADIO'S OWN TEXT and the
 * question silently became the word "Yes".
 *
 * AmAm puts its felony / securities / sanction questions on step 4 with
 * true/false radios — the fill loop's own comment says so. Nine of its
 * labels came back as "Yes". `pickYnForLabel` matches nothing against
 * "Yes", returns its "N" default, and the loop clicked No on all nine.
 * Nine compliance questions answered without ever being read, with no
 * error anywhere.
 *
 * It only surfaced because this rep has a true felony disclosure, so the
 * compliance guard noticed the Yes had been placed nowhere and refused to
 * sign. A rep with a clean record would have had nine blind answers filed
 * and nobody would have known. Ana, reading it from the SureLC side the
 * same afternoon: "a Yes is on our end but on SureLC the same question
 * has not transferred correctly and it is a No on SureLC."
 *
 * Two independent protections, both locked below:
 *   1. the label is never taken from inside a mat-radio-button;
 *   2. a label that is empty, or is just a radio's value word, is treated
 *      as UNREAD — the question is skipped and the sign is refused.
 */
import { readFileSync } from "node:fs"

const SRC = readFileSync(new URL("./review.ts", import.meta.url), "utf8")

let failures = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`)
  }
}

console.log("unreadable-label guard:")

// ── 1. The label is never a radio's own text ────────────────────────────
check(
  "label candidates exclude anything inside a mat-radio-button",
  /\.find\(\(el\) => !el\.closest\("mat-radio-button"\)\)/.test(SRC) ||
    /if \(el\.closest\("mat-radio-button"\)\) return false/.test(SRC),
  'the bare `label` fallback is what produced nine questions named "Yes"',
)

check(
  "the old single-shot querySelector fallback is gone",
  !/container\?\.querySelector\(\s*"\.question__text, label\.question__text, mat-label, label",?\s*\)/.test(
    SRC,
  ),
)

// ── 2. An unread question is skipped, not answered ──────────────────────
const loopStart = SRC.indexOf("for (const { name, label, values } of groups)")
const loopBody = SRC.slice(loopStart, loopStart + 4000)

check("the fill loop was found", loopStart > -1)

check(
  "unread questions are detected before anything is answered",
  loopBody.indexOf("looksUnread") < loopBody.indexOf("pickYnForLabel(label"),
  "pickYnForLabel defaults to N — it must never see an unread label",
)

check(
  'the detector covers the exact failure shape ("Yes"/"No"/"True"/"False")',
  /\/\^\(yes\|no\|true\|false\)\$\/i/.test(SRC),
)

check(
  "an empty label counts as unread too",
  /!label \|\|/.test(loopBody),
)

check(
  "an unread question is skipped with `continue`, never clicked",
  /unreadableQuestions\.push\(name\)\s*\n\s*continue/.test(SRC),
)

// ── 3. It blocks the signature ──────────────────────────────────────────
const guard = SRC.indexOf("Unreadable-question guard")
check("the guard exists", guard > -1)

check(
  "the guard runs BEFORE the signature path",
  guard > -1 && guard < SRC.indexOf("Apply my signature"),
)

check(
  "the guard returns ok:false rather than warning and carrying on",
  SRC.slice(guard, guard + 2600).includes("ok: false"),
)

check(
  "both steps are checked, not just step 4",
  /step4Filled\.unreadableQuestions,\s*\n\s*\.\.\.step5Filled\.unreadableQuestions/.test(
    SRC,
  ),
)

// ── 4. The refusal says what a human has to do ──────────────────────────
check(
  "the reason names the risk in plain words",
  /will not answer a compliance question it cannot read/.test(SRC),
)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log("\nall checks passed")
