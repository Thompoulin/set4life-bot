/**
 * Contracts are never signed under a signature that is not ours.
 * Run with: `npx tsx src/admin/signatureDecision.test.ts`
 *
 * No test runner in this repo (build = tsc), so this is a self-contained
 * assertion script that exits non-zero on failure — same shape as
 * src/rep/review.unreadableLabels.test.ts.
 *
 * The case: Vicente Maestre, 2026-09-23. SureLC's profile is shared across
 * agencies and his already carried his own dated signature. The Signature
 * tab saw it, returned alreadyDone, and Phase B signed three carriers under
 * it. The carrier compared those contracts with our Signature Authorization
 * and bounced them: two different signatures. See signatureDecision.ts.
 */
import { readFileSync } from "node:fs"
import {
  decideSignatureAction,
  signatureBlocksSigning,
  SIGNATURE_NOT_OURS,
} from "./signatureDecision.js"

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

// ── The bug itself ─────────────────────────────────────────────────────
check(
  "a signature on file that is not known to be ours is overwritten (Vicente)",
  decideSignatureAction({ hasSignatureOnFile: true, forceReupload: false, existingIsOurs: false, hasImageUrl: true }),
  "api_overwrite",
)
check(
  "an older backoffice that says nothing about ownership still gets an overwrite",
  decideSignatureAction({ hasSignatureOnFile: true, forceReupload: false, hasImageUrl: true }),
  "api_overwrite",
)

// ── Ours stays ours ────────────────────────────────────────────────────
check(
  "our own signature on file is left alone",
  decideSignatureAction({ hasSignatureOnFile: true, forceReupload: false, existingIsOurs: true, hasImageUrl: true }),
  "skip_ours",
)
check(
  "force re-pushes even ours",
  decideSignatureAction({ hasSignatureOnFile: true, forceReupload: true, existingIsOurs: true, hasImageUrl: true }),
  "api_overwrite",
)
check(
  "nothing on file → fresh push",
  decideSignatureAction({ hasSignatureOnFile: false, forceReupload: false, hasImageUrl: true }),
  "api_push_fresh",
)

// ── Never end with no signature ────────────────────────────────────────
// With no image a push is impossible. Whatever is on file stays — even
// under force, which used to REMOVE first and then fail the upload.
for (const forceReupload of [false, true]) {
  for (const existingIsOurs of [undefined, false, true]) {
    for (const hasSignatureOnFile of [false, true]) {
      const a = decideSignatureAction({ hasSignatureOnFile, forceReupload, existingIsOurs, hasImageUrl: false })
      check(
        `no image (onFile=${hasSignatureOnFile} force=${forceReupload} ours=${existingIsOurs}) never pushes`,
        a === "api_overwrite" || a === "api_push_fresh",
        false,
      )
    }
  }
}

// ── Phase B gate ───────────────────────────────────────────────────────
check("no Signature tab this run → no opinion", signatureBlocksSigning(undefined), null)
check("our signature confirmed → sign", signatureBlocksSigning({ signature: { ok: true, alreadyDone: true } }), null)
check("overwritten → sign", signatureBlocksSigning({ signature: { ok: true } }), null)
const held = signatureBlocksSigning({
  signature: { ok: false, reason: `${SIGNATURE_NOT_OURS}: API overwrite failed (x)` },
})
check("overwrite failed → signing held, reason names it", held?.startsWith(SIGNATURE_NOT_OURS), true)

// ── Source guards: the two ways back into the bug ──────────────────────
const fillProfile = readFileSync(new URL("./fillProfile.ts", import.meta.url), "utf8")
const fn = fillProfile.slice(
  fillProfile.indexOf("async function fillSignature("),
  fillProfile.indexOf("export async function pushSignatureViaApi("),
)
check("fillSignature never clicks REMOVE", /has-text\("REMOVE"\)|has-text\("Remove"\)/.test(fn), false)
check(
  "a green tab no longer returns alreadyDone by itself",
  /isTabGreen\([^)]*\)\)\s*\{\s*return\s*\{\s*ok:\s*true,\s*alreadyDone/.test(fn),
  false,
)
const runner = readFileSync(new URL("../botRunner.ts", import.meta.url), "utf8")
check("botRunner gates Phase B on the signature", runner.includes("signatureBlocksSigning(result.phases.admin_setup?.profile)"), true)
const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8")
check("server schema lets existingIsOurs through zod", /existingIsOurs:\s*z\.boolean\(\)\.optional\(\)/.test(server), true)

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log("\nall passed")
