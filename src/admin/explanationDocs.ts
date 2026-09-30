/**
 * Shared pieces of the "explanation" flow — the screen SureLC shows for a
 * background question answered Yes, where the rep's letter and supporting
 * documents are attached. Used by BOTH the BGA admin Questions tab
 * (admin/fillProfile.ts fillQuestionsV2) and the rep-review wizard modal
 * (rep/review.ts fillCarrierQuestionExplanations).
 *
 * Yolonda Burgess, producer 16811799, 2026-09-30 — see
 * docs/2026-09-30-explanations-not-carried-to-surelc.md. Four things went
 * wrong in one run, and each has a piece here:
 *
 *   1. SureLC's Occurrence Date is now an <sb-date-input>. Its text input
 *      has placeholder "Current Date" on the BGA route, so the old
 *      `input[placeholder="Occurrence Date"]` wait burned 12s and the date
 *      was never set.                                → OCCURRENCE_DATE_SELECTOR
 *   2. CREATE was read the instant the upload was accepted, while SureLC
 *      was still linking the attachment. It was disabled then and enabled
 *      a moment later (the evidence snapshot shows it enabled), so a good
 *      explanation was logged "NOT saved".          → waitForEnabledButton
 *   3. After that false failure the form was left open with unsaved data;
 *      the next question's goBack hit "Unsaved information" and every later
 *      Yes — her bankruptcy — was logged "disappeared from DOM" and skipped.
 *                                                   → discardExplanationForm
 *   4. Only documents[0] was ever uploaded.         → dedupeExplanationDocuments
 */
import type { Locator, Page } from "playwright"
import type pino from "pino"

/**
 * The occurrence-date text input, newest shape first. Both SureLC surfaces
 * (BGA route, AR-review modal) render <sb-date-input> with an inner
 * `input[data-cy="date-input"]`; the placeholder differs ("Current Date" on
 * the BGA route, "Occurrence Date" in the AR-review modal), so the
 * placeholder is only the fallback for the pre-2026-09 markup.
 */
export const OCCURRENCE_DATE_SELECTOR =
  'sb-date-input input[data-cy="date-input"], input[placeholder="Occurrence Date"]'

/** Same, for a scope where any date-ish placeholder is acceptable (modal). */
export const OCCURRENCE_DATE_SELECTOR_LOOSE =
  'sb-date-input input[data-cy="date-input"], input[placeholder*="Occurrence" i], input[placeholder*="date" i]'

export interface ExplanationDocument {
  url: string
  fileName?: string
  slot?: string
  contentType?: string
  kind?: string
}

/** A letter of explanation we generated from the rep's typed answers. */
export function isExplanationLetter(d: ExplanationDocument): boolean {
  if (d.kind === "explanation_letter") return true
  return /letter_of_explanation/i.test(d.fileName || d.url || "")
}

/**
 * Every document we hold for one question, each once.
 *
 * - The same URL twice is one document.
 * - Letters of explanation are regenerated each time the rep edits the
 *   questionnaire, so one question can carry two letters with the same file
 *   name (Yolonda's wasBankrupt had `letter_of_explanation__wasBankrupt.txt`
 *   twice, different URLs). Only the LAST one is kept — it is the rep's
 *   latest wording — and it keeps its place at the front, because the
 *   written statement is what the category-shaped route expects first.
 * - Uploads (court papers, discharges) are never merged by name: two scans
 *   called "discharge.pdf" can be two different pages.
 */
export function dedupeExplanationDocuments<T extends ExplanationDocument>(docs: T[] | undefined): T[] {
  const list = (docs || []).filter((d) => d && typeof d.url === "string" && d.url.length > 0)
  const seenUrl = new Set<string>()
  const byUrl = list.filter((d) => {
    if (seenUrl.has(d.url)) return false
    seenUrl.add(d.url)
    return true
  })
  const lastLetterByName = new Map<string, T>()
  for (const d of byUrl) {
    if (isExplanationLetter(d)) lastLetterByName.set((d.fileName || d.url).toLowerCase(), d)
  }
  const letters: T[] = []
  const emitted = new Set<string>()
  for (const d of byUrl) {
    if (!isExplanationLetter(d)) continue
    const key = (d.fileName || d.url).toLowerCase()
    if (emitted.has(key)) continue
    emitted.add(key)
    letters.push(lastLetterByName.get(key)!)
  }
  const uploads = byUrl.filter((d) => !isExplanationLetter(d))
  return [...letters, ...uploads]
}

