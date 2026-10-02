# 2026-10-02: Fastlane selected the wrong producer (Carlos Tovar → Carlos Nunez-Tovar)

The backoffice write-up (timeline, the 22 request ids to withdraw, the originals to keep, cleanup steps) is in
`set4life-backoffice/docs/2026-10-02-fastlane-wrong-producer-carlos-tovar.md`.

## What happened

- Agent 539, Carlos Tovar, is producer **11383068**. SureLC names him "Carlos Alvarez". His NPN is 22175721.
- Three Fastlane runs each searched "TOVAR" and got one card: **"NUNEZ-TOVAR, CARLOS EDUARDO, SR."**, which is producer **5861981**, our agent 379. They clicked SELECT on it and filed. Two of the runs were concurrent admin_setup jobs (10-01 17:47 and 17:53 UTC); the third ran 10-02 01:12.
- Together they filed **22 requests on the wrong producer and 0 on 11383068**. Every run reported success.

## Why every gate fell through

1. `searchTermsForProducer` searched the first token of our last name.
2. The "exact" strategy was `cardText.includes(displayName)`, a substring test. "TOVAR, CARLOS" is inside "NUNEZ-TOVAR, CARLOS EDUARDO, SR.".
3. The producer-id guard from `6518498` (after Carlos Murray) **failed open**. It looked for an id in the card's attributes and innerHTML, found none, logged "could not read a producer id off the card — proceeding on the name match alone", and clicked. That happened 20 of 20 times. **The id cannot be read because it is not there.** Here is the card the bot clicked, from its own `fastlane-02b-after-search.html` (anonymised copy in `test/fixtures/fastlane-wrong-producer-2026-10-02/`):

   ```html
   <bga-producer-card action="SELECT" class="viewport__item">
     <div class="producer"><div class="producer__info">
       <div class="producer__name">NUNEZ-TOVAR, CARLOS EDUARDO, SR.</div>
       <ul><li>… Soliciting for: Set 4 Life agency llc (…)</li>
           <li>… S4L LOA</li>
           <li>… <his S4L mailbox>@agent.set4lifeagency.com</li></ul>
     </div><button> SELECT </button></div>
   </bga-producer-card>
   ```

   The card has the name, "Soliciting for", the hierarchy and the **email**. It has no producer id, no NPN, no link and no data attribute. The search box was not shown to accept an NPN or id. That could not be probed without a live session, so the search simply *tries* the email as a term, and the decision never depends on the search mode.
4. Post-submit, the bot found 0 new requests on 11383068 and returned `ok: true`.
5. Nothing serialised two `admin_setup` runs for one agent.

## Fix

### Producer identity (`src/admin/producerIdentity.ts`, wired in `botRunner.ts` + `fastlane.ts`)

1. Before Fastlane opens, `botRunner` captures the SPA Bearer token and reads **`GET /surecrm/producer/{producerId}`**. This is read-only, the same call `/create-appointment-requests` makes. `identityFromRecord` requires the following, or it returns `producer_identity_unverified`:
   - the record is for that id;
   - when the backoffice sent `producer.npn`, the record's NPN equals it;
   - the record has an email and a name.
2. `botRunner` also snapshots the producer's appointment-request ids (`listAppointmentRequestIds`). If that read fails, Fastlane is not opened (`fastlane_submit_unverified`).
3. `fastlane.ts` searches with `identitySearchTerms`: SureLC's own surname first, then ours, then the email. Each term is judged with `decideProducerCard`. A card is ours only if:
   - it prints an email equal to the record's `email`/`effectiveEmail`;
   - it is the **only** card that does; if two do, the result is `producer_ambiguous`;
   - its name agrees with the record's name by **whole token** (`nameTokensMatch`: first surname token equal, first given-name token equal; a hyphen does not split, so `NUNEZ-TOVAR` ≠ `TOVAR`).

   A name match without the email gives `producer_identity_unverified`. No match at all gives `producer_not_found`. The "only one card rendered → take it" fallback and the page-level `:has-text()` SELECT fallbacks are gone.
4. After SELECT and NEXT, the Carriers step's `<bga-producer-name>` must agree with the chosen card. If it does not, the run stops before any ADD.
5. `cardMatchesProducer` is now whole-token too (it delegates to `nameTokensMatch`). `scripts/verify-producer-name-matching.ts` still passes.

### Post-submit verification

After a real submit, `botRunner` re-reads the producer's requests, polling up to 4 times 5s apart.

- If fewer new ids appear than carriers added, the result is **`filed_on_wrong_producer_suspected`**: `ok: false`, `admin_setup_partial`, and no post-dedup, transfer flip or LOR.
- If the list cannot be read, the result is `fastlane_submit_unverified`.
- On success, `contracting.newRequestIds` carries the new ids.

### One filing run at a time (`src/filingLock.ts`)

The app is a single process (`CMD node dist/server.js`, one `web` container), so an in-process map is a full lock.

- `/run-activation` with `admin_setup` takes `agent:<openId>` and `producer:<id>`. `/create-appointment-requests` takes `producer:<id>`.
- A held key gets **HTTP 409** `{ code: "agent_run_in_progress" }`. The request is refused, not queued.
- `/health` lists the held locks.

### Codes reach the backoffice as

- `contracting.errorCode`;
- a `[code]` prefix on `contracting.failed[0].reason`, with `submitted: []`.

The backoffice treats every one of them as a failure. It never advances a status, it alerts on `filed_on_wrong_producer_suspected`, and the self-heal loop never retries them.

## Tests

`npx tsx src/admin/producerIdentity.test.ts` runs 49 checks against the real card markup (anonymised fixture), the Tovar search, the Murray father/son split by email, NPN/record checks, the post-submit verdicts, `contractingFromFastlane` and the lock.

## Traps

- Never add back an id check that proceeds when the id is missing, a name-only selection, or "the only card". The email is the identifier on a card. Its link to the producer id comes from SureLC's own record, read by id.
- If a producer legitimately has no email in SureLC, Fastlane refuses. Fix the email (the backoffice's `producerEmailGuard` already enforces the S4L mailbox); do not relax the check.
- The lock is in-process. Scaling the bot past one process needs a shared lock.
