/**
 * Turn a Fastlane TabResult into the `contracting` block the backoffice reads.
 *
 * botRunner used to map every `ok` result to `submitted: ["all-via-fastlane"]`,
 * including the `ok + skipped` one Fastlane returns when the only carriers
 * left are not offered in its grid (UHL, contracted by email). The backoffice
 * turned that marker into "Fastlane: all carriers submitted in one wizard
 * pass" — four of Ana's five Copilot re-runs on 2026-09-16 said so, and none
 * had filed anything.
 *
 * Kept backward compatible with a backoffice that has not been redeployed:
 *   - a real submit still sends ["all-via-fastlane"] (old summary unchanged)
 *     plus the `added` / `notFound` names;
 *   - a skip, or a run that added nothing, sends `submitted: []`, which the
 *     old summary renders as "0 submitted" — true — and, with `failed` empty,
 *     neither fails the step nor triggers its direct-POST fallback.
 */
import type { TabResult } from "../tabs/helpers.js"

export interface FastlaneContracting {
  submitted: string[]
  failed: Array<{ carrier: string; reason: string }>
  /** Fastlane returned ok but filed nothing it was asked to (e.g. UHL-only). */
  skipped?: boolean
  skipReason?: string
  /** Carrier names Fastlane actually added on the Carriers step. */
  added?: string[]
  /** Carrier names it looked for and could not add. */
  notFound?: string[]
  /**
   * Machine code when Fastlane refused or the submit could not be confirmed
   * on the intended producer (`producer_identity_unverified`,
   * `filed_on_wrong_producer_suspected`, …). Absent on success.
   */
  errorCode?: string
  /** Appointment-request ids that appeared on the intended producer after SUBMIT. */
  newRequestIds?: number[]
}

function names(v: unknown): string[] | undefined {
  return Array.isArray(v)
    ? v.filter((n): n is string => typeof n === "string")
    : undefined
}

export function contractingFromFastlane(r: TabResult): FastlaneContracting {
  const added = names(r.details?.added)
  const notFound = names(r.details?.notFound)
  const lists = {
    ...(added ? { added } : {}),
    ...(notFound ? { notFound } : {}),
  }
  const newRequestIds = Array.isArray(r.details?.newRequestIds)
    ? (r.details!.newRequestIds as unknown[]).filter((n): n is number => typeof n === "number")
    : undefined
  if (!r.ok) {
    // A refusal or a suspected wrong-producer filing is never "submitted",
    // whatever was clicked: `submitted` stays empty and the code travels with
    // the failure so the backoffice can alert instead of advancing statuses.
    return {
      submitted: [],
      failed: [{ carrier: "(fastlane)", reason: r.reason || "Fastlane failed" }],
      ...lists,
      ...(r.code ? { errorCode: r.code } : {}),
      ...(newRequestIds ? { newRequestIds } : {}),
    }
  }
  if (r.skipped) {
    return {
      submitted: [],
      failed: [],
      skipped: true,
      skipReason: r.skipReason || r.reason,
      ...lists,
    }
  }
  return {
    submitted: added && added.length === 0 ? [] : ["all-via-fastlane"],
    failed: [],
    ...lists,
    ...(newRequestIds ? { newRequestIds } : {}),
  }
}
