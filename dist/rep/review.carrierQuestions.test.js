/**
 * Regression check for carrier-specific question handling (NLG, 2026-08-06).
 * Run: `npx tsx src/rep/review.carrierQuestions.test.ts`
 *
 * Question wording is verbatim from Ana's capture of a live NLG request.
 * The bug this locks down: pickYnForLabel defaults ANY unrecognised label to
 * "N", so before this existed the bot answered "No" to both "lawful
 * authorization to work in the US" and "legal resident of the United States"
 * — false statements denying the rep's own attestation.
 */
import { pickYnForLabel, carrierQuestionForLabel } from "./review.js";
const Q_WORK = "Do you attest that you have lawful authorization to work in the United states?";
const Q_RESIDENT = "Are you a legal resident of the United States?";
const Q_NY = "Do you plan to ever solicit business in New York state?";
const Q_FINRA = "FINRA: Have you ever been FINRA licensed?";
const Q_FELONY = "Have you ever been convicted of or plead guilty or no contest to any Felony?*";
let fail = 0;
const check = (ok, note) => { if (!ok)
    fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${note}`); };
// 1. With a real answer, we use it.
check(pickYnForLabel(Q_WORK, undefined, { usWorkAuth: "yes" }) === "Y", "work-auth yes → Y");
check(pickYnForLabel(Q_RESIDENT, undefined, { nlgLegalResidentUs: "yes" }) === "Y", "legal resident yes → Y");
check(pickYnForLabel(Q_NY, undefined, { nlgSolicitNewYork: "no" }) === "N", "solicit NY no → N");
// 2. With NO stored answer, the question is flagged as unanswerable —
//    this is what makes the caller refuse to sign.
for (const [q, slug] of [[Q_WORK, "usWorkAuth"], [Q_RESIDENT, "nlgLegalResidentUs"], [Q_NY, "nlgSolicitNewYork"], [Q_FINRA, "nlgFinraLicensed"]]) {
    const m = carrierQuestionForLabel(q, {});
    check(!!m && m.slug === slug && m.required && m.answer === null, `unanswered "${q.slice(0, 42)}..." → required + answer=null (blocks signing)`);
}
// 3. A normal background disclosure must NOT be captured by this layer.
check(carrierQuestionForLabel(Q_FELONY, {}) === null, "felony question is NOT a carrier-specific question");
// 4. The pre-fix behaviour must be impossible: a required carrier question
//    with no answer must never silently read as a real "No".
const m = carrierQuestionForLabel(Q_RESIDENT, {});
check(m?.answer !== "N", "missing legal-resident answer never becomes N");
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
