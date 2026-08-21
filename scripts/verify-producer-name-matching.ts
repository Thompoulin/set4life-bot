import { searchTermsForProducer, cardMatchesProducer } from "../src/admin/fastlane.js"

// Real pairs from prod: our display name vs the card text SureLC renders.
const cases: Array<[string, string, boolean, string]> = [
  ["LANDINO VALBUENA, PAULA CAROLINA", "LANDINO, PAULA", true, "Paula — the case that started this"],
  ["LEON TEMPONI, EVENCIO", "LEON, EVENCIO", true, "Evencio"],
  ["APONTE, EDGAR", "APONTE HERNANDEZ, EDGAR", true, "Edgar — worked before, must keep working"],
  ["AVENDAÑO, LUZ", "AVENDANO, LUZ", true, "ñ folded"],
  ["MUÑOZ, TATIANA", "MUNOZ, TATIANA VANESSA", true, "ñ + extra middle name"],
  ["MOLERO DE MONTERO, KARELYS", "MOLERO, KARELYS", true, "three-token surname"],
  ["CASTRO, JAVIER", "CASTRO DIAZ, JAVIER ANTONIO", true, "the 2026-05-28 case"],
  ["JONES, SYDNE", "JONES, SYDNE", true, "exact"],
  // Must NOT match — a different person who shares a surname.
  ["LANDINO VALBUENA, PAULA CAROLINA", "LANDINO, ROBERTO", false, "same surname, different person"],
  ["RIOS, CARLOS", "SANCHEZ, MARIA", false, "unrelated"],
]

let fail = 0
for (const [disp, card, want, note] of cases) {
  const got = cardMatchesProducer(card, disp)
  const ok = got === want
  if (!ok) fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${disp}  vs  ${card}  → ${got} (want ${want})  — ${note}`)
}
console.log("\nsearch terms:")
for (const d of ["LANDINO VALBUENA, PAULA CAROLINA", "AVENDAÑO, LUZ", "JONES, SYDNE"]) {
  console.log(" ", d, "→", JSON.stringify(searchTermsForProducer(d)))
}
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
