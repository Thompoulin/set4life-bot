import { expandCarrierNames } from "../src/admin/fastlane.js"

// Every carrier name sitting in the unsubmitted backlog on 2026-08-21,
// plus the two that were already known to need aliases.
const cases: Array<[dbName: string, mustProduce: string]> = [
  ["National Life Group (NLG) (Independent)", "National Life Group"],
  ["Banner Life (Quility)", "Banner Life"],
  ["SBLI (Quility Term)", "SBLI"],
  ["Transamerica Life Ins Co (Brokerage)", "Transamerica Life Ins Co"],
  ["Foresters - Independent Order Of", "Foresters"],
  ["UHL", "United Home Life"],
  ["Mutual Of Omaha Ins Co", "Mutual of Omaha"],
]
let fail = 0
for (const [db, must] of cases) {
  const got = expandCarrierNames(db)
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  const ok = got.some((g) => norm(g) === norm(must))
  if (!ok) fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${db}\n        -> ${JSON.stringify(got)}  (want "${must}")`)
}
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
