/**
 * Fastlane may only SELECT a producer card it has positively identified.
 * Run with: `npx tsx src/admin/producerIdentity.test.ts`
 *
 * Carlos Tovar (agent 539, producer 11383068 — SureLC names him "Carlos
 * Alvarez"), 2026-10-01/02: three runs searched "TOVAR", got the card
 * "NUNEZ-TOVAR, CARLOS EDUARDO, SR." (producer 5861981, another agent of
 * ours), passed the substring "exact" test, failed open on the producer-id
 * guard (a card has no id on it), and filed 22 requests on the wrong man.
 * The bot's own post-submit read found 0 new requests on 11383068 and still
 * said "submitted".
 * docs/2026-10-02-fastlane-wrong-producer-carlos-tovar.md
 *
 * Fixture: test/fixtures/fastlane-wrong-producer-2026-10-02/, the two cards
 * from the bot's own snapshot of that search, names and emails anonymised
 * ("NUNEZ-TOVAR, CARLOS EDUARDO, SR." → "ROE-DOE, JUAN EDUARDO, SR.", so our
 * agent "TOVAR, CARLOS" becomes "DOE, JUAN" and the substring trap survives).
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  FASTLANE_SUBMIT_UNVERIFIED,
  FILED_ON_WRONG_PRODUCER_SUSPECTED,
  PRODUCER_AMBIGUOUS,
  PRODUCER_IDENTITY_UNVERIFIED,
  PRODUCER_NOT_FOUND,
  type ExpectedProducerIdentity,
  type FastlaneCardInfo,
  decideProducerCard,
  emailsInText,
  identityFromRecord,
  identitySearchTerms,
  nameTokensMatch,
  verifyNewRequests,
} from "./producerIdentity.js"
import { cardMatchesProducer } from "./fastlane.js"
import { contractingFromFastlane } from "./fastlaneResult.js"
import { tryAcquireFilingLock } from "../filingLock.js"

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}
const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url))

// ── The real card markup ───────────────────────────────────────────
const html = readFileSync(
  root("test/fixtures/fastlane-wrong-producer-2026-10-02/producer-cards-after-search.html"),
  "utf8",
)
const cardHtml = html.match(/<bga-producer-card[\s\S]*?<\/bga-producer-card>/g) ?? []
const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
const cards: FastlaneCardInfo[] = cardHtml.map((h) => ({
  name: strip(h.match(/class="producer__name">([^<]*)</)?.[1] ?? ""),
  emails: emailsInText(strip(h)),
}))
check("fixture: two cards rendered for the surname search", cards.length, 2)
check("fixture: card names", cards.map((c) => c.name), [
  "ROE CALDERA, JUAN RAMON",
  "ROE-DOE, JUAN EDUARDO, SR.",
])
check("fixture: each card prints exactly one email", cards.map((c) => c.emails), [
  ["juanroe77@example.com"],
  ["juanroedoe@agent.example.com"],
])
// Why the 6518498 guard could never fire: there is no id to read.
check(
  "fixture: no producer id / NPN / producers link anywhere on a card",
  cardHtml.some((h) => /producers?\/\d{4,}|data-producer-id|\b\d{6,}\b/.test(h)),
  false,
)

// ── Name matching is whole-token ───────────────────────────────────
check(
  "the old substring test matched the wrong man (documents the bug)",
  "ROE-DOE, JUAN EDUARDO, SR.".includes("DOE, JUAN"),
  true,
)
check("DOE vs ROE-DOE: different surname", nameTokensMatch("ROE-DOE, JUAN EDUARDO, SR.", "DOE, JUAN"), false)
check("TOVAR vs NUNEZ-TOVAR: different surname", nameTokensMatch("NUNEZ-TOVAR, CARLOS EDUARDO, SR.", "TOVAR, CARLOS"), false)
check("cardMatchesProducer is whole-token too", cardMatchesProducer("NUNEZ-TOVAR, CARLOS EDUARDO, SR.", "TOVAR, CARLOS"), false)
check("compound surname, ours shorter", nameTokensMatch("LANDINO VALBUENA, PAULA CAROLINA", "LANDINO, PAULA"), true)
check("compound surname, ours longer", nameTokensMatch("APONTE, EDGAR", "APONTE HERNANDEZ, EDGAR"), true)
check("accents folded", nameTokensMatch("MUNOZ, TATIANA VANESSA", "MUÑOZ, TATIANA"), true)
check("suffix after the second comma ignored", nameTokensMatch("MURRAY, CARLOS ALEXANDER, SR", "MURRAY, CARLOS"), true)
check("same surname, different given name", nameTokensMatch("LANDINO, ROBERTO", "LANDINO, PAULA"), false)
check("MURPHY is not MURRAY", nameTokensMatch("MURPHY, CARLOS", "MURRAY, CARLOS"), false)
for (const [card, ours] of [
  ["LANDINO, PAULA", "LANDINO VALBUENA, PAULA CAROLINA"],
  ["LEON, EVENCIO", "LEON TEMPONI, EVENCIO"],
  ["AVENDANO, LUZ", "AVENDAÑO, LUZ"],
  ["MOLERO, KARELYS", "MOLERO DE MONTERO, KARELYS"],
  ["CASTRO DIAZ, JAVIER ANTONIO", "CASTRO, JAVIER"],
]) {
  check(`still matches ${card} for ${ours}`, cardMatchesProducer(card, ours), true)
}

// ── Picking the card ───────────────────────────────────────────────
const tovar: ExpectedProducerIdentity = {
  // What SureLC holds for the intended producer: a different name and email
  // from either card on screen.
  producerId: "11383068",
  emails: ["juanalvarez@agent.example.com"],
  displayName: "ALVAREZ, JUAN",
  npn: "22175721",
}
const d1 = decideProducerCard(cards, tovar)
check("the Tovar search: neither card is him → refuse", d1.ok, false)
check("…as not found (no email, no name match)", !d1.ok && d1.code, PRODUCER_NOT_FOUND)

const sameNameOtherEmail: ExpectedProducerIdentity = { ...tovar, displayName: "ROE-DOE, JUAN" }
const d2 = decideProducerCard(cards, sameNameOtherEmail)
check("name matches a card but its email is not ours → unverified", !d2.ok && d2.code, PRODUCER_IDENTITY_UNVERIFIED)
check("…and the reason says nothing was filed", !d2.ok && /Nothing was filed/.test(d2.reason), true)

const nunezTovar: ExpectedProducerIdentity = {
  producerId: "5861981",
  emails: ["juanroedoe@agent.example.com"],
  displayName: "ROE-DOE, JUAN EDUARDO",
  npn: null,
}
check("the right producer is found by email + name", decideProducerCard(cards, nunezTovar), { ok: true, index: 1 })
check(
  "email matches but SureLC's name disagrees → unverified",
  (() => {
    const d = decideProducerCard(cards, { ...nunezTovar, displayName: "SMITH, JUAN" })
    return !d.ok && d.code
  })(),
  PRODUCER_IDENTITY_UNVERIFIED,
)
check(
  "email compare is case-insensitive",
  decideProducerCard(cards, { ...nunezTovar, emails: ["JuanRoeDoe@Agent.Example.com"] }).ok,
  true,
)
check("no identity at all → unverified", (() => {
  const d = decideProducerCard(cards, null)
  return !d.ok && d.code
})(), PRODUCER_IDENTITY_UNVERIFIED)
check("no cards rendered → not found", (() => {
  const d = decideProducerCard([], nunezTovar)
  return !d.ok && d.code
})(), PRODUCER_NOT_FOUND)

// Murray, 2026-09: father and son, same name. The email picks the father.
const murrays: FastlaneCardInfo[] = [
  { name: "MURRAY, CARLOS ALEXANDER, II", emails: ["son@agent.example.com"] },
  { name: "MURRAY, CARLOS ALEXANDER, SR", emails: ["father@agent.example.com"] },
]
check(
  "Murray father picked by email even though both names match",
  decideProducerCard(murrays, {
    producerId: "16679568",
    emails: ["father@agent.example.com"],
    displayName: "MURRAY, CARLOS ALEXANDER",
    npn: null,
  }),
  { ok: true, index: 1 },
)
check(
  "two cards with the same email → ambiguous, refuse",
  (() => {
    const d = decideProducerCard(
      [murrays[0], { ...murrays[1], emails: ["son@agent.example.com"] }],
      { producerId: "12026084", emails: ["son@agent.example.com"], displayName: "MURRAY, CARLOS", npn: null },
    )
    return !d.ok && d.code
  })(),
  PRODUCER_AMBIGUOUS,
)

// ── Reading the producer record ────────────────────────────────────
const rec = {
  id: 11383068,
  npn: "22175721",
  email: "JuanAlvarez@agent.example.com",
  effectiveEmail: "juanalvarez@agent.example.com",
  firstName: "Juan",
  lastName: "Alvarez",
}
const r1 = identityFromRecord("11383068", rec, "22175721")
check("record with matching NPN → identity", r1.ok && r1.identity, {
  producerId: "11383068",
  emails: ["juanalvarez@agent.example.com"],
  displayName: "Alvarez, Juan",
  npn: "22175721",
})
check("NPN on the record differs from ours → unverified", (() => {
  const r = identityFromRecord("11383068", { ...rec, npn: "99999999" }, "22175721")
  return !r.ok && r.code
})(), PRODUCER_IDENTITY_UNVERIFIED)
check("we have an NPN but the record has none → unverified", identityFromRecord("11383068", { ...rec, npn: null }, "22175721").ok, false)
check("no NPN from the backoffice → email still anchors the id", identityFromRecord("11383068", rec, undefined).ok, true)
check("record without email → unverified", identityFromRecord("11383068", { ...rec, email: null, effectiveEmail: null }, "22175721").ok, false)
check("record for a different id → unverified", identityFromRecord("11383068", { ...rec, id: 5861981 }, "22175721").ok, false)
check("record unreadable → unverified", identityFromRecord("11383068", null, "22175721").ok, false)

check(
  "search tries SureLC's own surname first, then ours, then the email",
  identitySearchTerms(r1.ok ? r1.identity : null, "TOVAR, CARLOS"),
  ["Alvarez", "TOVAR", "juanalvarez@agent.example.com"],
)

// ── After SUBMIT ───────────────────────────────────────────────────
const before = [122269426, 122269437, 122269448]
check(
  "Tovar run: 7 carriers added, 0 new on the intended producer → wrong producer suspected",
  (() => {
    const v = verifyNewRequests({ producerId: "11383068", addedCount: 7, beforeIds: before, afterIds: before })
    return !v.ok && v.code
  })(),
  FILED_ON_WRONG_PRODUCER_SUSPECTED,
)
check(
  "fewer new requests than carriers → still suspected",
  (() => {
    const v = verifyNewRequests({ producerId: "1", addedCount: 3, beforeIds: before, afterIds: [...before, 5, 6] })
    return !v.ok && v.code
  })(),
  FILED_ON_WRONG_PRODUCER_SUSPECTED,
)
check(
  "every carrier landed → ok with the new ids",
  verifyNewRequests({ producerId: "1", addedCount: 2, beforeIds: before, afterIds: [...before, 9, 8] }),
  { ok: true, newRequestIds: [8, 9] },
)
check(
  "list unreadable after submit → unverified, never success",
  (() => {
    const v = verifyNewRequests({ producerId: "1", addedCount: 2, beforeIds: before, afterIds: null })
    return !v.ok && v.code
  })(),
  FASTLANE_SUBMIT_UNVERIFIED,
)

// ── What the backoffice receives ───────────────────────────────────
check(
  "a refusal is never 'submitted' and carries its code",
  contractingFromFastlane({
    ok: false,
    code: FILED_ON_WRONG_PRODUCER_SUSPECTED,
    reason: "[filed_on_wrong_producer_suspected] …",
    details: { added: ["Americo"], notFound: [], newRequestIds: [] },
  }),
  {
    submitted: [],
    failed: [{ carrier: "(fastlane)", reason: "[filed_on_wrong_producer_suspected] …" }],
    added: ["Americo"],
    notFound: [],
    errorCode: FILED_ON_WRONG_PRODUCER_SUSPECTED,
    newRequestIds: [],
  },
)

// ── One filing run per agent / producer ────────────────────────────
const a = tryAcquireFilingLock(["agent:539", "producer:11383068"], "job-1747")
check("first admin_setup for agent 539 takes the lock", a.ok, true)
const b = tryAcquireFilingLock(["agent:539", "producer:11383068"], "job-1753")
check("a second one 6 minutes later is refused", b.ok, false)
check("…naming who holds it", !b.ok && b.holder.jobId, "job-1747")
check("same producer from another endpoint is refused", tryAcquireFilingLock(["producer:11383068"], "x").ok, false)
const c = tryAcquireFilingLock(["agent:379", "producer:5861981"], "job-379")
check("a different agent is not blocked", c.ok, true)
if (a.ok) a.release()
if (c.ok) c.release()
const d = tryAcquireFilingLock(["agent:539"], "job-later")
check("after release the agent can run again", d.ok, true)
if (d.ok) d.release()

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
