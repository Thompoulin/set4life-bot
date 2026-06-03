// Local Playwright harness for iterating on the rep-review wizard
// without paying the deploy → bot restart → 30-min carrier walk cost
// per attempt. Saves Kimberly's auth state on first run, reuses it
// for every subsequent walk.
//
// Usage:
//   node scripts/local-rep-walk.mjs auth      # one-time login, save state
//   node scripts/local-rep-walk.mjs probe     # walk one carrier, inspect step 4
//   node scripts/local-rep-walk.mjs click     # try click strategy A, verify persistence
//   node scripts/local-rep-walk.mjs walk-all  # walk all 7 carriers, report state
//
// All actions hit production SureLC against Kimberly's appointments.

import { chromium } from "playwright"
import { writeFile, readFile, mkdir, access } from "node:fs/promises"
import path from "node:path"

const STATE_FILE = "/tmp/kim-rep-state.json"
const SCREENSHOT_DIR = "/tmp/kim-local-walk"
const SSN_LAST_6 = "707415"
const DOB_SLASH = "09/01/1968"
const KIM_APPOINTMENTS = [
  { id: "117567399", carrier: "F&G" },
  { id: "117567410", carrier: "Banner Life (Quility)" },
  { id: "117567421", carrier: "American Amicable" },
  { id: "117567432", carrier: "Corebridge" },
  { id: "117567443", carrier: "Mutual of Omaha" },
  { id: "117567465", carrier: "SBLI (Quility Term)" },
  { id: "117567476", carrier: "Transamerica" },
]

const cmd = process.argv[2] || "probe"

await mkdir(SCREENSHOT_DIR, { recursive: true })

async function stateExists() {
  try { await access(STATE_FILE); return true } catch { return false }
}

async function freshAuth() {
  console.log("=== fresh auth ===")
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  page.setDefaultTimeout(45_000)
  // Use Kimberly's MoO URL — any of her valid appointments works for the auth flow
  await page.goto(
    "https://surelc.surancebay.com/sbweb/login.jsp?appointmentId=117567443&sec=1779372126000",
    { waitUntil: "domcontentloaded", timeout: 45_000 },
  )
  await page.waitForLoadState("networkidle").catch(() => {})
  await page.waitForTimeout(3000)
  // Find SSN + DOB inputs by position (first two visible textboxes per the auth-page snapshot)
  const inputs = await page.$$("input:visible")
  const ssnInput = inputs[0]
  await ssnInput.click()
  await page.keyboard.type(SSN_LAST_6, { delay: 100 })
  const dobInput = await page.$('auth-date-input input#mat-input-0, auth-date-input input[type="text"]:not([readonly]):not([matnativecontrol])')
  await dobInput.fill(DOB_SLASH, { force: true })
  const loginBtn = await page.$('button:has-text("LOGIN")')
  await loginBtn.click()
  await page.waitForURL((u) => /\/ar-review\/appointment\//.test(u.href), { timeout: 30_000 })
  await page.waitForTimeout(3000)
  console.log("  authed, landed on:", page.url())
  // Save state
  const state = await ctx.storageState()
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
  console.log("  saved state to", STATE_FILE)
  await browser.close()
}

async function withReusedAuth(fn, appointmentId = "117567443") {
  // OAuth tokens are session-bound — can't reuse storageState across
  // browser contexts. Auth fresh each call. ~10s overhead per test.
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  page.setDefaultTimeout(45_000)
  try {
    await page.goto(
      `https://surelc.surancebay.com/sbweb/login.jsp?appointmentId=${appointmentId}&sec=1779372126000`,
      { waitUntil: "domcontentloaded" },
    )
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForTimeout(3000)
    const inputs = await page.$$("input:visible")
    if (inputs[0]) {
      await inputs[0].click()
      await page.keyboard.type(SSN_LAST_6, { delay: 100 })
    }
    const dobInput = await page.$('auth-date-input input#mat-input-0, auth-date-input input[type="text"]:not([readonly]):not([matnativecontrol])')
    if (dobInput) await dobInput.fill(DOB_SLASH, { force: true })
    const loginBtn = await page.$('button:has-text("LOGIN")')
    if (loginBtn) await loginBtn.click()
    await page.waitForURL((u) => /\/ar-review\/appointment\//.test(u.href), { timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(3000)
    await fn(page)
  } finally {
    await browser.close()
  }
}

async function navigateToStep(page, appointmentId, targetStep = "misc/info") {
  await page.goto(
    `https://surelc.surancebay.com/ar-review/appointment/${appointmentId}/wizard/welcome`,
    { waitUntil: "domcontentloaded" },
  )
  await page.waitForLoadState("networkidle").catch(() => {})
  await page.waitForTimeout(4000)
  for (let i = 0; i < 6; i++) {
    const url = page.url()
    console.log(`    step ${i}: ${url}`)
    if (url.includes(targetStep)) return true
    // Find an enabled NEXT button — try multiple selectors
    let next = null
    for (const selector of [
      'button:has-text("NEXT"):not([disabled])',
      'button:has-text("Next"):not([disabled])',
      'button[type="submit"]:not([disabled])',
    ]) {
      next = await page.$(selector)
      if (next) break
    }
    // Try clicking via in-page JS — bypasses Playwright's visibility check
    // which intermittently rejects valid wizard buttons. Find the wizard's
    // bottom-right NEXT (text content "NEXT" exactly, capital, near page
    // bottom), not the header-level "Next" button.
    const clickResult = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("button")).filter((b) => {
        const t = (b.textContent || "").trim()
        if (b.disabled) return false
        if (b.classList.contains("mat-mdc-button-disabled")) return false
        return /^\s*NEXT\s*$/.test(t) || /^\s*next\s*$/i.test(t) || /^\s*continue\s*$/i.test(t)
      })
      if (candidates.length === 0) return { clicked: false, reason: "no candidate" }
      // Prefer button positioned near bottom of the viewport (wizard nav)
      // over header buttons.
      candidates.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)
      const chosen = candidates[0]
      const rect = chosen.getBoundingClientRect()
      chosen.click()
      return { clicked: true, text: (chosen.textContent || "").trim(), rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } }
    })
    console.log("    clickResult:", JSON.stringify(clickResult))
    if (!clickResult.clicked) return false
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForTimeout(3000)
  }
  return page.url().includes(targetStep)
}

