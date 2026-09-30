# 2026-09-30 — Explanations not carried from our questionnaire to SureLC

**Reported by:** Ana (contracting), 2026-09-30: Yolonda Burgess (producer 16811799) stuck at
Producer stage on every carrier, "Documents - Explanations not carried forward". She had given us
everything.

**Code:** `src/admin/explanationDocs.ts` (new, shared), `src/admin/fillProfile.ts`
(`fillQuestionsV2`), `src/rep/review.ts` (`fillCarrierQuestionExplanations`), `src/server.ts` (zod).
**Test:** `npx tsx src/admin/explanationDocs.test.ts` (set `CHROMIUM_PATH` if the cached Chromium
build differs from Playwright's). Fixtures: `test/fixtures/explanations-2026-09-30/`, taken from the
bot's own evidence snapshots of that run, cut down to the explanation components with the rep's
details removed.

## What we held

`questionnaire_responses.surelc_answers`:

- `alias`: Yes, occurrence date, typed letter (reason / explanation / action), plus one upload.
- `wasBankrupt`: Yes, occurrence date, typed letter twice (regenerated after an edit, same file
  name, different URLs), discharge PDF, post-filing certificate PDF.

## What happened (Phase A, BGA admin Questions tab, 08:24 UTC)

1. **alias**: the bot opened ADD EXPLANATION and waited for `input[placeholder="Occurrence Date"]`.
   **That selector no longer exists.** SureLC's Occurrence field is now `<sb-date-input>`, and on
   this route its text input is `input[data-cy="date-input"]` with placeholder **"Current Date"**.
   The wait burned its full 12 s and the date was never written. (The BGA route does not require
   the date. CREATE enables without it, which is why this alone was not fatal.)
2. The letter was wrapped as a PDF and uploaded, and SureLC accepted it. **CREATE was read 6 ms
   later, while SureLC was still linking the attachment.** It was disabled at that moment, so the
   bot logged `explanation NOT saved (CREATE still disabled)`. The evidence snapshot taken seconds
   later shows CREATE **enabled**. It was a race, not a real refusal.
3. The NOT-saved branch **did not cancel the form** (only the upload-failure branch did). The next
   question's `goBack()` landed on SureLC's *"Unsaved information — are you sure you want to stop
   editing?"* confirm. The list never came back, so every later Yes question was logged
   `question disappeared from DOM` and skipped. **The bankruptcy explanation was never attempted.**
4. The tab still returned `ok: true` (`Filled {saved:0, yesSet:1}`), so Phase A reported "All 7
   tabs OK" and Fastlane submitted 7 carriers with an unexplained bankruptcy.
5. Separately, even on a good run only `documents[0]` was ever uploaded. The court papers never
   went.

## What happened (Phase B, AR-review Questionnaire modal)

Every carrier failed on *"!15a. Have you personally filed a bankruptcy petition… An explanation is
required"*. The modal (captured in the fixture) is:

```
outer dialog  <sb-step-questionnaire-edit-explanation-dialog>
  "Required documents are missing."   Occurrence* (sb-date-input)
  [UPLOAD NEW DOCUMENT] [CREATE EXPLANATION DOCUMENT] [SELECT FROM UPLOADED DOCUMENTS]
  [CANCEL] [CREATE]
CREATE EXPLANATION DOCUMENT opens a SECOND dialog on top:
  Reason* / Explanation* / Action* textareas, Occurrence*   [CANCEL] [SAVE]
```

- The bot looked for the editor's textarea in the **first** dialog (`.first()`), so it never found
  it (`descFilled:false`).
- Its document pick treated **SELECT FROM UPLOADED DOCUMENTS** as a document. That button opens a
  picker, and its only surrounding text is the drop zone ("You may drag and drop…"). It was
  "picked", nothing was attached, and the run logged `attached:true`.
- CREATE could not enable, and the commit click timed out.

## Fix

- **Date:** `OCCURRENCE_DATE_SELECTOR` = `sb-date-input input[data-cy="date-input"]`, falling back
  to the old placeholder. It is set with `fill()` + Tab and read back (`setOccurrenceDate`). If the
  autocomplete swapped in a suggestion, it is re-filled and blurred without a key press.
- **CREATE is waited for** (up to 20 s) instead of read once. Success is judged by the question's
  own card afterwards: no more "An explanation is required".
- **A failed save always discards the form** (CANCEL + YES on "Unsaved information"), and the
  goBack at the top of each question also dismisses a leftover confirm. One bad card can no longer
  take the rest of the questionnaire down with it.
- **Every document is uploaded**, deduped by `dedupeExplanationDocuments`: the same URL counts once;
  of several letters with one file name only the latest is kept; uploads are never merged by name.
  On the conviction (category) shape, an unslotted extra document is skipped rather than filed
  under a category it does not belong to.
- **The tab fails when a Yes question we hold documents for is still unexplained.** It returns
  `ok:false` with the reason "explanation not saved in SureLC for <slug> (<why>) — we hold the
  rep's documents; attach them on the producer's Questions tab…". `questions` is already a
  contracting-blocking tab in `botRunner.ts`, so Fastlane is **not** submitted. The run ends
  `admin_setup_partial` with `contracting: (gate)=profile incomplete: questions (…)`. The backoffice
  already handles that as a blocked run: owner alert "SureLC bot blocked at admin_setup_partial",
  `bot_run failed — needs admin` event carrying the reason, `sureLcLastError` stamped, classified as
  "Producer profile incomplete at the questions gate". No new channel.
- **Phase B modal:**
  - Date via the same selector.
  - The editor is driven in the **top** dialog, and only when we hold the rep's Reason, Explanation
    and Action. The editor requires all three, and we never pad them with the same paragraph.
  - Otherwise our own document (`docUrl`) is uploaded straight onto the modal's file input.
  - The per-document SELECT pick ignores the picker button and the drop zone
    (`documentChoiceIndices`).
  - DONE/CREATE is waited for.
- **zod** (`server.ts`): documents now keep `contentType` and `kind`. Both were always sent and
  silently stripped. `carrierQuestionExplanations[]` accepts optional `reason` and `action`.

## Traps

- **An upload is linked asynchronously.** Any check of CREATE, or of "Required documents are
  missing", right after `setInputFiles` can read the pre-upload state. Wait for the button.
- **Never leave an explanation route dirty.** SureLC guards it with an "Unsaved information"
  confirm that swallows the next navigation. The symptom is "question disappeared from DOM" for
  every later question, which looks like a selector problem and is not one.
- **Two dialogs.** In the AR-review modal, `mat-dialog-container:visible` `.first()` is the outer
  modal and `.last()` is the editor. Scope accordingly.
- **"SELECT FROM UPLOADED DOCUMENTS" is not a document.** It opens a picker. Only a per-document
  `SELECT` is one.
- The date placeholder differs by surface ("Current Date" on BGA, "Occurrence Date" in AR-review),
  so never key on the placeholder alone.
- The rep's own filing is uploaded as given. Yolonda filed a bankruptcy discharge under the alias
  question too, and it will be attached there. That is her filing, not ours to re-sort.

## Follow-ups (not in this change)

- **Backoffice:** add `reason` and `action` (from the letter's `explanation` object) to the
  `carrierQuestionExplanations` entries built in `server/services/surelc/activationPipeline.ts`.
  Until then Phase B attaches the document rather than typing the editor.
- **Re-runs write to SureLC and need approval.** Yolonda (16811799) needs Phase A (questions) and
  then Phase B. Andres Castro (6872903, collections/arrears disclosure) has not run Phase A yet.
