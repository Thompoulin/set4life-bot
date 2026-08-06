/**
 * Standalone regression check for disclosure label matching
 * (Set4Life stuck-at-Producer backlog, 2026-08-04).
 * Run with: `npx tsx src/rep/review.disclosureLabels.test.ts`
 *
 * No test runner is installed in this repo (build = tsc), so this is a
 * self-contained assertion script that exits non-zero on failure.
 *
 * Every LABEL string below is verbatim from a real failing run — captured
 * by the `seenLabels` log the unplaced-disclosure branch emits precisely
 * so these patterns can be widened from evidence instead of guessed at.
 * Do NOT "improve" a pattern here against invented wording: on a
 * compliance form the cost of a wrong match is a false legal statement.
 *
 * The bugs this locks down:
 *  1. Carriers bundle several of our disclosures into ONE prompt
 *     ("...license denied, suspended, cancelled or revoked?"). The audit
 *     recorded only the first key, so the second looked unanswered and a
 *     correctly-filled carrier was routed to a human anyway.
 *  2. Three patterns required a word order / adjacency the real carrier
 *     wording doesn't use, so a TRUE disclosure matched nothing and would
 *     have been silently answered "No" — caught by the audit, but it
 *     stranded the rep (Sean Way, Jhovanny Jimenez, Michael Wills,
 *     Shekethia Claiborne — all stuck from 2026-06-05).
 */
import { pickYnForLabel, disclosureKeysForLabel } from "./review.js"

// --- Verbatim labels from the 2026-08-04 seenLabels captures ---
const L_LICENSE =
  "Have you ever had an insurance or securities license denied, suspended, cancelled or revoked?*"
const L_INVESTIGATION =
  "Are you currently under investigation by any legal or regulatory authority?*"
const L_EO =
  "Has any lawsuit or claim ever been made against your surety company, or errors and omissions insurer, arising out of your sales or practices, or, have you been refused surety?"
// Present on the same wizards, must stay unmatched by the widened patterns.
const L_CHARGEBACK =
  "Does any insurer, insured, or other person claim any commission chargeback or other indebtedness from you as a result of any insurance transactions or business?*"
const L_INTERRUPTIONS = "Have you ever had any interruptions in licensing?*"
const L_EO_COVERAGE = "Do you carry errors and omissions coverage?"

