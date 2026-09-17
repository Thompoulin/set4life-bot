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
  if (!r.ok) {
    return {
      submitted: [],
      failed: [{ carrier: "(fastlane)", reason: r.reason || "Fastlane failed" }],
      ...lists,
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
  }
}
