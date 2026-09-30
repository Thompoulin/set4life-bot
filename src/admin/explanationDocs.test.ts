/**
 * Explanations reach SureLC: date widget, every document, no dirty form left
 * behind, and a failed save fails the tab.
 * Run with: `npx tsx src/admin/explanationDocs.test.ts`
 *
 * Yolonda Burgess, producer 16811799, 2026-09-30 — see
 * docs/2026-09-30-explanations-not-carried-to-surelc.md. The HTML fixtures
 * are the bot's own evidence snapshots from that run, trimmed to the
 * explanation components with the rep's details removed:
 *   test/fixtures/explanations-2026-09-30/bga-question-explanation-route.html
 *   test/fixtures/explanations-2026-09-30/ar-review-explanation-dialogs.html
 *
 * Needs a local Chromium (npx playwright install chromium, or CHROMIUM_PATH=
 * <chrome binary>) for the fixture half; the pure checks run regardless.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import pino from "pino"
import {
  OCCURRENCE_DATE_SELECTOR,
  OCCURRENCE_DATE_SELECTOR_LOOSE,
  dedupeExplanationDocuments,
  documentChoiceIndices,
  sameDateValue,
  setOccurrenceDate,
  unsavedExplanationsReason,
  waitForAnyEnabledButton,
} from "./explanationDocs.js"

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}
const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url))
const fixture = (name: string) => readFileSync(root(`test/fixtures/explanations-2026-09-30/${name}`), "utf8")
const logger = pino({ level: "silent" })

// ── Every document, each once ────────────────────────────────────────────
// Shape of the rep's wasBankrupt answer (URLs anonymised): the letter was
// regenerated after an edit, so it arrives twice under one file name.
const S3 = "https://example.invalid/compliance-docs/rep"
const wasBankrupt = [
  { url: `${S3}/questionnaire-aaa-letter_of_explanation__wasBankrupt.txt`, kind: "explanation_letter", fileName: "letter_of_explanation__wasBankrupt.txt", contentType: "text/plain" },
  { url: `${S3}/contract-bbb-surelc_wasBankrupt_BK_Discharge.pdf`, kind: "upload", fileName: "BK Discharge.pdf", contentType: "application/pdf" },
  { url: `${S3}/questionnaire-ccc-letter_of_explanation__wasBankrupt.txt`, kind: "explanation_letter", fileName: "letter_of_explanation__wasBankrupt.txt", contentType: "text/plain" },
  { url: `${S3}/contract-ddd-surelc_wasBankrupt_BK_Post_cert.pdf`, kind: "upload", fileName: "BK Post cert.pdf", contentType: "application/pdf" },
]
const deduped = dedupeExplanationDocuments(wasBankrupt)
check("bankruptcy: letter + discharge + post-cert, letter once", deduped.map((d) => d.fileName), [
  "letter_of_explanation__wasBankrupt.txt",
  "BK Discharge.pdf",
  "BK Post cert.pdf",
])
check("the LATEST letter is the one kept", deduped[0].url.includes("questionnaire-ccc-"), true)
check("the same URL twice is one document", dedupeExplanationDocuments([wasBankrupt[1], wasBankrupt[1]]).length, 1)
check(
  "two uploads with the same name are both kept (could be two pages)",
  dedupeExplanationDocuments([
    { url: `${S3}/a.pdf`, fileName: "scan.pdf", kind: "upload" },
    { url: `${S3}/b.pdf`, fileName: "scan.pdf", kind: "upload" },
  ]).length,
  2,
)
check(
  "a letter is recognised by name when kind was stripped",
  dedupeExplanationDocuments([
    { url: `${S3}/x.pdf`, fileName: "court.pdf" },
    { url: `${S3}/l.txt`, fileName: "letter_of_explanation__alias.txt" },
  ]).map((d) => d.fileName),
  ["letter_of_explanation__alias.txt", "court.pdf"],
)
check("no documents → none", dedupeExplanationDocuments(undefined), [])

// ── Date comparison ─────────────────────────────────────────────────────
check("07/02/2019 == 7/2/2019", sameDateValue("7/2/2019", "07/02/2019"), true)
check("a suggestion is not our date", sameDateValue("Current Date", "07/02/2019"), false)
check("empty is not our date", sameDateValue("", "07/02/2019"), false)

// ── Document pick never takes the picker button / drop zone ─────────────
check(
  "SELECT FROM UPLOADED DOCUMENTS over the drop zone is not a document",
  documentChoiceIndices(
    ["library_books SELECT FROM UPLOADED DOCUMENTS"],
    ["You may drag and drop your documents file(s) here or use the tools below."],
  ),
  [],
)
check(
  "per-document SELECT buttons are",
  documentChoiceIndices(
    ["SELECT FROM UPLOADED DOCUMENTS", "SELECT", "SELECT"],
    ["You may drag and drop…", "Letter — Question: felony", "Letter — Question: probation"],
  ),
  [1, 2],
)

// ── The tab reason names every question and says we hold the documents ──
const reason = unsavedExplanationsReason([
  { slug: "alias", why: "CREATE never enabled" },
  { slug: "wasBankrupt", why: "question not found on the Questions tab" },
])
check("reason names both slugs", /alias.*wasBankrupt/.test(reason), true)
check("reason says the documents are ours (not the rep's to supply)", /we hold the rep's documents/.test(reason), true)
check("reason does not trip the signature classifier", /signature/i.test(reason), false)

// ── Source guards on the two drivers ────────────────────────────────────
const fp = readFileSync(root("src/admin/fillProfile.ts"), "utf8")
check("BGA route no longer waits on the old placeholder alone", fp.includes(`waitForSelector('input[placeholder="Occurrence Date"]'`), false)
check("BGA route waits on the shared date selector", fp.includes("waitForSelector(OCCURRENCE_DATE_SELECTOR"), true)
check("date is set with fill (not a raw .value =)", fp.includes("inp.value = v"), false)
check("every document is uploaded", fp.includes("for (const d of docs)"), true)
check("CREATE is waited for, not read once", fp.includes('waitForEnabledButton(page, page, "CREATE", 20_000)'), true)
check("a failed save discards the form", /explanation NOT saved[\s\S]{0,600}discardExplanationForm\(page\)/.test(fp), true)
check("goBack dismisses a leftover Unsaved confirm", fp.includes("dismissed a leftover 'Unsaved information' confirm"), true)
check("unsaved explanations fail the tab", /unsaved\.length > 0\)[\s\S]{0,300}ok: false/.test(fp), true)
const rv = readFileSync(root("src/rep/review.ts"), "utf8")
check("Phase B filters the document pick", rv.includes("documentChoiceIndices(buttonTexts, entryTexts)"), true)
check("Phase B fills the editor in the TOP dialog", rv.includes("const topDialog = () => page.locator(\"mat-dialog-container:visible\").last()"), true)
check("Phase B waits for its commit button", rv.includes('waitForAnyEnabledButton(outer, page, ["DONE", "CREATE"]'), true)

// ── Fixtures, in a real browser ─────────────────────────────────────────
async function fixtures() {
  let chromium: typeof import("playwright").chromium
  try {
    chromium = (await import("playwright")).chromium
  } catch {
    console.log("skip  fixture checks — playwright not importable")
    return
  }
  let browser
  try {
    // CHROMIUM_PATH lets a machine whose cached Chromium build differs
    // from this Playwright's point at the one it has.
    browser = await chromium.launch(
      process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    )
  } catch (err: any) {
    console.log(`skip  fixture checks — no local Chromium (${String(err?.message).split("\n")[0]})`)
    return
  }
  try {
    const page = await browser.newPage()

    // BGA admin route, as the bot left it on 2026-09-30.
    await page.setContent(`<html><body>${fixture("bga-question-explanation-route.html")}</body></html>`)
    check("BGA: the old placeholder selector finds nothing (the 12s timeout)", await page.locator('input[placeholder="Occurrence Date"]').count(), 0)
    check("BGA: the new selector finds the date input", await page.locator(OCCURRENCE_DATE_SELECTOR).count(), 1)
    check("BGA: the date is written and reads back", await setOccurrenceDate(page, page, "09/17/1992", logger, "alias"), true)
    check("BGA: CREATE is enabled in the snapshot taken after the 'NOT saved' log", await waitForAnyEnabledButton(page, page, ["CREATE"], 500), "CREATE")

    // AR-review modal + editor.
    await page.setContent(`<html><body>${fixture("ar-review-explanation-dialogs.html")}</body></html>`)
    const dialogs = page.locator("mat-dialog-container")
    const outer = dialogs.first()
    const editor = dialogs.last()
    check("AR: two dialogs (modal + Create Explanation Document editor)", await dialogs.count(), 2)
    check("AR: no textarea in the FIRST dialog (where the old code looked)", await outer.locator("textarea").count(), 0)
    check("AR: Reason / Explanation / Action live in the TOP dialog", await editor.locator('textarea[placeholder="Reason"], textarea[placeholder="Explanation"], textarea[placeholder="Action"]').count(), 3)
    check("AR: the modal's date input is found", await outer.locator(OCCURRENCE_DATE_SELECTOR_LOOSE).count() > 0, true)
    const sel = outer.locator("button").filter({ hasText: /SELECT/ })
    const bt: string[] = []
    const et: string[] = []
    for (let i = 0; i < (await sel.count()); i++) {
      bt.push(((await sel.nth(i).textContent()) || "").trim())
      et.push(await sel.nth(i).evaluate((b) => (b.parentElement?.parentElement?.textContent || "").trim()))
    }
    check("AR: the only SELECT button is the picker, not a document", documentChoiceIndices(bt, et), [])
    check("AR: CREATE is disabled while documents are missing", await waitForAnyEnabledButton(outer, page, ["DONE", "CREATE"], 500), null)
    check("AR: the editor's SAVE is disabled until its fields are filled", await waitForAnyEnabledButton(editor, page, ["SAVE"], 500), null)
  } finally {
    await browser.close()
  }
}

await fixtures()
if (failures > 0) {
  console.log(`\n${failures} FAILED`)
  process.exit(1)
}
console.log("\nall passed")