async function dumpRadioState(page) {
  return await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll("mat-radio-group"))
    return groups.map((g) => {
      const radios = Array.from(g.querySelectorAll("input[type=\"radio\"]"))
      const checked = radios.find((r) => r.checked)
      const container = g.closest("sb-question, .wrap, mat-form-field, mat-card") || g.parentElement
      const label = (container?.querySelector(".question__text, mat-label, label")?.textContent || "").trim().slice(0, 120)
      return {
        label,
        values: radios.map((r) => r.value),
        checked: checked?.value || null,
      }
    })
  })
}

async function tryClickStrategies(page, groupName, targetValue) {
  const sel = `input[type="radio"][name="${groupName}"][value="${targetValue}"]`
  const results = {}

  // Strategy A: locator.click force
  try {
    await page.locator(sel).first().click({ timeout: 3000, force: true })
    results.A_locator_click = "OK"
  } catch (e) { results.A_locator_click = `FAIL: ${e.message.slice(0, 60)}` }

  await page.waitForTimeout(500)
  let state = (await dumpRadioState(page)).find((g) => g.values.length && g.checked === targetValue)
  results.A_persisted = !!state

  // Strategy B: locator.check
  try {
    await page.locator(sel).first().check({ timeout: 3000, force: true })
    results.B_locator_check = "OK"
  } catch (e) { results.B_locator_check = `FAIL: ${e.message.slice(0, 60)}` }

  await page.waitForTimeout(500)
  state = (await dumpRadioState(page)).find((g) => g.values.length && g.checked === targetValue)
  results.B_persisted = !!state

  // Strategy C: mat-radio-button wrapper click
  try {
    await page.locator(`mat-radio-button:has(${sel})`).first().click({ timeout: 3000, force: true })
    results.C_wrapper_click = "OK"
  } catch (e) { results.C_wrapper_click = `FAIL: ${e.message.slice(0, 60)}` }

  await page.waitForTimeout(500)
  state = (await dumpRadioState(page)).find((g) => g.values.length && g.checked === targetValue)
  results.C_persisted = !!state

  // Strategy D: in-page JS .click()
  try {
    const ok = await page.evaluate(({ s }) => {
      const r = document.querySelector(s)
      if (!r) return false
      r.click()
      r.dispatchEvent(new Event("change", { bubbles: true }))
      return true
    }, { s: sel })
    results.D_inpage_click = ok ? "OK" : "no element"
  } catch (e) { results.D_inpage_click = `FAIL: ${e.message.slice(0, 60)}` }

  await page.waitForTimeout(500)
  state = (await dumpRadioState(page)).find((g) => g.values.length && g.checked === targetValue)
  results.D_persisted = !!state

  // Strategy E: in-page JS click on mat-radio-button wrapper
  try {
    const ok = await page.evaluate(({ s }) => {
      const r = document.querySelector(s)
      if (!r) return false
      const wrapper = r.closest("mat-radio-button")
      if (wrapper) wrapper.click()
      else r.click()
      return true
    }, { s: sel })
    results.E_inpage_wrapper = ok ? "OK" : "no element"
  } catch (e) { results.E_inpage_wrapper = `FAIL: ${e.message.slice(0, 60)}` }

  await page.waitForTimeout(500)
  state = (await dumpRadioState(page)).find((g) => g.values.length && g.checked === targetValue)
  results.E_persisted = !!state

  // Strategy F: full event sequence via dispatchEvent on the input
  // (mouseover/mousedown/mouseup/click/change/input)
  try {
    const ok = await page.evaluate(({ s }) => {
      const r = document.querySelector(s)
      if (!r) return false
      r.focus()
      r.checked = true
      const eventTypes = ["mousedown", "mouseup", "click", "input", "change"]
      for (const t of eventTypes) {
        r.dispatchEvent(new Event(t, { bubbles: true, cancelable: true }))
      }
      return true
    }, { s: sel })
    results.F_full_events = ok ? "OK" : "no element"
  } catch (e) { results.F_full_events = `FAIL: ${e.message.slice(0, 60)}` }
  await page.waitForTimeout(500)
  state = (await dumpRadioState(page)).find((g) => g.values.length && g.checked === targetValue)
  results.F_persisted = !!state

  // Strategy G: dispatch on the mat-radio-button host (Angular component)
  try {
    const ok = await page.evaluate(({ s }) => {
      const r = document.querySelector(s)
      if (!r) return false
      const host = r.closest("mat-radio-button")
      if (!host) return false
      host.focus()
      host.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }))
      return true
    }, { s: sel })
    results.G_host_dispatch = ok ? "OK" : "no element"
  } catch (e) { results.G_host_dispatch = `FAIL: ${e.message.slice(0, 60)}` }
  await page.waitForTimeout(500)
  state = (await dumpRadioState(page)).find((g) => g.values.length && g.checked === targetValue)
  results.G_persisted = !!state

  // Strategy H: keyboard space on the mat-radio-button host (Material
  // supports keyboard navigation for accessibility — Space toggles).
  try {
    const ok = await page.evaluate(({ s }) => {
      const r = document.querySelector(s)
      if (!r) return false
      r.focus()
      return true
    }, { s: sel })
    if (ok) {
      await page.keyboard.press("Space")
    }
    results.H_keyboard_space = ok ? "OK" : "no element"
  } catch (e) { results.H_keyboard_space = `FAIL: ${e.message.slice(0, 60)}` }
  await page.waitForTimeout(500)
  state = (await dumpRadioState(page)).find((g) => g.values.length && g.checked === targetValue)
  results.H_persisted = !!state

  return results
}

