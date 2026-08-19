/**
 * Verifies the Questions-tab slug→wording patterns in src/admin/fillProfile.ts.
 *
 * Why this exists. The bot locates each disclosure question by regex-matching its
 * on-page wording. On 2026-08-19 three patterns matched nothing, so Q5, Q8 and
 * Q11 were left blank on every producer — while the step reported success,
 * because fillQuestions cannot fail. Ana found it on Edgar Aponte by eye, twice.
 *
 * Two failure modes, and the second is the dangerous one:
 *
 *   MISS      pattern matches no question  → the answer is never entered (a blank)
 *   COLLISION pattern matches >1 question  → the answer may be entered on the
 *             WRONG disclosure. On a legal form that is far worse than a blank,
 *             which is why loosening these patterns needs this check.
 *
 * QUESTIONS below is the real wording of SureLC's Questions tab, cross-checked
 * against the AMERICO_ROLLUPS labels in the backoffice
 * (server/services/surelc/clearMiscWarnings.ts) and Ana's 2026-08-19 screenshot
 * of Q4–Q11.
 *
 * Run: node scripts/verify-question-patterns.mjs
 */

import { readFileSync } from "node:fs";

const QUESTIONS = {
  q1_felony: "Have you ever been convicted of any Felony, Misdemeanor, or been on probation?",
  q2_investigated: "Are you currently being investigated, have any pending indictments, or civil judgments?",
  q3_alleged_fraud: "Have you ever been alleged to have engaged in any fraud?",
  q4_proven_fraud: "Have you ever been found to have engaged in any fraud?",
  q5_terminated: "Has any insurance or financial services company, or broker-dealer terminated your contract or appointment or permitted you to resign for reason other than lack of sales?",
  q6_denied_appointment: "Have you ever had an appointment with any insurance company terminated for cause or been denied an appointment?",
  q7_chargeback: "Does any insurer, insured, or other person claim any commission chargeback or other indebtedness from you as a result of any insurance transactions or business?",
  q8_surety_eo: "Has any lawsuit or claim ever been made against your surety company, or errors and omissions insurer, arising out of your sales or practices, or, have you been refused surety bonding or E&O coverage?",
  q9_license_denied: "Have you ever had an insurance or securities license denied, suspended, cancelled or revoked?",
  q10_regulatory_body: "Has any state or federal regulatory body found you to have been a cause of an investment OR insurance-related business having its authorization to do business denied, suspended, revoked, or restricted?",
  q11_attorney_license: "Has any state or federal regulatory agency revoked or suspended your license as an attorney, accountant, or federal contractor?",
  q12_false_statement: "Have you ever made a false statement or omission or been dishonest?",
  q13_interruptions: "Have you had any interruptions in licensing?",
  q14_complaint: "Has any regulator filed a complaint against you, fined, sanctioned, censured or penalized you?",
  q15_bankruptcy: "Have you ever filed a bankruptcy petition or declared bankruptcy?",
  q16_liens: "Do you have any judgments, garnishments, or liens?",
  q17_bank: "Are you connected in any way with a bank, savings and loan, or other financial institution?",
  q18_alias: "Have you used any other names or aliases?",
  q19_irs: "Do you have unresolved matters pending with the Internal Revenue Service?",
};

/** Slugs whose pattern must resolve to exactly one question, and which one. */
const EXPECTED = {
  // The three that regressed — the reason this script exists.
  wasFiredRegulations: "q5_terminated",
  wasFiredOfFraud: "q5_terminated",
  wasFiredStatutes: "q5_terminated",
  suretyRefused: "q8_surety_eo",
  eoRefused: "q8_surety_eo",
  secNonInsuranceLicense: "q11_attorney_license",
  // Known-good ones, pinned so a future edit cannot silently break them.
  provenFraud: "q4_proven_fraud",
  allegedOfFraud: "q3_alleged_fraud",
  deniedAppointment: "q6_denied_appointment",
  oweToInsurance: "q7_chargeback",
  secLicense: "q9_license_denied",
  firmSecLicense: "q10_regulatory_body",
  interruptions: "q13_interruptions",
  hasLiens: "q16_liens",
  alias: "q18_alias",
  relatedToFinance: "q17_bank",
  revenueServiceMatters: "q19_irs",
};

// Pull the live map straight out of the source so the check cannot drift from it.
const src = readFileSync(new URL("../src/admin/fillProfile.ts", import.meta.url), "utf8");
const body = src.match(/const getSlugQuestionPattern[\s\S]*?\n\s*\}\n/);
if (!body) {
  console.error("FAIL: could not locate getSlugQuestionPattern in fillProfile.ts");
  process.exit(1);
}
const patterns = {};
for (const m of body[0].matchAll(/^\s{4}(\w+):\s*"((?:[^"\\]|\\.)*)",/gm)) {
  patterns[m[1]] = m[2].replace(/\\\\/g, "\\");
}

let failures = 0;
for (const [slug, expectedQ] of Object.entries(EXPECTED)) {
  const raw = patterns[slug];
  if (!raw) {
    console.error(`FAIL ${slug}: no pattern defined`);
    failures++;
    continue;
  }
  let re;
  try {
    re = new RegExp(raw, "i");
  } catch (err) {
    console.error(`FAIL ${slug}: invalid regex /${raw}/ — ${err.message}`);
    failures++;
    continue;
  }
  const hits = Object.entries(QUESTIONS)
    .filter(([, text]) => re.test(text))
    .map(([key]) => key);

  if (hits.length === 0) {
    console.error(`MISS ${slug}: /${raw}/ matches NO question (would be left blank)`);
    failures++;
  } else if (hits.length > 1) {
    console.error(`COLLISION ${slug}: /${raw}/ matches ${hits.length} — ${hits.join(", ")}`);
    failures++;
  } else if (hits[0] !== expectedQ) {
    console.error(`WRONG ${slug}: /${raw}/ matches ${hits[0]}, expected ${expectedQ}`);
    failures++;
  } else {
    console.log(`ok   ${slug} → ${hits[0]}`);
  }
}

console.log(
  failures === 0
    ? `\nPASS — ${Object.keys(EXPECTED).length} slugs each match exactly one intended question.`
    : `\nFAIL — ${failures} problem(s).`,
);
process.exit(failures === 0 ? 0 : 1);
