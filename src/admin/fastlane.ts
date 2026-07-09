/**
 * Fastlane wizard — "One Producer, Many Carriers" path.
 *
 * After the producer profile is fully filled (DBA, Questions, E&O,
 * AML, Signature) and validation rules go green, this is what
 * actually submits the contracting requests to the carriers.
 *
 * Walks the 5-step wizard in the SureLC BGA portal at
 * https://surelc.surancebay.com/bga/fastlane:
 *
 *   1. Click "ONE PRODUCER → MULTIPLE CARRIERS" tile
 *   2. Producer screen — search for the rep by name, click SELECT
 *   3. Carriers screen — add ONLY the carriers the agent actually
 *      selected (passed in `input.carriers`). NEVER "ADD ALL" — owner
 *      directive: contract exactly the agent's selection, nothing more.
 *      If the selection list is empty/missing we add NOTHING (safer to
 *      add none than every carrier — the ADD-ALL bug once gave Gabriel
 *      Fernandez 4 carriers he never picked).
 *   4. States screen — for each carrier, click DESELECT ALL is wrong;
 *      we want EVERY state checked. Default = all checked, so this
 *      step is mostly a no-op verification.
 *   5. Products + Preview — click NEXT through Products, click
 *      SUBMIT on Preview
 */

import {
  type TabContext,
  type TabResult,
  firstVisible,
  gotoBga,
  settle,
  snapshot,
} from "../tabs/helpers.js"

export interface FastlaneInput {
  /** Producer's full name as displayed in the SureLC list (e.g. "LOVE, ZACHARY EDMOND"). */
  producerDisplayName: string
  /** Numeric SureLC producer ID. Optional — used to self-diagnose
   * when Fastlane flags the producer with "N issues" but the
   * tooltip can't be captured. The bot opens a side-page on the
   * producer's profile and scrapes inline validation errors. */
  producerId?: string
  /**
   * The carriers the agent actually SELECTED (from
   * agent_carrier_contracting). On the Carriers step we add ONLY
   * these — never every available carrier. Each entry carries the
   * on-screen SureLC carrier name (e.g. "Foresters - Independent
   * Order Of", "Fidelity & Guaranty Life Insurance Company") and,
   * when known, the SureLC carrier id / NAIC. Match by name first,
   * then id as a fallback.
   *
   * If empty/undefined the Carriers step adds NOTHING and logs a
   * warning (safer than the old ADD-ALL fallback which contracted
   * carriers the agent never picked).
   */
  selectedCarriers?: Array<{ carrierName: string; carrierNaic?: string }>
}

/**
 * Normalize a carrier name for fuzzy comparison: lowercase, strip
 * punctuation/whitespace so "Fidelity & Guaranty Life Insurance
 * Company" and "Fidelity and Guaranty Life Ins Co" have a chance of
 * lining up on a substring test. We only use this for a loose contains
 * check, never for equality.
 */