if (cmd === "auth") {
  await freshAuth()
  process.exit(0)
}

if (cmd === "probe") {
  // Walk to MoO Carrier Questions, dump radio state
  await withReusedAuth(async (page) => {
    const ok = await navigateToStep(page, "117567443", "misc/info")
    console.log("  navigated to step:", page.url(), "ok:", ok)
    const state = await dumpRadioState(page)
    console.log("  radios:", JSON.stringify(state, null, 2))
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "probe-moo.png"), fullPage: true })
  })
  process.exit(0)
}

if (cmd === "click") {
  // On Transamerica's Carrier Questions, try each click strategy on a sub-opt-in
  // ("COMPANY APPOINTMENT REQUEST: Transamerica Casualty Insurance" → Yes).
  // Verify persistence after each by re-loading the page.
  const APPT = "117567476"
  await withReusedAuth(async (page) => {
    const ok = await navigateToStep(page, APPT, "misc/info")
    console.log("  on Transamerica CQ:", page.url(), "ok:", ok)
    const before = await dumpRadioState(page)
    console.log("  BEFORE:")
    for (const g of before) {
      console.log(`    [${g.checked || "_"}] ${g.label.slice(0, 70)}  (values: ${g.values.join("/")})`)
    }
    // Pick the first COMPANY APPOINTMENT REQUEST group
    const target = before.find((g) => /COMPANY APPOINTMENT REQUEST/i.test(g.label))
    if (!target) { console.log("  no COMPANY APPOINTMENT REQUEST group found"); return }
    console.log(`\n  TARGET: "${target.label.slice(0, 70)}"`)
    // We need to find its mat-radio-group name. Re-fetch with names.
    const targetName = await page.evaluate((labelExcerpt) => {
      const groups = Array.from(document.querySelectorAll("mat-radio-group"))
      for (const g of groups) {
        const c = g.closest("sb-question, .wrap, mat-form-field, mat-card") || g.parentElement
        const label = (c?.querySelector(".question__text, mat-label, label")?.textContent || "").trim()
        if (label.includes(labelExcerpt)) {
          const inp = g.querySelector("input[type=\"radio\"]")
          return inp?.name
        }
      }
      return null
    }, target.label.slice(0, 40))
    console.log("  groupName:", targetName)
    if (!targetName) return

    const results = await tryClickStrategies(page, targetName, "Y")
    console.log("\n  RESULTS (any 'persisted: true' means the click stuck):")
    console.log(JSON.stringify(results, null, 2))

    // Click NEXT (wizard's bottom button) via in-page JS — Playwright
    // visibility check rejects it.
    console.log("\n  clicking NEXT to commit...")
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button")).filter((b) => {
        if (b.disabled || b.classList.contains("mat-mdc-button-disabled")) return false
        return /^\s*next\s*$/i.test((b.textContent || "").trim())
      })
      buttons.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)
      buttons[0]?.click()
    })
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForTimeout(4000)
    console.log("    after-next URL:", page.url())
    // SureLC bounces direct goto to /misc/info back to /welcome.
    // Walk through the steps again instead. The previous NEXT was the
    // commit; this re-walk verifies persistence.
    console.log("\n  walking back through steps to verify persistence...")
    const reauthOk = await navigateToStep(page, APPT, "misc/info")
    console.log("    re-walk reached misc/info:", reauthOk, "URL:", page.url())
    const after = await dumpRadioState(page)
    if (after.length === 0) {
      console.log("    no radio groups on misc/info — wizard may be in unexpected state")
    } else {
      console.log("    FINAL STATE (after NEXT-commit + re-walk):")
      for (const g of after) {
        console.log(`      [${g.checked || "_"}] ${g.label.slice(0, 80)}`)
      }
      const verified = after.find((g) => g.label.includes(target.label.slice(0, 40)))
      console.log(`\n    Transamerica Casualty after persistence test: ${verified?.checked || "_"}`)
      console.log(`    EXPECTED: Y (the click strategies set it to Y, NEXT committed)`)
    }
  }, APPT)
  process.exit(0)
}

if (cmd === "walk-all") {
  // Walk every appointment, dump CQ state. No clicking — just inspection.
  // Auth on each one (OAuth tokens are appointment-scoped).
  for (const { id, carrier } of KIM_APPOINTMENTS) {
    console.log(`\n=== ${carrier} (${id}) ===`)
    await withReusedAuth(async (page) => {
      const ok = await navigateToStep(page, id, "misc/info")
      if (!ok) {
        console.log("  could not reach CQ — blocked on earlier step (likely AML missing)")
        return
      }
      const state = await dumpRadioState(page)
      for (const g of state) {
        console.log(`  [${g.checked || "_"}] ${g.label.slice(0, 80)}`)
      }
    }, id)
  }
  process.exit(0)
}

console.log(`unknown command: ${cmd}`)
console.log("usage: auth | probe | click | walk-all")
process.exit(1)
