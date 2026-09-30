/**
 * An empty carrier selection stops at the Carriers step with a reason that
 * says whose move it is — never "SUBMIT button not found".
 * Run with: `npx tsx src/admin/fastlane.noSelection.test.ts`
 *
 * Jermaine Watkins (producer 3024058), 2026-09-30, plus Jairo Cabrera Rojas
 * and Alfred Nickson Jr: none had picked carriers, the backoffice sent an
 * empty list, the bot (rightly) refused ADD ALL, then walked on anyway. NEXT
 * cannot leave the Carriers step with an empty cart, so after its residual
 * NEXT clicks the page it called "preview" was still the Carriers step, and
 * the run failed with "Fastlane SUBMIT button not found on preview (visible
 * CTAs: search | ADD ALL | ADD | … | REMOVE ALL | CANCEL | PREVIOUS | NEXT)".
 * That read as a SureLC page change. It was not one.
 * docs/2026-09-30-fastlane-no-carrier-selection.md
 *
 * Fixtures: test/fixtures/fastlane-no-selection-2026-09-30/, the bot's own
 * snapshots from that run, trimmed to <bga-wizard>, producer anonymised. The
 * browser half needs a local Chromium (or CHROMIUM_PATH=<chrome binary>).
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { NO_CARRIER_SELECTION_REASON, noCarrierSelectionResult } from "./fastlane.js"

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}
const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url))
const fixture = (name: string) =>
  readFileSync(root(`test/fixtures/fastlane-no-selection-2026-09-30/${name}`), "utf8")

// ── The result ──────────────────────────────────────────────────────────
const r = noCarrierSelectionResult()
check("fails the contracting step (nothing was submitted)", r.ok, false)
check("says the rep has not picked carriers", /No carriers selected/.test(r.reason || ""), true)
check("names the onboarding step to finish", /Request Carrier Contracts/.test(r.reason || ""), true)
check("never blames a missing SUBMIT button", /SUBMIT button/i.test(r.reason || ""), false)
check("reports nothing added", (r.details as any)?.added, [])

// ── The driver returns it before walking on ─────────────────────────────
const src = readFileSync(root("src/admin/fastlane.ts"), "utf8")
const branch = src.indexOf("if (selected.length === 0) {")
const elseAt = src.indexOf("} else {", branch)
const block = src.slice(branch, elseAt)
check("the empty-selection branch exists", branch > -1, true)
check("it snapshots, then returns", block.indexOf('snapshot(ctx, "fastlane-04-carriers-no-selection")') > -1 && block.indexOf("return noCarrierSelectionResult()") > block.indexOf("fastlane-04-carriers-no-selection"), true)
check("it returns before the States step", src.indexOf("return noCarrierSelectionResult()") < src.indexOf('"fastlane-05-step3-states"'), true)
check("still never ADD ALL on an empty selection", /ADD ALL/.test(block.replace(/\/\/.*$/gm, "").replace(/"\[Fastlane\][^"]*"/g, "")), false)
check("the constant is the reason", r.reason, NO_CARRIER_SELECTION_REASON)

// ── The page, as SureLC drew it ─────────────────────────────────────────
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
    browser = await chromium.launch(
      process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    )
  } catch (err: any) {
    console.log(`skip  fixture checks — no local Chromium (${String(err?.message).split("\n")[0]})`)
    return
  }
  try {
    const page = await browser.newPage()
    for (const name of ["carriers-step-no-selection.html", "carriers-step-empty-cart-labelled-preview.html"]) {
      await page.setContent(`<html><body>${fixture(name)}</body></html>`)
      const buttons = (await page.locator("button").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim())
      check(`${name}: still the Carriers step component`, await page.locator("bga-step-carriers").count(), 1)
      check(`${name}: nothing in the cart`, await page.getByText("No selected items").count() > 0, true)
      check(`${name}: REMOVE ALL disabled (empty cart)`, await page.locator("button", { hasText: "REMOVE ALL" }).isDisabled(), true)
      check(`${name}: no SUBMIT anywhere — it was never the preview`, buttons.some((b) => /SUBMIT/i.test(b)), false)
    }
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