function normalizeCarrier(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

const FASTLANE_URL = "https://surelc.surancebay.com/bga/fastlane"

export async function runFastlaneOneProducerManyCarriers(
  ctx: TabContext,
  input: FastlaneInput,
): Promise<TabResult> {
  const { page, logger } = ctx

  const nav = await gotoBga(page, FASTLANE_URL, logger)
  if (!nav.ok) {
    return {
      ok: false,
      reason: `BGA session bounced to OAuth at ${nav.finalUrl} when opening Fastlane.`,
    }
  }
  await settle(page, 1500)
  await snapshot(ctx, "fastlane-01-landing")

  // ── Step 0 — pick the "One Producer → Multiple Carriers" tile.
  const tile = await firstVisible(page, [
    'text=/One Producer.*Multiple Carriers/i',
    '[class*="tile"]:has-text("ONE PRODUCER")',
    'div:has-text("ONE PRODUCER"):has-text("MULTIPLE CARRIERS")',
  ])
  if (!tile) {
    return { ok: false, reason: "Fastlane 'One Producer Many Carriers' tile not found" }
  }
  await tile.click().catch(() => undefined)
  await settle(page, 1500)

  // Dismiss any leftover "Are you sure you want to exit before
  // submitting?" Warning modal from a previous bot session that
  // half-completed the wizard. Click NO (stay-in-wizard) so the
  // Producer search step is interactable. (Keyon 2026-05-08: bot
  // hit this and spent the whole wizard fighting an invisible
  // blocker — every snapshot showed the modal still up.)
  const exitWarningNo = await firstVisible(page, [
    'mat-dialog-container:has-text("exit before submitting") button:has-text("NO")',
    'mat-dialog-container:has-text("exit before submitting") button:has-text("No")',
    '.cdk-overlay-pane:has-text("exit before submitting") button:has-text("NO")',
  ])
  if (exitWarningNo) {
    logger.info("[Fastlane] dismissing leftover 'exit before submitting' warning")
    await (exitWarningNo as any).click().catch(() => undefined)
    await settle(page, 800)
  }

  await snapshot(ctx, "fastlane-02-step1-producer")

  // ── Step 1 — Producer search + SELECT.
  //
  // Fastlane's producer list is virtualized — Angular CDK only
  // renders cards in the visible viewport. With 11+ producers,
  // anyone past the visible 5–8 is NOT in the DOM, so a direct
  // `bga-producer-card:has-text("LASTNAME")` query fails for
  // off-screen producers. The fix is to filter via the Search
  // input, which causes the server (or client) to narrow the list
  // until only matching cards render.
  //
  // Josue 2026-05-08: the previous `input[placeholder*="search"]`
  // selector missed because Material's input has no placeholder/
  // type/aria-label — just a `<mat-label>Search</mat-label>`
  // sibling. Use the same Material-aware path our other fills use.
  const search =
    (await page.$('mat-label:has-text("Search") >> xpath=ancestor::*[self::mat-form-field][1] >> input').catch(() => null)) ||
    (await firstVisible(page, [
      'input[placeholder*="search" i]',
      'input[type="search"]',
      'input[aria-label*="search" i]',
    ]))
  if (search) {
    try {
      await (search as any).click()
      await (search as any).fill("")
      // Last-name-only search is the safest — Fastlane shows names
      // as "LASTNAME, FIRSTNAME [MIDDLE/SUFFIX]", and the agent's
      // displayName from our side might not include middle initials
      // even when the cert/SureLC record does.
      const lastName = input.producerDisplayName.split(",")[0]?.trim() || input.producerDisplayName
      await (search as any).fill(lastName)
      // Some Material search inputs need an explicit Enter to commit
      // the filter, others debounce on input. Press Enter just in
      // case + give a generous wait (3s) for the server-side filter.
      await (search as any).press("Enter").catch(() => undefined)
      await page.waitForTimeout(3_000)
      logger.info({ filtered: lastName }, "[Fastlane] producer search filled")
      await snapshot(ctx, "fastlane-02b-after-search")
    } catch (err: any) {
      logger.warn({ err: err?.message }, "[Fastlane] search fill failed")
    }
  } else {
    logger.warn("[Fastlane] producer search input not found")
  }
  // Click SELECT on the matching producer row. SureLC renders each
  // producer as a `<bga-producer-card>` with class `viewport__item`
  // — NOT a <tr> and not anything `[class*="row"]` (verified Sydney
  // 2026-05-07 04:16 from fastlane-02-step1-producer.html). The card
  // contains a `.producer__name` div and a SELECT button.
  //
  // Producers with profile issues (red "N issues" badge) have NO
  // SELECT button — those cards are read-only and must be repaired
  // before they can be picked.
  //
  // 2026-05-28 Javier Castro: our DB has firstName="Javier"
  // lastName="Castro" → producerDisplayName="CASTRO, JAVIER", but
  // SureLC's card text is "CASTRO DIAZ, JAVIER ANTONIO" (paternal +
  // maternal surname + middle name — common for Latin-American
  // producers who register with their full legal name). The exact
  // :has-text("CASTRO, JAVIER") substring is NOT in
  // "CASTRO DIAZ, JAVIER ANTONIO" → producerCard = null → bot
  // falsely reports "N issues" when the card actually has a SELECT
  // button. The search step already narrows by lastName, so the
  // post-search viewport is reliably the producer in question. We
  // try exact match first (Sydney etc. work as before), then a
  // fuzzy match (card text contains lastName AND firstName as
  // separate substrings), then any single rendered card.
  let producerCard = await page.$(
    `bga-producer-card:has-text("${input.producerDisplayName}")`,
  )
  const dispParts = input.producerDisplayName.split(",")
  const lastNameMatch = (dispParts[0] || "").trim()
  const firstNameMatch = (dispParts[1] || "").trim()
  if (!producerCard && lastNameMatch && firstNameMatch) {
    // Fuzzy: card contains BOTH last AND first as substrings (handles
    // "CASTRO DIAZ, JAVIER ANTONIO" matching last="CASTRO" + first="JAVIER").
    producerCard = await page.$(
      `bga-producer-card:has-text("${lastNameMatch}"):has-text("${firstNameMatch}")`,
    )
  }
  if (!producerCard && lastNameMatch) {
    // Last resort: search narrowed by lastName already; if exactly
    // one card is visible after the search filter, it's our producer.
    const allCards = await page.$$("bga-producer-card")
    if (allCards.length === 1) {
      producerCard = allCards[0]
    }
  }
  let selectBtn: any = null
  if (producerCard) {
    selectBtn = await producerCard.$('button:has-text("SELECT")')
  }
  if (!selectBtn) {
    // Fallback for older builds — look for a card-like wrapper
    // containing the producer's name + a SELECT button.
    selectBtn = await page.$(
      `.viewport__item:has-text("${input.producerDisplayName}") button:has-text("SELECT")`,
    )
  }
  if (!selectBtn && lastNameMatch && firstNameMatch) {
    selectBtn = await page.$(
      `.viewport__item:has-text("${lastNameMatch}"):has-text("${firstNameMatch}") button:has-text("SELECT")`,
    )
  }
  if (!selectBtn) {
    // No SELECT button — Fastlane has flagged the producer as having
    // unresolved issues. Click the "N issues" popover trigger to
    // reveal the actual issue text in the CDK overlay, then surface
    // it in the failure reason so the operator (or future bot logic)
    // knows what to fix.
    let issueText = ""
    try {
      // The "1 issue" badge is an <sb-popover.errors> with an empty
      // <div.popover__tooltip.mat-mdc-menu-trigger> child. The
      // trigger div has 0×0 size so a normal click misses; we need
      // either force:true or to click the trigger via JS. Try
      // clicking the visible sb-popover element first (event bubbles
      // to the trigger), then JS-dispatch as fallback.
      const popoverHost = producerCard
        ? await producerCard.$("sb-popover.errors, sb-popover:has-text('issue')")
        : null
      if (popoverHost) {
        await (popoverHost as any).click({ force: true }).catch(() => undefined)
        await page.waitForTimeout(400)
        // If the menu didn't open, try hover (some sb-popovers open
        // on hover not click).
        await (popoverHost as any).hover().catch(() => undefined)
        await page.waitForTimeout(400)
        // JS-dispatch a click on the menu trigger.
        await page
          .evaluate((card) => {
            const trigger = card?.querySelector(
              ".popover__tooltip.mat-mdc-menu-trigger",
            ) as HTMLElement | null
            trigger?.click()
          }, producerCard)
          .catch(() => undefined)
        await page.waitForTimeout(800)

        issueText = (
          await page
            .$$eval(".cdk-overlay-container", (els) =>
              els
                .map((e) => (e as HTMLElement).innerText || "")
                .join(" | ")
                .trim(),
            )
            .catch(() => "")
        ).slice(0, 400)
        await snapshot(ctx, "fastlane-02c-issue-popover")
      }
      // Demetrius 2026-05-09: above 3-strategy attempt left issueText
      // empty. Fallback: read everything visible on the page that
      // looks like an issue label — without iterating clicks (the
      // earlier walk-every-descendant version crashed the browser
      // when Angular's Material menu triggered a navigation/destroy).
      // Read .cdk-overlay-pane + role=tooltip across the document.
      if (!issueText && producerCard) {
        issueText = (
          await page
            .$$eval(
              ".cdk-overlay-pane, mat-menu-panel, [role=tooltip]",
              (els) =>
                els
                  .map((e) => (e as HTMLElement).innerText || "")
                  .filter((t) => t.trim().length > 5)
                  .join(" | "),
            )
            .catch(() => "")
        )
          .trim()
          .slice(0, 400)
      }
      // Final fallback: read any text content from the producer card
      // that looks like an issue label (e.g. "1 issue", "License
      // Required", "Address Invalid"). The badge text itself is on
      // the card even if the popover never opens.
      if (!issueText && producerCard) {
        const cardText = await producerCard
          .evaluate((c) => (c.textContent || "").replace(/\s+/g, " ").trim())
          .catch(() => "")
        const issueMatch = cardText.match(
          /\b\d+\s+issues?\b|\b(license|address|email|finra|signature|e&?o|background|disclosure|expired|missing|invalid|required)\s+\w[\w\s]{0,60}/i,
        )
        if (issueMatch) issueText = issueMatch[0].slice(0, 200)
      }
    } catch {
      /* swallow — the diagnostic is best-effort */
    }
    // Demetrius 2026-05-09: when the in-Fastlane tooltip-capture
    // strategies above all return empty, fall back to a side-page
    // profile scan: open a fresh page on the producer's profile in
    // the SAME browser context (cookie-shared), walk each profile
    // tab, scrape inline validation errors. This bypasses the
    // popover entirely and surfaces the actual blocking field.
    let profileDiagnostic = ""
    if (!issueText && input.producerId) {
      profileDiagnostic = await diagnoseProducerProfile(
        ctx,
        input.producerId,
      ).catch((e) => {
        logger.warn({ err: e?.message }, "[Fastlane] profile diagnostic threw")
        return ""
      })
    }
    logger.warn(
      { issueText, profileDiagnostic },
      "[Fastlane] producer flagged with issue, no SELECT",
    )
    return {
      ok: false,
      reason:
        `Producer SELECT button not found for "${input.producerDisplayName}". ` +
        `Fastlane flagged producer with "N issues" — no SELECT button rendered. ` +
        (issueText
          ? `Issue: ${issueText}`
          : profileDiagnostic
            ? `Profile-scan: ${profileDiagnostic}`
            : "(could not capture issue tooltip nor profile-scan)"),
    }
  }
  logger.info({ producer: input.producerDisplayName }, "[Fastlane] clicking SELECT on producer card")
  await selectBtn.click().catch(() => undefined)
  await settle(page, 1500)
  await snapshot(ctx, "fastlane-02b-after-select")

  // Sydney 2026-05-07 04:30: bot clicked SELECT successfully (Sydney
  // appeared highlighted in the producer card area with a REMOVE
  // button, NEXT button became active), but the bot's existing flow
  // jumped straight to "ADD ALL" assuming the wizard auto-advanced
  // to the Carriers page. SureLC's Fastlane wizard requires an
  // explicit NEXT click between Step 1 (Producer) and Step 2
  // (Carriers). Without it, the bot stays on the Producer page
  // looking for an ADD ALL button that's only on the Carriers page.
  await clickNextSafe(ctx)
  await settle(page, 1500)
  await snapshot(ctx, "fastlane-03-step2-carriers")

  // ── Step 2 — Carriers: add ONLY the carriers the agent selected.
  //
  // Owner directive (general rule): NEVER "ADD ALL". Contract exactly
  // the carriers passed in `input.selectedCarriers` (the agent's own
  // selection from agent_carrier_contracting) — nothing more. The old
  // ADD-ALL behavior gave Gabriel Fernandez 4 carriers (Corebridge,
  // Occidental, American Amicable, NLG) he never picked.
  //
  // Each Fastlane carrier is a row in the "available" column with the
  // on-screen carrier name and an individual ADD button. We locate the
  // row for each selected carrier and click ITS ADD. Unselected
  // carriers stay in the available column and are never contracted.
  const selected = input.selectedCarriers ?? []
  if (selected.length === 0) {
    // Fail-safe: never fall back to ADD ALL. Adding none is strictly
    // safer than adding every carrier — a missing/empty selection is a
    // data problem upstream, not a reason to contract everything.
    logger.warn(
      "[Fastlane] no carriers in agent selection — adding NOTHING (refusing ADD ALL). Check that the pipeline sent contracting.carriers.",
    )
    await snapshot(ctx, "fastlane-04-carriers-no-selection")
  } else {
    const wanted = selected
      .map((c) => (c.carrierName || "").trim())
      .filter((n) => n.length > 0)
    logger.info(
      { wanted },
      `[Fastlane] adding ONLY ${wanted.length} selected carrier(s) (no ADD ALL)`,
    )
    const added: string[] = []
    const notFound: string[] = []
    for (const c of selected) {
      const name = (c.carrierName || "").trim()
      if (!name) continue
      const ok = await addSingleCarrier(ctx, name, c.carrierNaic)
      if (ok) added.push(name)
      else notFound.push(name)
      await settle(page, 500)
    }
    logger.info(
      { added, notFound },
      `[Fastlane] carrier selection done — added ${added.length}/${wanted.length}` +
        (notFound.length ? `, could not find: ${notFound.join(", ")}` : ""),
    )
    await snapshot(ctx, "fastlane-04-carriers-after-add-selected")
  }
  await clickNextSafe(ctx)

  // ── Step 3 — States: ensure every state checkbox is on for every
  //    carrier section. Default in SureLC is "all checked", so this
  //    is mostly a verification + safety net for any carrier where
  //    the rep doesn't have a state license (those checkboxes appear
  //    disabled and clicking them is a no-op).
  //
  // Kimberly 2026-05-25: previous sweep ran immediately after the NEXT
  // click into Step 3, before Angular finished hydrating per-carrier
  // state grids. Only the first-rendered grid (resident + 1 sibling)
  // got ticked; the rest sat at default (which for licensed-only-in-
  // a-few-states reps is empty). Fix: settle networkidle, scroll
  // through the whole wizard panel to force lazy carriers to mount,
  // sweep, then re-sweep once after another settle to catch any
  // last late mounts. Also try Material's wrapper labels via .click()
  // since `.check({ force: true })` no-ops on Angular Material mat-
  // checkbox components that proxy clicks via the parent label.
  await page
    .waitForLoadState("networkidle", { timeout: 15_000 })
    .catch(() => undefined)
  await settle(page, 1500)
  // Force lazy carrier-card mounts by scrolling top → bottom.
  await page.evaluate(() => {
    const scrollable =
      document.scrollingElement || document.documentElement || document.body
    scrollable.scrollTop = 0
  })
  await settle(page, 400)
  await page.evaluate(() => {
    const scrollable =
      document.scrollingElement || document.documentElement || document.body
    scrollable.scrollTop = scrollable.scrollHeight
  })
  await settle(page, 800)
  await page.evaluate(() => {
    const scrollable =
      document.scrollingElement || document.documentElement || document.body
    scrollable.scrollTop = 0
  })
  await settle(page, 600)
  await snapshot(ctx, "fastlane-05-step3-states")
  async function tickAllStateBoxes(label: string) {
    let toggled = 0
    let alreadyOn = 0
    let skipped = 0
    try {
      // .check({force:true}) is idempotent (no-op if already checked,
      // sets checked=true otherwise) so it's safe to call on every
      // visible checkbox. Iterate over native inputs — Material wraps
      // them in mat-checkbox+label but .check still routes through
      // Angular's event handlers correctly with force:true.
      const boxes = await page.$$('input[type="checkbox"]:not([disabled])')
      for (const cb of boxes) {
        try {
          const checked = await cb.isChecked()
          if (checked) {
            alreadyOn++
            continue
          }
          await cb.check({ force: true, timeout: 2000 })
          toggled++
        } catch {
          skipped++
        }
      }
    } catch (err: any) {
      logger.warn(`[Fastlane] state checkbox sweep (${label}) failed`, {
        err: err.message,
      })
    }
    logger.info(
      `[Fastlane] state checkbox sweep (${label}): toggled=${toggled} alreadyOn=${alreadyOn} skipped=${skipped}`,
    )
    return { toggled, alreadyOn, skipped }
  }
  await tickAllStateBoxes("first-pass")
  await settle(page, 1500)
  // Second pass — catches any carrier grid that lazy-mounted while
  // we were ticking the first batch (Angular CDK can defer rendering
  // virtualized rows until scroll triggers them).
  await tickAllStateBoxes("second-pass")
  await snapshot(ctx, "fastlane-06-states-after-check-all")
  await clickNextSafe(ctx)

  // ── Step 4 — Products: SureLC pre-checks the standard product
  //    set per carrier (Fixed Life by default). Verify all enabled
  //    checkboxes are on, then NEXT.
  await snapshot(ctx, "fastlane-07-step4-products")
  try {
    const checkboxes = await page.$$('input[type="checkbox"]:not([disabled])')
    for (const cb of checkboxes) {
      try {
        const checked = await cb.isChecked()
        if (!checked) await cb.check({ force: true })
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  await clickNextSafe(ctx)

  // ── Step 5 — Preview + SUBMIT.
  await settle(page, 1200)
  await snapshot(ctx, "fastlane-08-step5-preview")
  const submitBtn = await firstVisible(page, [
    'button:has-text("SUBMIT")',
    'button:has-text("Submit")',
    'button:has-text("Send")',
    'button:has-text("FINISH")',
    'button[type="submit"]',
  ])
  if (!submitBtn) {
    return { ok: false, reason: "Fastlane SUBMIT button not found on preview" }
  }
  await submitBtn.click().catch(() => undefined)
  await settle(page, 2500)
  await snapshot(ctx, "fastlane-09-after-submit")

  // Confirmation pattern.
  const confirm = await page.$(
    'text=/sent|submitted|requested|created|success/i',
  )
  if (confirm) return { ok: true }

  return {
    ok: true,
    reason: "Submitted but no explicit confirmation marker matched; check evidence screenshots",
  }
}

/**
 * Add ONE carrier on the Fastlane Carriers step by locating its row in
 * the available-carriers list and clicking that row's individual ADD
 * button (moving it into the Selected column). Never touches other
 * carriers.
 *
 * Matching strategy (robust to naming drift between our DB and the
 * on-screen SureLC label):
 *   1. Exact substring on the carrier name.
 *   2. Fuzzy: normalized (punct/case-insensitive) contains, using a
 *      distinctive prefix of the name.
 *   3. NAIC/carrier-id substring, if provided.
 *
 * Returns true if an ADD was clicked, false if the carrier row/button
 * couldn't be found (caller logs it as not-found — we do NOT fall back
 * to adding anything else).
 */
async function addSingleCarrier(
  ctx: TabContext,
  carrierName: string,
  carrierNaic?: string,
): Promise<boolean> {
  const { page, logger } = ctx

  // A Fastlane available-carrier entry is a list row containing the
  // carrier's name text and an ADD button/icon. We don't assume a
  // specific tag (SureLC has used <tr>, mat-list-item, and custom
  // <bga-*> cards across builds), so we search by "some container that
  // has the carrier name AND an ADD control" across a few likely
  // wrappers, then click the ADD control inside it.
  const containerSelectors = [
    "mat-row",
    "tr",
    "mat-list-item",
    ".viewport__item",
    '[class*="carrier"]',
    '[class*="row"]',
    "li",
  ]
  const addSelectors = [
    'button:has-text("ADD")',
    'button:has-text("Add")',
    'button[aria-label*="add" i]',
    'mat-icon:has-text("add")',
    'button:has(mat-icon:has-text("add"))',
  ]

  // Try exact name match first, then a fuzzy prefix, then NAIC.
  const nameCandidates = [carrierName]
  // A distinctive prefix (first 3 significant words) helps when the
  // on-screen name has extra suffixes ("Insurance Company", "- Independent
  // Order Of", etc.) our DB may abbreviate or omit.
  const words = carrierName.split(/\s+/).filter(Boolean)
  if (words.length > 3) nameCandidates.push(words.slice(0, 3).join(" "))
  const targetNorm = normalizeCarrier(carrierName)

  for (const container of containerSelectors) {
    for (const nameFrag of nameCandidates) {
      const rowSel = `${container}:has-text("${nameFrag.replace(/"/g, '\\"')}")`
      let rows: any[] = []
      try {
        rows = await page.$$(rowSel)
      } catch {
        rows = []
      }
      for (const row of rows) {
        // Guard against matching the "Selected" column or a header:
        // require a normalized-name overlap so we don't add the wrong
        // carrier when a fragment is ambiguous.
        const rowText = await row
          .evaluate((el: Element) => (el.textContent || "").trim())
          .catch(() => "")
        const rowNorm = normalizeCarrier(rowText)
        const overlaps =
          rowNorm.includes(targetNorm) ||
          targetNorm.includes(rowNorm) ||
          (words[0] && rowNorm.includes(normalizeCarrier(words[0])))
        if (!overlaps) continue
        for (const addSel of addSelectors) {
          const addBtn = await row.$(addSel).catch(() => null)
          if (addBtn) {
            const visible = await addBtn.isVisible().catch(() => false)
            if (!visible) continue
            try {
              await addBtn.click({ timeout: 3000 })
              logger.info(
                { carrierName, via: `${container} / ${addSel}` },
                "[Fastlane] clicked ADD for selected carrier",
              )
              return true
            } catch {
              /* try next selector */
            }
          }
        }
      }
    }
  }

  // NAIC/carrier-id fallback — some builds render the carrier id in the
  // row; search rows whose text contains it.
  if (carrierNaic) {
    for (const container of containerSelectors) {
      let rows: any[] = []
      try {
        rows = await page.$$(
          `${container}:has-text("${carrierNaic.replace(/"/g, '\\"')}")`,
        )
      } catch {
        rows = []
      }
      for (const row of rows) {
        for (const addSel of addSelectors) {
          const addBtn = await row.$(addSel).catch(() => null)
          if (addBtn && (await addBtn.isVisible().catch(() => false))) {
            try {
              await addBtn.click({ timeout: 3000 })
              logger.info(
                { carrierName, carrierNaic },
                "[Fastlane] clicked ADD for selected carrier (matched by NAIC)",
              )
              return true
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  }

  logger.warn(
    { carrierName, carrierNaic },
    "[Fastlane] could not find ADD control for selected carrier",
  )
  return false
}

async function clickNextSafe(ctx: TabContext): Promise<void> {
  const { page } = ctx
  const next = await firstVisible(page, [
    'button:has-text("NEXT")',
    'button:has-text("Next")',
    'button:has-text("Continue")',
  ])
  if (next) {
    try {
      await next.click()
      await settle(page, 1200)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Open a side-page on the producer's profile and scrape inline
 * validation errors from each tab. Used when Fastlane's "N issues"
 * popover can't be captured — gives the operator (and the bot's
 * future retry logic) a structured list of what to fix.
 *
 * Side-page lives in the same browser context, so cookies/JWT are
 * shared. The active Fastlane page state is preserved.
 *
 * Returns a string like:
 *   "[eno] Policy expired | [signature] Required"
 * or "" if nothing flagged anywhere.
 */
async function diagnoseProducerProfile(
  ctx: TabContext,
  producerId: string,
): Promise<string> {
  const browserCtx = ctx.page.context()
  const sidePage = await browserCtx.newPage()
  try {
    sidePage.setDefaultTimeout(20_000)
    const tabs = [
      "profile",
      "dba",
      "finra",
      "questions",
      "training",
      "eno",
      "signature",
    ]
    const findings: string[] = []
    for (const tab of tabs) {
      try {
        await sidePage.goto(
          `https://surelc.surancebay.com/bga/producers/${producerId}/${tab}`,
          { waitUntil: "domcontentloaded", timeout: 15_000 },
        )
        // Angular SPA: wait for content
        await sidePage.waitForTimeout(2500)
        // Scrape inline validation markers — each tab uses Material's
        // mat-error / aria-invalid + sometimes custom .error / .invalid
        // classes. Filter to short visible strings.
        const items = await sidePage
          .$$eval(
            "mat-error, .mat-error, [aria-invalid='true'], .invalid-feedback, .error-message, sb-error",
            (els) =>
              els
                .map((e) => (e as HTMLElement).innerText || "")
                .map((t) => t.replace(/\s+/g, " ").trim())
                .filter((t) => t.length > 3 && t.length < 200),
          )
          .catch(() => [] as string[])
        // Also check for tab-level red-dot indicator on the navbar
        // (some tabs render the warning as an icon, not text). Narrowed
        // to elements that ALSO have meaningful text content — pure
        // .warn classes with no content are noise (every Material page
        // has dozens). Demetrius 2026-05-09: untrimmed match returned
        // 5+ "warn-marker" placeholders that buried the real issues.
        const tabBadge = await sidePage
          .$$eval(
            `mat-icon[color="warn"]:not(:empty), .has-error:not(:empty), [class*="error-banner"]:not(:empty)`,
            (els) =>
              els
                .map((e) => (e as HTMLElement).innerText || "")
                .map((t) => t.replace(/\s+/g, " ").trim())
                .filter((t) => t.length > 8 && t.length < 200),
          )
          .catch(() => [] as string[])
        // Find any visible "Server error", "unavailable", "Login failed"
        // banner anywhere on the tab — these are often top-level alerts
        // not inside a mat-error.
        const errorBanner = await sidePage
          .$$eval("body", (els) => {
            const txt = els[0]?.innerText || ""
            const matches: string[] = []
            for (const m of txt.matchAll(
              /(Server error[^.\n]{0,120}\.?|HTTP code \d{3}|[A-Z][\w\s,]{0,40}is unavailable[^.\n]{0,80}\.?|Login failed[^.\n]{0,120}\.?|Please try (?:later|again)[^.\n]{0,80}\.?)/g,
            )) {
              matches.push(m[1])
              if (matches.length >= 4) break
            }
            return matches
          })
          .catch(() => [] as string[])
        const seen = new Set<string>()
        for (const t of [...items, ...tabBadge, ...errorBanner]) {
          if (seen.has(t)) continue
          seen.add(t)
          findings.push(`[${tab}] ${t}`)
          if (findings.length >= 12) break
        }
        if (findings.length >= 12) break
      } catch {
        /* skip tab if it fails to load — diagnostic is best-effort */
      }
    }
    return findings.join(" | ").slice(0, 600)
  } finally {
    await sidePage.close().catch(() => undefined)
  }
}
