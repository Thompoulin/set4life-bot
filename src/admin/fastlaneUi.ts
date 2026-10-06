/**
 * Page-reading helpers for the Fastlane "One Producer - Many Carriers" wizard.
 *
 * SureLC redesigned the BGA portal on 2026-10-05 (build "1.124.024"). What the
 * bot depends on, as of that build (see docs/2026-10-05-fastlane-redesign.md):
 *
 *  - /bga/fastlane is three tiles, each a <bga-mass-contracting-action-link>.
 *    The tile we want reads "ONE PRODUCER -> MULTIPLE CARRIERS" with a
 *    "START REQUEST" button. A THIRD tile (Data Express: "SEND UPDATES")
 *    carries the same two phrases; it is not the one.
 *  - The words are laid out by CSS. In the DOM they have no spaces between
 *    them ("oneproducer...multiplecarriers"), so every text match here uses
 *    \s* between words and [\s\S]* (not .*) across the icon ligatures.
 *  - The wizard lives at /bga/fastlane/multiCarriers/new/<step>/info. Its left
 *    nav is five <button class="nav__button"> ("1 Producer", "2 Carriers",
 *    "3 States", "4 Products", "5 Preview"); the active one has
 *    .nav__button--active. NEXT is disabled until the step validates; the last
 *    step shows SUBMIT instead.
 *  - SUBMIT opens a "Processing Contracting Requests" dialog that posts the
 *    request and lists one row per carrier (.grid__row--success / --error),
 *    then shows DONE.
 */
import type { Locator, Page } from "playwright"

export const TILE_ATTR = "data-s4l-fastlane-tile"

/** Whitespace-free, lower-case form of a string, for layout-proof matching. */
export function squash(s: string): string {
  return (s || "").replace(/\s+/g, "").toLowerCase()
}

/**
 * Tag the START REQUEST button of the "One Producer -> Multiple Carriers"
 * tile and return a locator for it. Climbs from every START REQUEST button to
 * the nearest ancestor whose text mentions the tile's two phrases, and
 * accepts it only if that ancestor is NOT the Multiple-Producers tile and NOT
 * the Data Express one. Exactly one candidate or nothing (fail closed).
 */
export async function findOneProducerManyCarriersStart(
  page: Page,
  timeoutMs = 20_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs
  do {
    const n = await page
      .evaluate((attr) => {
        const sq = (s: string) => (s || "").replace(/\s+/g, "").toLowerCase()
        document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr))
        // One entry per tile (keyed by the tile element), so a tile whose host
        // also exposes role=button is not counted twice. Prefer a real <button>.
        const byTile = new Map<Element, Element>()
        const buttons = Array.from(document.querySelectorAll("button, a, [role='button']")).filter((b) =>
          /startrequest/.test(sq(b.textContent || "")),
        )
        for (const b of buttons) {
          let el: Element | null = b.parentElement
          for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
            const t = sq(el.textContent || "")
            if (/oneproducer[\s\S]*multiplecarriers/.test(t)) {
              if (!/multipleproducers|sendupdates|dataexpress/.test(t)) {
                const prev = byTile.get(el)
                if (!prev || (b.tagName === "BUTTON" && prev.tagName !== "BUTTON")) byTile.set(el, b)
              }
              break
            }
          }
        }
        const hits = Array.from(byTile.values())
        if (hits.length === 1) hits[0].setAttribute(attr, "1")
        return hits.length
      }, TILE_ATTR)
      .catch(() => 0)
    if (n === 1) return page.locator(`[${TILE_ATTR}="1"]`)
    if (n > 1) return null // ambiguous: never guess which tile
    await page.waitForTimeout(500)
  } while (Date.now() < deadline)
  return null
}

/** Normalised label of the wizard's active step ("producer", "carriers", ...), or null. */
export async function activeWizardStep(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const el = document.querySelector(".nav__button--active, .nav__button.active, [aria-current='step']")
      const t = (el?.textContent || "").replace(/^\s*\d+\s*/, "").replace(/\s+/g, " ").trim().toLowerCase()
      return t || null
    })
    .catch(() => null)
}

/** Wait for the wizard's active step to be `label`. A nav that never becomes readable returns active: null. */
export async function waitForWizardStep(
  page: Page,
  label: string,
  timeoutMs = 10_000,
): Promise<{ reached: boolean; active: string | null }> {
  const want = label.toLowerCase()
  const deadline = Date.now() + timeoutMs
  let active: string | null = null
  do {
    active = await activeWizardStep(page)
    if (active === want) return { reached: true, active }
    await page.waitForTimeout(400)
  } while (Date.now() < deadline)
  return { reached: false, active }
}

