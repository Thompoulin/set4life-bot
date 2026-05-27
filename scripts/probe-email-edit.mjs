// scripts/probe-email-edit.mjs
//
// Probe SureLC BGA portal: open Holton Buggs producer profile, capture
// every outbound /surecrm/* HTTP request as we navigate to the email
// edit field and SAVE a corrected value. Goal: discover the actual
// SPA endpoint (URL + method + body shape) that admins fire when
// editing producer email.
//
// Why Holton: producerId 11096584, already drifted from agents.email
// `holtonbuggs@agent.set4lifeagency.com` to SureLC value
// `holton.buggs@agent.set4lifeagency.com`. Setting it back to our
// canonical address is the FIX we wanted, not just a probe — so the
// network capture is a free byproduct of doing the right thing.
//
// Usage:
//   node scripts/probe-email-edit.mjs
//
// Auth: reads SURELC_ADMIN_EMAIL + SURELC_ADMIN_PASSWORD from env, or
// hardcoded fallback for the script context.

import { chromium } from "playwright"
import { loginAdmin } from "../dist/admin/login.js"

// Use a drifted producer that hasn't been healed yet so the probe
// actually fires the PUT (a no-op producer would skip /update).
// Vanda Jamison: SureLC has vanlyn.inc@gmail.com, agency address is
// vandajamison@agent.set4lifeagency.com.
const PRODUCER_ID = process.env.PROBE_PRODUCER_ID || "3924805"
const NEW_EMAIL = process.env.PROBE_NEW_EMAIL || "vandajamison@agent.set4lifeagency.com"

const adminEmail = process.env.SURELC_ADMIN_EMAIL || "admin+bot@set4lifeagency.com"
const adminPassword = process.env.SURELC_ADMIN_PASSWORD || "pvG7Dkp5eiyf8LT!"

function makeLogger() {
  return {
    info: (...args) => console.log("[INFO]", ...args),
    warn: (...args) => console.log("[WARN]", ...args),
    error: (...args) => console.log("[ERR ]", ...args),
    child: () => makeLogger(),
  }
}