/** "07/02/2019" vs "7/2/2019" vs "07-02-2019" — same date? */
export function sameDateValue(actual: string | null | undefined, wanted: string): boolean {
  const norm = (s: string) => {
    const m = (s || "").trim().match(/^(\d{1,2})\D(\d{1,2})\D(\d{4})$/)
    return m ? `${+m[1]}/${+m[2]}/${m[3]}` : (s || "").trim()
  }
  return !!actual && norm(actual) === norm(wanted)
}

/**
 * Fill the occurrence date and confirm it stuck. `fill()` drives the
 * Angular control properly (a raw `.value =` is dropped by the form), Tab
 * commits it. The input is also a mat-autocomplete trigger that offers
 * "Current Date" — if committing swapped our value for a suggestion, write
 * it once more and blur without a key press. Returns whether the field
 * reads our date afterwards; the caller decides whether that is fatal (the
 * BGA route does not require the date, the AR-review modal does).
 */
export async function setOccurrenceDate(
  scope: Page | Locator,
  page: Page,
  mmddyyyy: string,
  logger: pino.Logger,
  slug: string,
  selector: string = OCCURRENCE_DATE_SELECTOR,
): Promise<boolean> {
  const inp = scope.locator(selector).first()
  if (!(await inp.count().catch(() => 0))) {
    logger.warn({ slug }, "[Explanation] no occurrence-date input on this screen")
    return false
  }
  try {
    await inp.fill(mmddyyyy, { timeout: 5_000 })
    await inp.press("Tab").catch(() => undefined)
    await page.waitForTimeout(300)
    let value = await inp.inputValue().catch(() => "")
    if (!sameDateValue(value, mmddyyyy)) {
      await inp.fill(mmddyyyy, { timeout: 5_000 })
      await inp.evaluate((el) => (el as HTMLInputElement).blur()).catch(() => undefined)
      await page.waitForTimeout(300)
      value = await inp.inputValue().catch(() => "")
    }
    const ok = sameDateValue(value, mmddyyyy)
    if (ok) logger.info({ slug, value }, "[Explanation] occurrence date set")
    else logger.warn({ slug, wanted: mmddyyyy, value }, "[Explanation] occurrence date did NOT stick")
    return ok
  } catch (err: any) {
    logger.warn({ slug, err: err?.message }, "[Explanation] occurrence date fill threw")
    return false
  }
}

/**
 * Wait for a visible button with exactly this text to become enabled.
 * SureLC keeps CREATE / SAVE disabled until the form is complete, and an
 * upload is linked asynchronously — reading the button once, right after
 * the upload, is the race that lost Yolonda's alias explanation.
 */
export async function waitForEnabledButton(
  scope: Page | Locator,
  page: Page,
  text: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  return (await waitForAnyEnabledButton(scope, page, [text], timeoutMs)) !== null
}

/**
 * Like waitForEnabledButton, for a modal whose commit button is named
 * differently per step (DONE on Carrier Questions, CREATE on the
 * Questionnaire). Returns the text of the first one found enabled.
 */
export async function waitForAnyEnabledButton(
  scope: Page | Locator,
  page: Page,
  texts: string[],
  timeoutMs = 20_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  do {
    const found = await scope
      .locator("button")
      .evaluateAll(
        (bs, wanted) => {
          for (const w of wanted as string[]) {
            const b = bs.find(
              (x) =>
                (x.textContent || "").trim().toUpperCase() === w &&
                (x as HTMLElement).offsetWidth > 0 &&
                !(x as HTMLButtonElement).disabled &&
                !x.classList.contains("mat-mdc-button-disabled"),
            )
            if (b) return w
          }
          return null
        },
        texts.map((t) => t.toUpperCase()),
      )
      .catch(() => null)
    if (found) return found
    await page.waitForTimeout(500)
  } while (Date.now() < deadline)
  return null
}

/**
 * Leave an explanation form without saving: CANCEL, then YES on SureLC's
 * "Unsaved information" confirm. Anything left open here blocks the next
 * question — goBack lands on the confirm, not the list.
 */
export async function discardExplanationForm(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const cb = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "CANCEL" && (b as HTMLElement).offsetWidth > 0,
      )
      if (!cb) return
      ;["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((t) =>
        cb.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0 })),
      )
    })
    .catch(() => undefined)
  await page.waitForTimeout(800)
  await confirmUnsavedDiscard(page)
}

/** Click YES on an "Unsaved information" confirm if one is up. */
export async function confirmUnsavedDiscard(page: Page): Promise<boolean> {
  const clicked = await page
    .evaluate(() => {
      const yes = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "YES" && (b as HTMLElement).offsetWidth > 0,
      )
      if (yes) (yes as HTMLElement).click()
      return !!yes
    })
    .catch(() => false)
  if (clicked) await page.waitForTimeout(800)
  return clicked
}

