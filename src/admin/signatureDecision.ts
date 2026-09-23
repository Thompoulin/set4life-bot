/**
 * What to do with the SureLC Signature tab — pure, so it can be locked by
 * a test without a browser. Run the test with:
 * `npx tsx src/admin/signatureDecision.test.ts`
 *
 * WHY THIS EXISTS (2026-09-23, Vicente Maestre, found by Ana)
 *
 * SureLC keeps ONE producer profile per NPN, shared across agencies. A rep
 * who was on SureLC before us arrives with their own dated signature
 * already on that profile. The old rule was "a dated signature is on file
 * → alreadyDone", so ours was never uploaded, and Phase B signed every
 * carrier contract with the foreign signature. The carrier then compared
 * the contracts against our Signature Authorization form, saw two
 * different signatures, and bounced the contract back.
 *
 * Vicente: producer added 2026-08-28 21:28, signature tab skipped
 * ("datedAuthorization") at 21:31, three carriers signed at 21:39, ours
 * first uploaded 2026-08-30. About 70 of 193 signed agents went the same
 * way.
 *
 * So a signature on file only counts as done when the backoffice tells us
 * it is ours (`existingIsOurs` — it records the formId of our own push).
 * Anything else is overwritten through the API before anyone signs.
 *
 * NEVER REMOVE FIRST. The API overwrite replaces the image in place. The
 * REMOVE-then-reupload path left producers with no signature at all when
 * the re-upload failed (2026-05-27, 14 producers; Maria Lugo 2026-05-28).
 * When the overwrite fails we keep whatever is there and refuse to sign.
 */

export type SignatureAction =
  /** Our signature is already on file — nothing to do. */
  | "skip_ours"
  /** A signature is on file but not known to be ours — overwrite via API. */
  | "api_overwrite"
  /** Nothing (or a half-finished upload) on file — push via API. */
  | "api_push_fresh"
  /** A push is needed but impossible (no image) — keep what is there, fail. */
  | "fail_keep_existing"

export interface SignatureDecisionInput {
  /** SureLC shows a signature on file (dated Signature Authorization card, or a green tab). */
  hasSignatureOnFile: boolean
  forceReupload: boolean
  /**
   * The backoffice's word that the signature on file is the one we pushed.
   * Undefined (an older backoffice) is treated as "not known to be ours",
   * which costs one redundant overwrite per run and nothing else.
   */
  existingIsOurs?: boolean
  /** The bare drawn PNG — pushSignatureViaApi cannot run without it. */
  hasImageUrl: boolean
}

export function decideSignatureAction(i: SignatureDecisionInput): SignatureAction {
  if (!i.hasSignatureOnFile) {
    return i.hasImageUrl ? "api_push_fresh" : "fail_keep_existing"
  }
  if (i.existingIsOurs === true && !i.forceReupload) return "skip_ours"
  // No image to push: leave the profile alone, whatever forceReupload says.
  // There used to be a REMOVE-then-upload path here for forceReupload, but
  // the upload after it needs this same image, so it could only ever end
  // with the producer holding NO signature — the 2026-05-27 incident.
  return i.hasImageUrl ? "api_overwrite" : "fail_keep_existing"
}

/**
 * Prefix on every failure that leaves a signature on file we could not
 * verify as ours. The backoffice matches on it to block Phase B and to
 * name the problem in the Bot-Blocked table.
 */
export const SIGNATURE_NOT_OURS = "SIGNATURE_NOT_OURS"

/**
 * Phase B gate for a combined A+B run. When this run's Signature tab did
 * not end with our signature on file, signing carrier contracts would sign
 * them under whatever is there — so Phase B does not run. Returns the
 * reason, or null when signing may go ahead. A run that did not touch the
 * Signature tab (Phase B alone) returns null; the main app gates that one
 * itself before it calls the bot.
 */
export function signatureBlocksSigning(
  profile: Record<string, { ok: boolean; alreadyDone?: boolean; reason?: string }> | undefined,
): string | null {
  const sig = profile?.signature
  if (!sig || sig.ok) return null
  return sig.reason || `${SIGNATURE_NOT_OURS}: signature tab did not complete`
}
