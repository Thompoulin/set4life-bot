/**
 * Standalone regression check for the bankruptcy-question split
 * (Johnson 2026-06-18). Run with: `npx tsx src/rep/review.bankruptcy.test.ts`
 *
 * No test runner is installed in this repo (build = tsc), so this is a
 * self-contained assertion script that exits non-zero on failure. It
 * exercises the REAL pickYnForLabel / disclosureKeyForLabel against the
 * exact SureLC question wording.
 *
 * The bug: a coarse /bankrupt/i pattern + single q7_bankruptcy flag answered
 * ALL of Q15/Q15a/Q15b/Q15c "Yes" for anyone with a personal bankruptcy —
 * a false statement on the firm (Q15b) and pending (Q15c) questions.
 */
import { pickYnForLabel, disclosureKeyForLabel } from "./review";
const Q15 = "15 Have you personally or any insurance or securities brokerage firm with whom you have been associated filed a bankruptcy petition or declared bankruptcy?";
const Q15a = "15a Have you personally filed a bankruptcy petition or declared bankruptcy?";
const Q15b = "15b Has any insurance or securities brokerage firm with whom you have been associated filed a bankruptcy petition or been declared bankrupt either during your association or within five years after termination of such association?";
const Q15c = "15c Is the bankruptcy pending?";
let failures = 0;
function expect(label, disc, want, note) {
    const got = pickYnForLabel(label, disc);
    const ok = got === want;
    if (!ok)
        failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  want=${want} got=${got}  ${note}`);
}
// --- New granular payload: personal Ch.7, discharged, no firm (Johnson) ---
const granular = {
    q7_bankruptcy_personal: true,
    q7_firm_bankruptcy: false,
    q7_bankruptcy_pending: false,
};
expect(Q15, granular, "Y", "Q15 parent (personally or firm) — personal filed");
expect(Q15a, granular, "Y", "Q15a personally filed");
expect(Q15b, granular, "N", "Q15b FIRM bankruptcy — must NOT inherit personal (the bug)");
expect(Q15c, granular, "N", "Q15c PENDING — discharged is not pending (the bug)");
// --- Legacy payload: only the coarse q7_bankruptcy flag set ---
const legacy = { q7_bankruptcy: true };
expect(Q15, legacy, "Y", "legacy: Q15 still Yes via back-compat");
expect(Q15a, legacy, "Y", "legacy: Q15a still Yes via back-compat");
expect(Q15b, legacy, "N", "legacy: Q15b firm defaults No (no firm flag)");
expect(Q15c, legacy, "N", "legacy: Q15c pending defaults No");
// --- Genuine firm bankruptcy + pending (someone who really has them) ---
const real = {
    q7_bankruptcy_personal: true,
    q7_firm_bankruptcy: true,
    q7_bankruptcy_pending: true,
};
expect(Q15b, real, "Y", "real firm bankruptcy answers Yes");
expect(Q15c, real, "Y", "real pending bankruptcy answers Yes");
// --- Clean rep: no bankruptcy at all ---
expect(Q15, {}, "N", "clean rep Q15 No");
expect(Q15b, {}, "N", "clean rep Q15b No");
expect(Q15c, {}, "N", "clean rep Q15c No");
// --- Audit helper lockstep ---
const key15b = disclosureKeyForLabel(Q15b, granular);
if (key15b !== null) {
    failures++;
    console.log(`FAIL  disclosureKeyForLabel(Q15b, no-firm) want=null got=${key15b}`);
}
else {
    console.log(`PASS  disclosureKeyForLabel(Q15b, no-firm)=null (no false-Yes audit)`);
}
const key15bReal = disclosureKeyForLabel(Q15b, real);
if (key15bReal !== "q7_firm_bankruptcy") {
    failures++;
    console.log(`FAIL  disclosureKeyForLabel(Q15b, firm=true) want=q7_firm_bankruptcy got=${key15bReal}`);
}
else {
    console.log(`PASS  disclosureKeyForLabel(Q15b, firm=true)=q7_firm_bankruptcy`);
}
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
