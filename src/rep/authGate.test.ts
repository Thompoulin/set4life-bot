/**
 * Rep SSN/DOB auth gate against both SureLC generations.
 * Run with: `npx tsx src/rep/authGate.test.ts` (CHROMIUM_PATH=<chrome binary> if needed).
 *
 * Fixtures are the <auth-ssn-dob-login> element trimmed from the bot's own
 * rep-step0-auth-page.html dumps (no producer data on that screen):
 *   auth-gate-pre-redesign.html — 2026-10-06 01:33Z, Angular 13 (last good run)
 *   auth-gate-redesign.html     — 2026-10-07 10:19Z, Angular 19 (every run since 10-06 08:32Z)
 * Without the SPA the inputs are plain, so this checks selectors and the
 * read-back / fail-closed logic, not IMask itself.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DOB_INPUT, SSN_KEY_INPUT, fillRepAuthGate, hasSsnGate } from "./authGate.js"

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}
const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url))
const fixture = (name: string) => readFileSync(root(`test/fixtures/rep-auth-2026-10-05/${name}`), "utf8")

const PRE = fixture("auth-gate-pre-redesign.html")
const NEW = fixture("auth-gate-redesign.html")
check("fixture: redesign has no auth-ssn-input (the regression)", NEW.includes("<auth-ssn-input"), false)
check("fixture: redesign has sb-ssn-input", NEW.includes("<sb-ssn-input"), true)

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

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent } }
try {
  const bctx = await browser.newContext()
  await bctx.addInitScript("window.__name = (f) => f")
  const page = await bctx.newPage()
  const ctx = { page, logger: silent, jobId: "test", evidenceDir: "/tmp/authgate-test", evidenceFiles: [] as string[] }
  // Record LOGIN clicks and keep the form from navigating.
  const load = async (html: string, extraScript = "") => {
    await page.setContent(`<html><body>${html}<script>
      window.__loginClicks = 0;
      document.addEventListener('submit', e => e.preventDefault(), true);
      document.addEventListener('click', e => {
        const b = e.target.closest('button');
        if (b && /LOGIN/.test(b.textContent)) window.__loginClicks++;
      }, true);
      ${extraScript}
    </script></body></html>`)
  }
  const value = (sel: string) => page.evaluate((s: string) => (document.querySelector(s) as HTMLInputElement).value, sel)
  const clicks = () => page.evaluate(() => (window as any).__loginClicks as number)

  for (const [label, html] of [["pre-redesign", PRE], ["redesign", NEW]] as const) {
    await load(html)
    check(`${label}: SSN/DOB gate detected`, await hasSsnGate(page), true)
    const res = await fillRepAuthGate(ctx as any, "123456", "01-31-1980", "auth")
    check(`${label}: fill ok`, res, { ok: true })
    check(`${label}: SSN typed into the key input`, await value(SSN_KEY_INPUT), "123456")
    check(`${label}: DOB typed into the text input`, await value(DOB_INPUT), "01/31/1980")
    check(`${label}: LOGIN clicked once`, await clicks(), 1)
  }

  // The redesign's key input is the data-cy one, not the display input.
  await load(NEW)
  check("redesign: key input is data-cy=ssn-input", await page.$eval(SSN_KEY_INPUT, (el) => el.getAttribute("data-cy")), "ssn-input")
  check("redesign: DOB input is not the matNativeControl", await page.$eval(DOB_INPUT, (el) => el.hasAttribute("matnativecontrol")), false)

  // A real email/password login is not mistaken for the gate.
  await load(`<form><input type="email"><input type="password"><button>LOGIN</button></form>`)
  check("email/password page: no SSN gate", await hasSsnGate(page), false)
  check("email/password page: fill refuses", (await fillRepAuthGate(ctx as any, "123456", "01-31-1980", "auth")).reason, "SSN field not found at auth")
  check("email/password page: no LOGIN click", await clicks(), 0)

  // DOB the page throws away on blur (mask rejected it) → nothing submitted.
  await load(NEW, `document.querySelector('[data-cy="date-input"]').addEventListener('blur', e => { e.target.value = '' })`)
  const rejected = await fillRepAuthGate(ctx as any, "123456", "01-31-1980", "auth")
  check("DOB rejected: fails with the backoffice-recognised prefix", /^DOB field not found at auth/.test(rejected.reason ?? ""), true)
  check("DOB rejected: no LOGIN click", await clicks(), 0)

  // SSN keystrokes that never land → nothing submitted.
  await load(NEW, `document.querySelector('[data-cy="ssn-input"]').addEventListener('input', e => { e.target.value = '' })`)
  const lost = await fillRepAuthGate(ctx as any, "123456", "01-31-1980", "re-auth")
  check("SSN lost: fails with the backoffice-recognised prefix", /^SSN field not found at re-auth/.test(lost.reason ?? ""), true)
  check("SSN lost: no LOGIN click", await clicks(), 0)
} finally {
  await browser.close()
}
if (failures > 0) {
  console.log(`\n${failures} FAILED`)
  process.exit(1)
}
console.log("\nALL PASS")