async function main() {
  const logger = makeLogger()
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  })
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1400, height: 1000 },
    })
    const page = await ctx.newPage()
    page.setDefaultTimeout(30_000)

    // Capture every /surecrm/* request as it fires.
    // postData() returns null for some encodings; postDataBuffer()
    // returns the raw bytes always. Use the buffer + decode.
    const captured = []
    page.on("request", (req) => {
      const u = req.url()
      if (!u.includes("/surecrm/") && !u.includes("/bga-api/") && !u.includes("/agency-api/")) return
      let bodyText = null
      try {
        const buf = req.postDataBuffer()
        if (buf) bodyText = buf.toString("utf8")
      } catch {
        bodyText = req.postData() || null
      }
      captured.push({
        method: req.method(),
        url: u,
        postData: bodyText,
        contentType: req.headers()["content-type"],
      })
    })
    page.on("response", (res) => {
      const u = res.url()
      if (!u.includes("/surecrm/producer") && !u.includes("/surecrm/agency")) return
      // Note: response captures are async; we'll just stash status.
      const m = captured.find((c) => c.url === u)
      if (m) m.responseStatus = res.status()
    })

    console.log(`[PROBE] logging in as ${adminEmail}`)
    const r = await loginAdmin(page, { email: adminEmail, password: adminPassword }, logger)
    if (!r.ok) {
      console.error("[PROBE] admin login failed:", r.reason)
      process.exit(1)
    }
    console.log("[PROBE] admin login OK")

    // Navigate via the SPA history-push to the producer profile.
    console.log(`[PROBE] navigating to producer ${PRODUCER_ID} profile`)
    await page.evaluate((id) => {
      history.pushState({}, "", `/bga/producers/${id}/profile`)
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
    }, PRODUCER_ID)
    await page.waitForTimeout(3500)

    // Find any visible "email" related element on the page first — log
    // its DOM so we know what we're working with.
    const initialDom = await page.evaluate(() => {
      const emailEls = Array.from(
        document.querySelectorAll('input[type="email"], input[name*="mail" i], [aria-label*="email" i], [placeholder*="email" i], button[mattooltip*="email" i]'),
      )
      return emailEls.map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type"),
        name: el.getAttribute("name"),
        id: el.id,
        ariaLabel: el.getAttribute("aria-label"),
        placeholder: el.getAttribute("placeholder"),
        mattooltip: el.getAttribute("mattooltip"),
        textContent: (el.textContent || "").trim().slice(0, 80),
        value: el.value || null,
      }))
    })
    console.log("[PROBE] email-related elements on profile page:")
    console.log(JSON.stringify(initialDom, null, 2))

    // Print page title + URL so we know we're in the right place.
    console.log("[PROBE] current URL:", page.url())
    console.log("[PROBE] page title:", await page.title())

    // Look for any "Edit" button near an email value. Common SureLC
    // pattern: a card with the email shown + a pencil/edit icon button.
    // Try multiple selector strategies.
    const editClicked = await page.evaluate(() => {
      // Strategy 1: button[mattooltip="Edit Email"] or similar
      const tooltips = Array.from(document.querySelectorAll('button[mattooltip*="mail" i]'))
      if (tooltips[0]) {
        ;(tooltips[0]).click()
        return { strategy: "mattooltip", text: tooltips[0].getAttribute("mattooltip") }
      }
      // Strategy 2: find the email value text on page, then click its sibling pencil
      const all = document.querySelectorAll("*")
      for (const el of all) {
        const t = (el.textContent || "").trim()
        if (t.match(/@agent\.set4lifeagency\.com$/i) || t.match(/^[\w.-]+@[\w.-]+\.[a-z]{2,}$/i)) {
          // Find a sibling button containing edit/pencil icon
          let p = el.parentElement
          for (let i = 0; i < 4 && p; i++) {
            const btn = p.querySelector("button mat-icon, button .mat-icon, button[aria-label*='dit' i]")
            if (btn) {
              ;(btn.closest("button") || btn).click()
              return { strategy: "sibling-button", emailText: t.slice(0, 80) }
            }
            p = p.parentElement
          }
        }
      }
      return null
    })
    console.log("[PROBE] edit-click attempt:", editClicked)
    await page.waitForTimeout(1500)

    // If a dialog opened, log its DOM.
    const dialogDom = await page.evaluate(() => {
      const dlgs = Array.from(document.querySelectorAll("mat-dialog-container, [role='dialog']"))
      return dlgs.map((d) => ({
        text: (d.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
        inputs: Array.from(d.querySelectorAll("input")).map((i) => ({
          name: i.getAttribute("name"),
          type: i.getAttribute("type"),
          placeholder: i.getAttribute("placeholder"),
          value: i.value,
        })),
        buttons: Array.from(d.querySelectorAll("button")).map((b) =>
          (b.textContent || "").trim().slice(0, 30),
        ),
      }))
    })
    console.log("[PROBE] dialog DOM after edit click:")
    console.log(JSON.stringify(dialogDom, null, 2))

    // The Change Email dialog has TWO inputs (new + confirm). APPLY is
    // disabled until both match. Names: searchEmail_<guid> and a paired
    // searchMaskEmail_<guid>. Fill the searchEmail_ pair (skip the mask
    // versions — those are autocomplete machinery, populated by the
    // SPA when the user picks from a dropdown). The current-email
    // readonly input is the third (first?) input on the page.
    const searchEmailInputs = await page.$$('mat-dialog-container input[name^="searchEmail_"]')
    console.log(`[PROBE] found ${searchEmailInputs.length} searchEmail_ inputs`)
    if (searchEmailInputs.length >= 2) {
      for (let i = 0; i < searchEmailInputs.length; i++) {
        const inp = searchEmailInputs[i]
        await inp.click({ clickCount: 3 }).catch(() => undefined)
        await inp.fill("").catch(() => undefined)
        await inp.type(NEW_EMAIL, { delay: 30 })
        console.log(`[PROBE] filled searchEmail input ${i + 1}/${searchEmailInputs.length}`)
        await page.waitForTimeout(400)
        // After typing, SureLC's auto-complete may render a list; we
        // don't want to accidentally pick a different existing producer
        // — close any open mat-option panel by pressing Escape.
        await page.keyboard.press("Escape").catch(() => undefined)
        await page.waitForTimeout(200)
      }
      // Tab off the field to commit the value to the Angular form model.
      await page.keyboard.press("Tab").catch(() => undefined)
      await page.waitForTimeout(800)

      // Click APPLY.
      const applyBtn = await page.$('mat-dialog-container button:has-text("APPLY"), mat-dialog-container button:has-text("Apply")')
      if (applyBtn) {
        const enabled = await applyBtn.isEnabled().catch(() => false)
        console.log(`[PROBE] APPLY button found, enabled=${enabled}`)
        if (enabled) {
          await applyBtn.click()
          console.log("[PROBE] clicked APPLY — waiting 6s for network round-trip")
          await page.waitForTimeout(6000)
        } else {
          // Capture the form-error state so we know what's blocking.
          const errs = await page.evaluate(() => {
            const containers = Array.from(document.querySelectorAll('mat-dialog-container mat-error, mat-dialog-container .mat-error, mat-dialog-container .error-message'))
            return containers.map((e) => (e.textContent || "").trim())
          })
          console.log("[PROBE] APPLY disabled; form errors visible:", errs)
        }
      } else {
        console.log("[PROBE] no APPLY button found")
      }
    } else {
      console.log("[PROBE] expected >=2 searchEmail_ inputs, got", searchEmailInputs.length)
    }

    // Wait a bit more for any final XHR to complete.
    await page.waitForTimeout(2000)

    // Filter captured requests to just the writes (POST/PUT/PATCH) and
    // print them.
    console.log("\n========== CAPTURED /surecrm/* WRITES ==========")
    const writes = captured.filter((c) =>
      ["POST", "PUT", "PATCH", "DELETE"].includes(c.method),
    )
    for (const w of writes) {
      console.log(`\n[${w.method}] ${w.url}`)
      console.log(`  status=${w.responseStatus || "?"} content-type=${w.contentType || "(none)"}`)
      if (w.postData) {
        const trunc = w.postData.length > 2000 ? w.postData.slice(0, 2000) + "...(truncated)" : w.postData
        console.log(`  body: ${trunc}`)
      }
    }
    console.log("\n========== ALL CAPTURED /surecrm/* (read + write) ==========")
    for (const c of captured) {
      console.log(`[${c.method}] ${c.url} (status=${c.responseStatus || "?"})`)
    }
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error("PROBE THREW:", err)
  process.exit(1)
})