let failures = 0
function expectYn(label: string, disc: any, want: "Y" | "N", note: string) {
  const got = pickYnForLabel(label, disc)
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  want=${want} got=${got}  ${note}`)
}
function expectKeys(label: string, disc: any, want: string[], note: string) {
  const got = disclosureKeysForLabel(label, disc).sort()
  const ok = JSON.stringify(got) === JSON.stringify([...want].sort())
  if (!ok) failures++
  console.log(
    `${ok ? "PASS" : "FAIL"}  want=[${want.join(",")}] got=[${got.join(",")}]  ${note}`,
  )
}

// ── 1. One carrier question covering TWO of our disclosures ──────────
// Sean Way / Shekethia Claiborne: q5 true. The answer was always right;
// the audit under-reported and blocked the run.
expectKeys(
  L_LICENSE,
  { q4_license_denied: false, q5_license_revoked: true },
  ["q5_license_revoked"],
  "combined licence question places q5",
)
expectKeys(
  L_LICENSE,
  { q4_license_denied: true, q5_license_revoked: true },
  ["q4_license_denied", "q5_license_revoked"],
  "combined licence question places BOTH q4 and q5 (the audit bug)",
)
expectYn(L_LICENSE, { q5_license_revoked: true }, "Y", "licence question answers Yes on q5")
expectYn(
  L_LICENSE,
  { q4_license_denied: false, q5_license_revoked: false },
  "N",
  "clean rep still answers No",
)

// ── 2. "under investigation" phrasing (no 'fraud', no 'subject of') ──
expectKeys(
  L_INVESTIGATION,
  { q11_fraud_investigation: true },
  ["q11_fraud_investigation"],
  "'currently under investigation' places q11 (Jhovanny / Michael Wills)",
)
expectYn(L_INVESTIGATION, { q11_fraud_investigation: true }, "Y", "q11 answers Yes")
expectYn(L_INVESTIGATION, { q11_fraud_investigation: false }, "N", "clean rep answers No")

// ── 3. E&O where "claim" precedes "errors and omissions" ─────────────
expectKeys(
  L_EO,
  { q15_eo_claim: true },
  ["q15_eo_claim"],
  "'claim ... errors and omissions' places q15 (Sean Way)",
)
expectYn(L_EO, { q15_eo_claim: true }, "Y", "q15 answers Yes")

// ── 4. Must NOT over-match neighbouring questions ────────────────────
// A rep with EVERY disclosure true is the harshest false-positive test:
// anything that matches here would be a false legal statement.
const allTrue = {
  q1_felony: true, q2_misdemeanor: true, q3_regulatory_action: true,
  q4_license_denied: true, q5_license_revoked: true, q9_unpaid_premiums: true,
  q11_fraud_investigation: true, q13_ce_violation: true, q15_eo_claim: true,
  q16_unsatisfied_judgments: true,
}
// "interruptions in licensing" IS q13's real question (the flag is misnamed;
// see section 6). With every disclosure true it must place q13 and ONLY q13.
expectKeys(L_INTERRUPTIONS, allTrue, ["q13_ce_violation"], "'interruptions in licensing' places q13 and nothing else")
expectKeys(L_EO_COVERAGE, allTrue, [], "E&O COVERAGE question is not an E&O CLAIM")
expectYn(L_EO_COVERAGE, allTrue, "N", "E&O coverage question stays No")

// The chargeback question contains the word "claim" — it must not be
// captured by the widened q15 pattern (which needs an E&O token too).
expectKeys(
  L_CHARGEBACK,
  { q15_eo_claim: true, q9_unpaid_premiums: false },
  [],
  "chargeback question is not an E&O claim despite the word 'claim'",
)

// ── 5. q13 must not leak onto UNRELATED questions ────────────────────
// It matches the interruptions-in-licensing question (section 6) and must
// not be placed on any of these, or a rep's answer lands on the wrong form
// field.
for (const [name, l] of Object.entries({ L_LICENSE, L_INVESTIGATION, L_EO, L_CHARGEBACK })) {
  const keys = disclosureKeysForLabel(l, { q13_ce_violation: true })
  const ok = !keys.includes("q13_ce_violation")
  if (!ok) failures++
  console.log(
    `${ok ? "PASS" : "FAIL"}  q13_ce_violation must NOT be placed on ${name} (wrong question)`,
  )
}

// ── 6. q13 is a MISNOMER: the flag means "interruptions in licensing" ──
// Carriers ask it verbatim; the old CE-only pattern matched nothing, so the
// only 4 reps with this flag were routed to a human forever.
const L_INTERRUPT = "Have you ever had any interruptions in licensing?*"
{
  const keys = disclosureKeysForLabel(L_INTERRUPT, { q13_ce_violation: true })
  const ok = keys.includes("q13_ce_violation")
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  interruptions-in-licensing places q13 (Sean Way / Shekethia unblock)`)
  const yn = pickYnForLabel(L_INTERRUPT, { q13_ce_violation: true })
  const ok2 = yn === "Y"
  if (!ok2) failures++
  console.log(`${ok2 ? "PASS" : "FAIL"}  interruptions question answers Yes when disclosed`)
  const yn3 = pickYnForLabel(L_INTERRUPT, { q13_ce_violation: false })
  const ok3 = yn3 === "N"
  if (!ok3) failures++
  console.log(`${ok3 ? "PASS" : "FAIL"}  clean rep answers No to interruptions`)
}
console.log(failures === 0 ? "\nALL PASS (incl. q13)" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