/** Visible validation / error text on the current step, for failure reasons. */
export async function visibleValidationText(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const seen = new Set<string>()
      document
        .querySelectorAll("mat-error, sb-info-message, .error, .errors, [role='alert']")
        .forEach((e) => {
          const t = ((e as HTMLElement).innerText || e.textContent || "").replace(/\s+/g, " ").trim()
          if (t && t.length < 240) seen.add(t)
        })
      return Array.from(seen).slice(0, 6).join(" | ")
    })
    .catch(() => "")
}

/** Names of the carriers sitting in the "Selected" column of the Carriers step. */
export async function readSelectedCarrierNames(page: Page): Promise<string[]> {
  return page
    .evaluate(() =>
      // Available rows carry id="item-<carrierId>"; Selected rows are the same
      // markup without an id (sb-list-multi-select).
      Array.from(document.querySelectorAll(".items__item.item:not([id]) .item__line1")).map((e) =>
        ((e as HTMLElement).innerText || e.textContent || "").replace(/\s+/g, " ").trim(),
      ),
    )
    .catch(() => [] as string[])
}

/** The "Selected (N)" counter on the Carriers step, or null when absent (empty cart prints "Selected "). */
export async function readSelectedCount(page: Page): Promise<number | null> {
  const txt = await page.evaluate(() => document.body?.innerText || "").catch(() => "")
  const m = txt.match(/Selected\s*\((\d+)\)/i)
  return m ? Number(m[1]) : null
}

export interface PreviewReading {
  /** True when the page shows "Contracting Request Preview". */
  isPreview: boolean
  /** N from the "Carriers (N)" panel header. */
  carriersCount: number | null
  /** Value of the "Sending Email" input (defaults to the producer's email). */
  sendingEmail: string | null
}

export async function readPreview(page: Page): Promise<PreviewReading> {
  return page
    .evaluate(() => {
      const body = document.body?.innerText || ""
      const isPreview = /Contracting\s*Request\s*Preview/i.test(body)
      const m = body.match(/Carriers\s*\((\d+)\)/i)
      let sendingEmail: string | null = null
      for (const f of Array.from(document.querySelectorAll("mat-form-field"))) {
        if (/sending\s*email/i.test(f.textContent || "")) {
          const input = f.querySelector("input") as HTMLInputElement | null
          if (input) sendingEmail = (input.value || "").trim()
        }
      }
      return { isPreview, carriersCount: m ? Number(m[1]) : null, sendingEmail }
    })
    .catch(() => ({ isPreview: false, carriersCount: null, sendingEmail: null }))
}

export interface SubmitDialogReading {
  /** The "Processing Contracting Requests" dialog is on screen. */
  open: boolean
  /** DONE button visible: every carrier has reported. */
  done: boolean
  ok: Array<{ carrier: string; notes: string }>
  failed: Array<{ carrier: string; error: string }>
}

export async function readSubmitDialog(page: Page): Promise<SubmitDialogReading> {
  return page
    .evaluate(() => {
      const txt = (e: Element | null) => ((e as HTMLElement | null)?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim()
      const dlg = Array.from(document.querySelectorAll("mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane")).find((d) =>
        /Processing\s*Contracting\s*Requests/i.test(d.textContent || ""),
      )
      if (!dlg) return { open: false, done: false, ok: [], failed: [] }
      const rows = (sel: string) =>
        Array.from(dlg.querySelectorAll(sel)).map((r) => {
          const cells = Array.from(r.querySelectorAll(".grid__cell")).map((c) => txt(c))
          return { carrier: cells[0] || "", detail: (cells[1] || "").replace(/^(check_circle|error)\s*/i, "") }
        })
      const done = Array.from(dlg.querySelectorAll("button")).some((b) => /^\s*done\s*$/i.test(b.textContent || ""))
      return {
        open: true,
        done,
        ok: rows(".grid__row--success").map((r) => ({ carrier: r.carrier, notes: r.detail })),
        failed: rows(".grid__row--error").map((r) => ({ carrier: r.carrier, error: r.detail })),
      }
    })
    .catch(() => ({ open: false, done: false, ok: [], failed: [] }) as SubmitDialogReading)
}
