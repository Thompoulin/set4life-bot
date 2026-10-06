/**
 * Fastlane page readers against the 2026-10-05 SureLC redesign.
 * Run with: `npx tsx src/admin/fastlaneUi.test.ts` (CHROMIUM_PATH=<chrome binary> if needed).
 *
 * landing.html and wizard-nav.html are trimmed from live pages (producer anonymised, no
 * producer data). carriers-step / preview-step / submit-dialog are REBUILT FROM THE JS BUNDLE:
 * reaching them needs a producer selected, which writes. docs/2026-10-05-fastlane-redesign.md
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  activeWizardStep,
  findOneProducerManyCarriersStart,
  readPreview,
  readSelectedCarrierNames,
  readSelectedCount,
  readSubmitDialog,
  visibleValidationText,
} from "./fastlaneUi.js"

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}
const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url))
const fixture = (name: string) => readFileSync(root(`test/fixtures/fastlane-redesign-2026-10-05/${name}`), "utf8")

// ── source guards: nothing may force an invalid step through ──────────────
const src = readFileSync(root("src/admin/fastlane.ts"), "utf8").replace(/\/\/.*$/gm, "")
check("no force-enabling of buttons in fastlane.ts", /removeAttribute\(["']disabled["']\)|\.disabled\s*=\s*false/.test(src), false)
check("SUBMIT is found by role, not by loose text", /getByRole\("button", \{ name \}\)/.test(src), true)
check("never clicks ADD ALL", /click[^\n]*ADD ALL|ADD ALL[^\n]*click/.test(src), false)

let chromium: typeof import("playwright").chromium
try {
  chromium = (await import("playwright")).chromium
} catch {
  console.log("skip  browser checks — playwright not importable")
  process.exit(failures ? 1 : 0)
}
let browser
try {
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
} catch (err: any) {
  console.log(`skip  browser checks — no local Chromium (${String(err?.message).split("\n")[0]})`)
  process.exit(failures ? 1 : 0)
}
try {
  const ctx = await browser.newContext()
  // tsx wraps nested functions in __name(); the page has no such helper.
  await ctx.addInitScript("window.__name = (f) => f")
  const page = await ctx.newPage()
  const load = (name: string) => page.setContent(`<html><body>${fixture(name)}</body></html>`)

  // Tile
  await load("landing.html")
  const btn = await findOneProducerManyCarriersStart(page, 1500)
  check("tile: found exactly one START REQUEST", !!btn, true)
  check(
    "tile: it is the One-Producer/Multiple-Carriers tile (2nd of 3), not Data Express",
    await btn!.evaluate((el: Element) => Array.from(document.querySelectorAll("bga-mass-contracting-action-link")).indexOf(el.closest("bga-mass-contracting-action-link")!)),
    1,
  )
  check("tile: the button says START REQUEST", /start\s*request/i.test(await btn!.innerText()), true)
  // old selector family really did miss this DOM (regression anchor)
  check("tile: old text=/One Producer.*Multiple Carriers/ matches nothing", (await page.$$('text=/One Producer.*Multiple Carriers/i')).length, 0)
  // two matching tiles = ambiguous = null (never guess)
  await page.setContent(`<html><body>${fixture("landing.html")}${fixture("landing.html")}</body></html>`)
  check("tile: ambiguous page fails closed", await findOneProducerManyCarriersStart(page, 800), null)
  // only the Data Express tile present = null
  await page.setContent(`<html><body>${fixture("landing.html").split("<bga-mass-contracting-action-link").filter((_, i) => i !== 1 && i !== 2).join("<bga-mass-contracting-action-link")}</body></html>`)
  check("tile: no One-Producer tile fails closed", await findOneProducerManyCarriersStart(page, 800), null)

  // Wizard nav
  await load("wizard-nav.html")
  check("nav: active step is producer", await activeWizardStep(page), "producer")
  check("nav: validation text surfaces", await visibleValidationText(page), "Select a producer")
  const nextRole = page.getByRole("button", { name: /^\s*(next|continue)\b(?!\s*page)/i })
  check("nav: NEXT by role excludes the paginator", await nextRole.count(), 1)
  check("nav: NEXT is disabled until the step validates", await nextRole.first().isDisabled(), true)
  await page.evaluate(() => {
    document.querySelector(".nav__button--active")!.classList.remove("nav__button--active")
    document.querySelectorAll(".nav__button")[2].classList.add("nav__button--active")
  })
  check("nav: active step follows the class", await activeWizardStep(page), "states")

  // Carriers step
  await load("carriers-step.html")
  check("cart: Selected (N) counter", await readSelectedCount(page), 1)
  check("cart: selected rows are the id-less ones", await readSelectedCarrierNames(page), ["Bravo National"])
  check("cart: only id'd rows are available rows", await page.locator('[id^="item-"]').count(), 3)

  // Preview
  await load("preview-step.html")
  const pv = await readPreview(page)
  check("preview: recognised", pv.isPreview, true)
  check("preview: Carriers (N)", pv.carriersCount, 2)
  check("preview: Sending Email value", pv.sendingEmail, "pat.example@agent.example.test")
  check("preview: SUBMIT by role", await page.getByRole("button", { name: /^\s*submit\s*$/i }).count(), 1)
  await load("carriers-step.html")
  check("preview: not mistaken for the Carriers step", (await readPreview(page)).isPreview, false)

  // Submit dialog
  await load("submit-dialog.html")
  const dlg = await readSubmitDialog(page)
  check("dialog: open and DONE shown", [dlg.open, dlg.done], [true, true])
  check("dialog: success row", dlg.ok, [{ carrier: "Alpha Life", notes: "Success" }])
  check("dialog: error row", dlg.failed, [{ carrier: "Bravo National", error: "Carrier not available in state" }])
  await load("wizard-nav.html")
  check("dialog: absent elsewhere", (await readSubmitDialog(page)).open, false)
} finally {
  await browser.close()
}
if (failures > 0) {
  console.log(`\n${failures} FAILED`)
  process.exit(1)
}
console.log("\nALL PASS")
