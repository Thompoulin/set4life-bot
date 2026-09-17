import { contractingFromFastlane } from "../src/admin/fastlaneResult.js"
import type { TabResult } from "../src/tabs/helpers.js"

// What botRunner puts in phases.admin_setup.contracting for each Fastlane
// outcome. The backoffice (activationPipeline → summarizePhaseAContracting)
// reads this; an old backoffice only reads submitted/failed, so those two
// must stay truthful on their own.
type Want = {
  submitted: string[]
  failed: number
  skipped?: boolean
  added?: string[]
  notFound?: string[]
}
const UHL_SKIP: TabResult = {
  ok: true,
  skipped: true,
  skipReason: "Fastlane does not offer: UHL — needs manual/alternate contracting",
  reason: "Skipped Fastlane — carrier(s) not available in BGA Fastlane grid: UHL",
  details: { added: [], notFound: ["UHL"] },
}
const cases: Array<[string, TabResult, Want]> = [
  [
    "UHL-only run (Felipe/Adolfo/Dayana/Evelyn, 2026-09-16) — nothing filed",
    UHL_SKIP,
    { submitted: [], failed: 0, skipped: true, added: [], notFound: ["UHL"] },
  ],
  [
    "real submit with confirmation (Leidy) — names what was added",
    { ok: true, details: { added: ["Corebridge", "Americo"], notFound: [] } },
    { submitted: ["all-via-fastlane"], failed: 0, added: ["Corebridge", "Americo"], notFound: [] },
  ],
  [
    "partial: two added, UHL not offered — still a submit",
    {
      ok: true,
      reason: "Submitted but no explicit confirmation marker matched; check evidence screenshots",
      details: { added: ["Foresters", "SBLI"], notFound: ["UHL"] },
    },
    { submitted: ["all-via-fastlane"], failed: 0, added: ["Foresters", "SBLI"], notFound: ["UHL"] },
  ],
  [
    "ok but no carrier added (empty selection) — not a submit",
    { ok: true, details: { added: [], notFound: [] } },
    { submitted: [], failed: 0, added: [], notFound: [] },
  ],
  [
    "failure keeps the (fastlane) row the fallback trigger reads",
    { ok: false, reason: 'Producer SELECT button not found for "JONES, SYDNE".' },
    { submitted: [], failed: 1 },
  ],
  [
    "ok with no details (a return this change did not touch) — unchanged",
    { ok: true },
    { submitted: ["all-via-fastlane"], failed: 0 },
  ],
]

let fail = 0
for (const [note, input, want] of cases) {
  const got = contractingFromFastlane(input)
  const problems: string[] = []
  if (JSON.stringify(got.submitted) !== JSON.stringify(want.submitted))
    problems.push(`submitted=${JSON.stringify(got.submitted)}`)
  if (got.failed.length !== want.failed) problems.push(`failed=${got.failed.length}`)
  if ((got.skipped ?? false) !== (want.skipped ?? false)) problems.push(`skipped=${got.skipped}`)
  if (JSON.stringify(got.added) !== JSON.stringify(want.added)) problems.push(`added=${JSON.stringify(got.added)}`)
  if (JSON.stringify(got.notFound) !== JSON.stringify(want.notFound))
    problems.push(`notFound=${JSON.stringify(got.notFound)}`)
  if (!input.ok && got.failed[0]?.carrier !== "(fastlane)") problems.push("failed carrier is not (fastlane)")
  if (input.skipped && got.skipReason !== input.skipReason) problems.push(`skipReason=${got.skipReason}`)
  // The old backoffice summary said "all carriers submitted" exactly when
  // submitted === ["all-via-fastlane"]. It must never see that for a run
  // that added nothing.
  if (got.added?.length === 0 && got.submitted.includes("all-via-fastlane"))
    problems.push("added nothing but still claims all-via-fastlane")
  const ok = problems.length === 0
  if (!ok) fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${note}${ok ? "" : `  → ${problems.join("; ")}`}`)
}
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