/**
 * Which of a modal's SELECT buttons are real documents to attach.
 *
 * The AR-review modal has a "SELECT FROM UPLOADED DOCUMENTS" button that
 * OPENS a picker; it is not a document. Its surrounding text is the drop
 * zone ("You may drag and drop your documents…"). On 2026-09-30 it was the
 * only match, so it was "picked", nothing was attached, and the run counted
 * the card as attached. Only a per-document SELECT counts.
 */
export function documentChoiceIndices(buttonTexts: string[], entryTexts: string[]): number[] {
  const out: number[] = []
  for (let i = 0; i < buttonTexts.length; i++) {
    const b = (buttonTexts[i] || "").replace(/\s+/g, " ").trim()
    const e = (entryTexts[i] || "").replace(/\s+/g, " ").trim()
    if (/SELECT FROM/i.test(b)) continue
    if (!/(^|\s)SELECT$/i.test(b)) continue
    if (/drag and drop|use the tools below/i.test(e)) continue
    out.push(i)
  }
  return out
}

/**
 * Download one of our documents to a local file SureLC will accept. Text
 * letters are wrapped as PDF (SureLC 500s on text/plain).
 */
export async function downloadForUpload(
  page: Page,
  doc: ExplanationDocument,
  slug: string,
  logger: pino.Logger,
): Promise<string | null> {
  const path = await import("node:path")
  const fs = await import("node:fs/promises")
  const os = await import("node:os")
  const res = await fetch(doc.url)
  if (!res.ok) {
    logger.warn({ slug, status: res.status, fileName: doc.fileName }, "[Explanation] document download failed")
    return null
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const safeName = (doc.fileName || path.basename(new URL(doc.url).pathname) || "doc").replace(/[^\w.() -]+/g, "_")
  const localPath = path.join(os.tmpdir(), `surelc-v2-${slug}-${Date.now()}-${safeName}`)
  await fs.writeFile(localPath, buf)
  return asUploadableFile(page, localPath, doc.contentType, logger)
}

/**
 * SureLC's attachment service refuses a plain-text upload: POST
 * /surecrm/attachments/{producer}/upload answers 500 and the page shows
 * "Could not upload file: <name>". Our questionnaire writes the rep's
 * letter of explanation as text/plain, so EVERY letter we have ever held
 * was rejected at the door. Verified on Carlos Murray Sr's probation
 * letter 2026-09-11: the same words as .txt → 500, as .pdf → 200 and
 * CREATE goes live.
 *
 * Chromium is already here, so wrap the text in a one-page PDF rather
 * than taking a dependency. Anything that is not text passes straight
 * through untouched.
 */
export async function asUploadableFile(
  page: Page,
  localPath: string,
  contentType: string | undefined,
  logger: pino.Logger,
): Promise<string> {
  const isText = /^text\//i.test(contentType || "") || /\.(txt|text)$/i.test(localPath)
  if (!isText) return localPath
  try {
    const fs = await import("node:fs/promises")
    const body = await fs.readFile(localPath, "utf8")
    const escaped = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    const pdfPath = localPath.replace(/\.(txt|text)$/i, "") + ".pdf"
    const scratch = await page.context().newPage()
    try {
      await scratch.setContent(
        `<html><body style="font:12pt/1.5 Helvetica,Arial,sans-serif;margin:48px">` +
          `<pre style="white-space:pre-wrap;font:inherit">${escaped}</pre></body></html>`,
        { waitUntil: "load" },
      )
      await scratch.pdf({ path: pdfPath, format: "Letter", printBackground: true })
    } finally {
      await scratch.close().catch(() => undefined)
    }
    logger.info({ from: localPath, to: pdfPath }, "[Questions/v2] wrapped a text letter as PDF — SureLC rejects text/plain")
    return pdfPath
  } catch (err: any) {
    logger.warn({ err: err?.message }, "[Questions/v2] could not wrap text as PDF — uploading as-is")
    return localPath
  }
}

/** The tab reason when a Yes question we hold documents for is still unsatisfied. */
export function unsavedExplanationsReason(unsaved: Array<{ slug: string; why: string }>): string {
  const list = unsaved.map((u) => `${u.slug} (${u.why})`).join(", ")
  return (
    `explanation not saved in SureLC for ${list} — we hold the rep's documents; ` +
    `attach them on the producer's Questions tab (ADD EXPLANATION), then re-run contracting`
  )
}
