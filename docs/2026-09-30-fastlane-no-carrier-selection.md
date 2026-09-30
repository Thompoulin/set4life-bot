# 2026-09-30 — Fastlane with no carriers stops at the Carriers step

**Reported by:** Ana, 2026-09-30. Jermaine Watkins (producer 3024058): Phase A failed four times
in two hours with *"Fastlane SUBMIT button not found on preview (visible CTAs: search | ADD ALL |
ADD | … | REMOVE ALL | CANCEL | PREVIOUS | NEXT)"*.
**Approved:** GD (CTO), 2026-09-30.
**Backoffice half:** `set4life-backoffice/docs/2026-09-30-surelc-no-carrier-selection.md`. That
change stops the backoffice sending an empty selection at all; this one is the safety net.

## Cause

Not a SureLC change. The backoffice sent `contracting.carriers = []` because the rep had not
completed Request Carrier Contracts; all 10 rows were `not_started`, and those are never
contracted.

`runFastlaneOneProducerManyCarriers` logged `no carriers in agent selection — adding NOTHING
(refusing ADD ALL)` and snapshotted `fastlane-04-carriers-no-selection`, which was correct. Then it
carried on through States / Products / Preview. NEXT cannot leave the Carriers step with an empty
cart, so every later step was still the Carriers step. The run ended in the SUBMIT-not-found
branch, whose CTA list is the Carriers step's own buttons.

Reps looping on it that day:
- Alfred Nickson Jr: 166 events since 2026-08-21.
- Jairo Cabrera Rojas: 17 since 2026-09-27.
- Jermaine Watkins: 4.

## Fix

`src/admin/fastlane.ts`: the empty-selection branch returns `noCarrierSelectionResult()` straight
after its snapshot:

> ok:false — "No carriers selected for this rep — nothing to submit. The rep has not completed
> Request Carrier Contracts yet; Fastlane was not walked past the Carriers step."

It still never clicks ADD ALL. The existing "wanted N, added 0" early return is unchanged.

## Test

`npx tsx src/admin/fastlane.noSelection.test.ts`. Set `CHROMIUM_PATH` if the cached Chromium build
differs from Playwright's.

Fixtures are in `test/fixtures/fastlane-no-selection-2026-09-30/`. They are the run's two
snapshots, trimmed to `<bga-wizard>`, with the producer anonymised. They show that the page the
old code called "preview" is `<bga-step-carriers>`, with "No selected items", REMOVE ALL disabled
and no SUBMIT anywhere.

## Trap

A SUBMIT-not-found whose CTA list is `ADD ALL | ADD …` is an empty cart, not a moved button. Look
for `no carriers in agent selection` in the same job before chasing SureLC's DOM.
