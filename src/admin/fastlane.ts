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

import type { Locator, Page } from "playwright"
import {
  type TabContext,
  type TabResult,
  firstVisible,
  gotoBga,
  settle,
  snapshot,
} from "../tabs/helpers.js"
import {
  type ExpectedProducerIdentity,
  type FastlaneCardInfo,
  PRODUCER_AMBIGUOUS,
  PRODUCER_IDENTITY_UNVERIFIED,
  PRODUCER_NOT_FOUND,
  decideProducerCard,
  emailsInText,
  identitySearchTerms,
  nameTokensMatch,
} from "./producerIdentity.js"
import {
  findOneProducerManyCarriersStart,
  readPreview,
  readSelectedCarrierNames,
  readSelectedCount,
  readSubmitDialog,
  visibleValidationText,
  waitForWizardStep,
} from "./fastlaneUi.js"

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
  /**
   * What SureLC's own record for `producerId` says the producer's card must
   * show (email, name), read by the orchestrator before Fastlane opens —
   * see producerIdentity.ts. REQUIRED in practice: without it the wizard
   * refuses to select anyone (`producer_identity_unverified`).
   */
  expectedIdentity?: ExpectedProducerIdentity
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

/**
 * Short DB codes → on-screen SureLC Fastlane labels (and NAIC when known).
 * agent_carrier_contracting.carrierName is often a short code ("UHL") while
 * Fastlane renders the full legal name ("United Home Life…"). Without these
 * aliases, addSingleCarrier looks for text "UHL" and finds nothing — Tangela
 * Collins-Myers 2026-07-26: missing UHL, added 0/1, then SUBMIT not found
 * because NEXT stayed on the empty Carriers step.
 */
const CARRIER_ALIASES: Record<
  string,
  { names: string[]; naic?: string }
> = {
  uhl: {
    names: [
      "United Home Life",
      "United Homelife",
      "United Home Life Insurance",
      "UHL",
    ],
    // United Home Life Insurance Company — NAIC used by SureLC item ids.
    naic: "69922",
  },
  "f&g": {
    names: ["Fidelity & Guaranty", "Fidelity and Guaranty", "F&G", "FGL"],
  },
  f_and_g: {
    names: ["Fidelity & Guaranty", "Fidelity and Guaranty", "F&G", "FGL"],
  },
  fg: {
    names: ["Fidelity & Guaranty", "Fidelity and Guaranty", "F&G", "FGL"],
  },
  sbli: {
    names: ["SBLI", "Savings Bank Life", "Quility Term"],
  },
  foresters: {
    names: ["Foresters", "Independent Order Of Foresters"],
  },
  americo: {
    names: ["Americo"],
  },
  transamerica: {
    names: ["Transamerica"],
  },
  "american amicable": {
    names: ["American Amicable"],
  },
  centrian: {
    names: ["Centrian"],
  },
  nlg: {
    names: ["National Life Group", "NLG"],
  },
  "mutual of omaha": {
    names: ["Mutual of Omaha"],
  },
}

/**
 * Expand a DB carrier name into all label fragments we should try on-screen.
 *
 * Our `carriers.name` values carry decoration that SureLC's Fastlane list
 * does not: "National Life Group (NLG) (Independent)", "Banner Life
 * (Quility)", "SBLI (Quility Term)", "Transamerica Life Ins Co (Brokerage)".
 * Fastlane renders the plain legal name.
 *
 * The alias table below is keyed on the SHORT code ("nlg", "uhl"), which
 * only ever matched when the DB happened to store the short code too. For a
 * decorated long name the key is "national life group nlg independent",
 * CARRIER_ALIASES has no such entry, and the only candidate tried was the
 * raw decorated string — which cannot match anything on screen. That is why
 * NLG accounted for 10 of the 56 contracts still unsubmitted on 2026-08-21,
 * one per rep, on reps whose runs otherwise succeeded. Thomas spotted it
 * from the other end: "je crois que faut juste cocher independent".
 *
 * So try, in order: the raw name; the name with parenthetical/trailing
 * qualifiers stripped; and any alias whose key or names appear as whole
 * words inside the normalised name.
 */
export function expandCarrierNames(carrierName: string): string[] {
  const raw = (carrierName || "").trim()
  if (!raw) return []
  const key = normalizeCarrier(raw)
  const out: string[] = [raw]
  const push = (n: string) => {
    const v = (n || "").trim()
    if (v.length > 1 && !out.some((x) => normalizeCarrier(x) === normalizeCarrier(v))) {
      out.push(v)
    }
  }

  // Undecorated form: drop "(…)" groups and anything after a " - ".
  const undecorated = raw.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim()
  push(undecorated)
  const beforeDash = undecorated.split(/\s+-\s+/)[0]
  push(beforeDash)

  // Alias by exact key (unchanged), then by whole-word containment so a
  // decorated name still finds its short code.
  const tokens = new Set(key.split(" "))
  const alias =
    CARRIER_ALIASES[key] ||
    CARRIER_ALIASES[raw.toLowerCase()] ||
    Object.entries(CARRIER_ALIASES).find(
      ([k, v]) =>
        tokens.has(k) ||
        k.split(" ").every((w) => tokens.has(w)) ||
        v.names.some((n) =>
          normalizeCarrier(n)
            .split(" ")
            .every((w) => tokens.has(w)),
        ),
    )?.[1]
  if (alias) for (const n of alias.names) push(n)
  return out
}

function aliasNaic(carrierName: string): string | undefined {
  const key = normalizeCarrier(carrierName || "")
  return CARRIER_ALIASES[key]?.naic
}

const FASTLANE_URL = "https://surelc.surancebay.com/bga/fastlane"

/**
 * What Fastlane returns when the backoffice sent no carriers. Nothing is
 * submitted (never ADD ALL — only the rep's own choice is contracted), and
 * the reason says whose move it is instead of blaming a missing button.
 */
export const NO_CARRIER_SELECTION_REASON =
  "No carriers selected for this rep — nothing to submit. The rep has not completed " +
  "Request Carrier Contracts yet; Fastlane was not walked past the Carriers step."

export function noCarrierSelectionResult(): TabResult {
  return {
    ok: false,
    reason: NO_CARRIER_SELECTION_REASON,
    details: { added: [], notFound: [], noCarrierSelection: true },
  }
}

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
  //
  // 2026-10-05 redesign: the tile is a <bga-mass-contracting-action-link>
  // whose START REQUEST button opens the wizard. Its words have no spaces in
  // the DOM, so the old text=/One Producer.*Multiple Carriers/ matched
  // nothing, and the Data Express tile ("SEND UPDATES") carries the same two
  // phrases. findOneProducerManyCarriersStart accepts exactly one tile.
  const startBtn = await findOneProducerManyCarriersStart(page, 20_000)
  if (!startBtn) {
    return { ok: false, reason: "Fastlane 'One Producer Many Carriers' tile not found" }
  }
  await startBtn.click({ timeout: 8_000 }).catch(async () => {
    await startBtn.evaluate((el: HTMLElement) => el.click()).catch(() => undefined)
  })
  await settle(page, 1500)
  // Wait for the wizard (URL /bga/fastlane/multiCarriers/... and the step nav).
  await waitForWizardStep(page, "producer", 15_000)

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

  // ── Step 1 — Producer search + SELECT, by POSITIVE identification only.
  //
  // Fastlane's list is virtualised (Angular CDK renders only the cards in the
  // viewport), so the Search box narrows it first. The Material input has no
  // placeholder/aria-label — just a <mat-label>Search</mat-label> sibling
  // (Josue 2026-05-08) — hence the Material-aware lookup.
  //
  // Which card is OUR producer is decided by decideProducerCard
  // (producerIdentity.ts), never by the name alone: the card must print the
  // email SureLC holds for producerId, be the only card that does, and carry
  // SureLC's own name for producerId (whole-token surname). A
  // <bga-producer-card> carries no producer id and no NPN — the email is the
  // only identifier on it — which is why the id check added after the Murray
  // incident never fired: it found no id on 20 of 20 clicks and clicked
  // anyway, and on 2026-10-01/02 filed Carlos Tovar's 22 requests on
  // "NUNEZ-TOVAR, CARLOS EDUARDO, SR." (5861981).
  // docs/2026-10-02-fastlane-wrong-producer-carlos-tovar.md
  const expected = input.expectedIdentity ?? null
  if (!expected) {
    const d = decideProducerCard([], null)
    logger.error(
      { producerId: input.producerId, name: input.producerDisplayName },
      "[Fastlane] REFUSING — no verified SureLC identity was supplied for this producer",
    )
    return { ok: false, code: PRODUCER_IDENTITY_UNVERIFIED, reason: (d as any).reason }
  }

  const search =
    (await firstVisible(page, [
      // 2026-10-05: <sb-search-filter><mat-form-field><input placeholder="Search">
      "sb-search-filter input",
      'input[placeholder="Search"]',
    ])) ||
    (await page.$('mat-label:has-text("Search") >> xpath=ancestor::*[self::mat-form-field][1] >> input').catch(() => null)) ||
    (await firstVisible(page, [
      'input[placeholder*="search" i]',
      'input[type="search"]',
      'input[aria-label*="search" i]',
    ]))
  if (!search) logger.warn("[Fastlane] producer search input not found — judging the cards already rendered")

  const terms = search ? identitySearchTerms(expected, input.producerDisplayName) : [""]
  const severity: Record<string, number> = {
    [PRODUCER_NOT_FOUND]: 1,
    [PRODUCER_IDENTITY_UNVERIFIED]: 2,
    [PRODUCER_AMBIGUOUS]: 3,
  }
  let chosen: { el: any; info: FastlaneCardInfo } | null = null
  let refusal: { code: string; reason: string } | null = null
  for (const term of terms) {
    if (search && term) {
      try {
        await (search as any).click()
        await (search as any).fill("")
        await (search as any).fill(term)
        // Some Material search inputs commit on Enter, others debounce.
        await (search as any).press("Enter").catch(() => undefined)
        await page.waitForTimeout(3_000)
      } catch (err: any) {
        logger.warn({ err: err?.message, term }, "[Fastlane] search fill failed")
        continue
      }
    }
    const cardEls = await page.$$("bga-producer-card")
    const raw = await Promise.all(
      cardEls.map((c) =>
        c
          .evaluate((el) => ({
            name: ((el.querySelector(".producer__name") as HTMLElement | null)?.textContent || "")
              .replace(/\s+/g, " ")
              .trim(),
            text: (el.textContent || "").replace(/\s+/g, " ").trim(),
          }))
          .catch(() => ({ name: "", text: "" })),
      ),
    )
    const infos: FastlaneCardInfo[] = raw.map((r) => ({
      name: r.name || r.text.split(",").slice(0, 2).join(","),
      emails: emailsInText(r.text),
    }))
    const d = decideProducerCard(infos, expected)
    logger.info(
      { term, producerId: expected.producerId, cards: infos, decision: d.ok ? "match" : d.code },
      "[Fastlane] producer search judged",
    )
    if (d.ok) {
      chosen = { el: cardEls[d.index], info: infos[d.index] }
      break
    }
    if (!refusal || (severity[d.code] ?? 0) > (severity[refusal.code] ?? 0)) {
      refusal = { code: d.code, reason: d.reason }
    }
    // Two cards with this producer's email is a finding, not a search miss.
    if (d.code === PRODUCER_AMBIGUOUS) break
  }
  await snapshot(ctx, "fastlane-02b-after-search")

  if (!chosen) {
    await snapshot(ctx, "fastlane-02a-producer-unverified")
    logger.error(
      { producerId: expected.producerId, want: expected.displayName, emails: expected.emails, refusal },
      "[Fastlane] REFUSING to select — no card is positively this producer",
    )
    return {
      ok: false,
      code: refusal?.code ?? PRODUCER_NOT_FOUND,
      reason: refusal?.reason ?? `[${PRODUCER_NOT_FOUND}] No producer card rendered. Nothing was filed.`,
    }
  }

  const producerCard = chosen.el
  const selectBtn: any = await producerCard.$('button:has-text("SELECT")')
  if (!selectBtn) {
    // Card IS there but carries no SELECT button — Fastlane has flagged the
    // producer as having unresolved issues. Click the "N issues" popover
    // trigger to
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
          .evaluate((c: Element) => (c.textContent || "").replace(/\s+/g, " ").trim())
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
  logger.info(
    { producerId: expected.producerId, card: chosen.info },
    "[Fastlane] card positively identified (email + name) — clicking SELECT",
  )

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
  const toCarriers = await advanceTo(ctx, "carriers")
  await settle(page, 1500)
  await snapshot(ctx, "fastlane-03-step2-carriers")
  if (toCarriers) return toCarriers

  // Second look, before any carrier is added: the Carriers step names the
  // producer the wizard is holding (<bga-producer-name>). If it names someone
  // else, stop here — nothing has been filed yet. An empty read is logged, not
  // fatal: the card was already identified by email above.
  const heldName = await page
    .$eval("bga-producer-name", (el) => (el.textContent || "").replace(/\s+/g, " ").trim())
    .catch(() => "")
  if (heldName && !nameTokensMatch(heldName, chosen.info.name)) {
    await snapshot(ctx, "fastlane-03a-wizard-holds-other-producer")
    logger.error(
      { producerId: expected.producerId, selected: chosen.info.name, wizardHolds: heldName },
      "[Fastlane] REFUSING — the wizard holds a different producer than the card we selected",
    )
    return {
      ok: false,
      code: PRODUCER_IDENTITY_UNVERIFIED,
      reason:
        `[${PRODUCER_IDENTITY_UNVERIFIED}] Selected "${chosen.info.name}" (producer ${expected.producerId}) but ` +
        `Fastlane's Carriers step names "${heldName}". Stopped before adding any carrier. Nothing was filed.`,
    }
  }
  if (!heldName) logger.warn("[Fastlane] could not read <bga-producer-name> on the Carriers step")

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
  // Hoisted so every later return can report what was actually added — the
  // backoffice used to be told "all-via-fastlane" for runs that added nothing.
  const added: string[] = []
  const notFound: string[] = []
  if (selected.length === 0) {
    // Fail-safe: never fall back to ADD ALL. Adding none is strictly
    // safer than adding every carrier — a missing/empty selection is a
    // data problem upstream, not a reason to contract everything.
    logger.warn(
      "[Fastlane] no carriers in agent selection — adding NOTHING (refusing ADD ALL). Check that the pipeline sent contracting.carriers.",
    )
    await snapshot(ctx, "fastlane-04-carriers-no-selection")
    // And stop here. NEXT cannot leave the Carriers step with an empty cart,
    // so walking on to States / Products / Preview only ever ended in
    // "Fastlane SUBMIT button not found on preview (visible CTAs: search |
    // ADD ALL | ADD | … | REMOVE ALL | CANCEL | PREVIOUS | NEXT)" — which
    // reads as a SureLC page change and sent people looking for one.
    // Jermaine Watkins (3024058), Jairo Cabrera Rojas, Alfred Nickson Jr,
    // 2026-09-30: every one of them simply had not picked carriers yet.
    // docs/2026-09-30-fastlane-no-carrier-selection.md
    return noCarrierSelectionResult()
  } else {
    const wanted = selected
      .map((c) => (c.carrierName || "").trim())
      .filter((n) => n.length > 0)
    logger.info(
      { wanted },
      `[Fastlane] adding ONLY ${wanted.length} selected carrier(s) (no ADD ALL)`,
    )
    // The available list loads asynchronously ("Loading available items...").
    await page
      .waitForFunction(
        () =>
          document.querySelector('[id^="item-"]') !== null ||
          /No available items|Nothing found/i.test(document.body?.innerText || ""),
        undefined,
        { timeout: 20_000 },
      )
      .catch(() => undefined)
    for (const c of selected) {
      const name = (c.carrierName || "").trim()
      if (!name) continue
      // Prefer explicit NAIC from the pipeline; fall back to known aliases
      // (UHL → 69922) when the carriers.sureLcCarrierId row is null.
      const naic = (c.carrierNaic || "").trim() || aliasNaic(name)
      const ok = await addSingleCarrier(ctx, name, naic)
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

    // If we wanted carriers and added ZERO, do not walk States/Products/
    // Preview — NEXT may stay disabled and the old path lied with
    // "SUBMIT button not found". Diagnose: is the carrier simply not
    // offered in this BGA's Fastlane grid (UHL for S4L LOA, 2026-07-26
    // Tangela) vs a locator bug?
    if (wanted.length > 0 && added.length === 0) {
      let availableNames: string[] = []
      try {
        availableNames = await page.evaluate(() => {
          const items = Array.from(
            document.querySelectorAll(
              '.items__item .item__line1, .item .item__line1',
            ),
          )
          const names = items
            .map((el) =>
              ((el as HTMLElement).innerText || el.textContent || "")
                .split("\n")[0]
                .trim(),
            )
            .filter((t) => t.length > 0)
          // de-dupe preserve order
          return Array.from(new Set(names))
        })
      } catch {
        availableNames = []
      }
      const availableSample = availableNames.slice(0, 20).join(" | ")
      const availableNorm = availableNames.map(normalizeCarrier)

      const unavailable: string[] = []
      const maybeUiMiss: string[] = []
      for (const name of notFound) {
        const candidates = expandCarrierNames(name).map(normalizeCarrier)
        const inGrid = candidates.some((c) =>
          availableNorm.some(
            (a) =>
              a.includes(c) ||
              c.includes(a) ||
              c
                .split(" ")
                .filter((w) => w.length > 2)
                .every((w) => a.includes(w)),
          ),
        )
        if (inGrid) maybeUiMiss.push(name)
        else unavailable.push(name)
      }

      // All missing carriers simply aren't offered on Fastlane for this
      // BGA (e.g. United Home Life not in S4L LOA's available list).
      // Don't fail Phase A / admin_setup_partial — the rest of the
      // portfolio is already submitted; UHL needs a manual/alternate
      // path. Returning ok keeps the agent advancing.
      if (unavailable.length === notFound.length && unavailable.length > 0) {
        logger.warn(
          { unavailable, availableSample },
          "[Fastlane] selected carrier(s) not offered in Fastlane available list — skipping (not a bot failure)",
        )
        return {
          ok: true,
          skipped: true,
          skipReason: `Fastlane does not offer: ${unavailable.join(", ")} — needs manual/alternate contracting`,
          reason: `Skipped Fastlane — carrier(s) not available in BGA Fastlane grid: ${unavailable.join(", ")}`,
          details: { added, notFound },
        }
      }

      return {
        ok: false,
        reason:
          `Fastlane could not ADD selected carrier(s): ${notFound.join(", ")}` +
          (unavailable.length
            ? ` [not in grid: ${unavailable.join(", ")}]`
            : "") +
          (maybeUiMiss.length
            ? ` [in grid but ADD missed: ${maybeUiMiss.join(", ")}]`
            : "") +
          (availableSample ? ` (available: ${availableSample})` : ""),
      }
    }
  }
  // Fail closed BEFORE leaving the Carriers step: the cart must hold exactly
  // the carriers we added, nothing else (never ADD ALL, never a stray row).
  const cartCheck = await verifyCart(ctx, added, selected)
  if (cartCheck) return cartCheck
  const toStates = await advanceTo(ctx, "states")
  if (toStates) return { ...toStates, details: { added, notFound } }

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
  const toProducts = await advanceTo(ctx, "products")
  if (toProducts) return { ...toProducts, details: { added, notFound } }

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
  const toPreview = await advanceTo(ctx, "preview")
  if (toPreview) return { ...toPreview, details: { added, notFound } }

  // ── Step 5 — Preview + SUBMIT.
  //
  // 2026-10-05: the last wizard step is "Preview" ("Contracting Request
  // Preview": producer, sending email, "Carriers (N)"). SUBMIT replaces NEXT
  // there and is disabled until the step validates (valid Sending Email).
  await page
    .waitForLoadState("networkidle", { timeout: 15_000 })
    .catch(() => undefined)
  await settle(page, 1500)

  // Scroll the wizard panel so a sticky/footer SUBMIT is in the DOM viewport.
  await page.evaluate(() => {
    const scrollable =
      document.scrollingElement || document.documentElement || document.body
    scrollable.scrollTop = scrollable.scrollHeight
  }).catch(() => undefined)
  await settle(page, 400)
  await snapshot(ctx, "fastlane-08-step5-preview")

  // Second look at the producer and the cart, on the page that is about to be
  // submitted. "Sending Email" defaults to the selected producer's email, so it
  // must be one of the emails SureLC holds for producerId; "Carriers (N)" must
  // be exactly what we added. Anything else: stop, nothing is filed.
  const preview = await readPreview(page)
  const knownEmails = new Set([...expected.emails, ...chosen.info.emails].map((e) => e.toLowerCase()))
  if (preview.sendingEmail && !knownEmails.has(preview.sendingEmail.toLowerCase())) {
    await snapshot(ctx, "fastlane-08a-preview-wrong-email")
    logger.error(
      { producerId: expected.producerId, previewEmail: "(redacted)", known: knownEmails.size },
      "[Fastlane] REFUSING — Preview's Sending Email is not this producer's email",
    )
    return {
      ok: false,
      code: PRODUCER_IDENTITY_UNVERIFIED,
      reason:
        `[${PRODUCER_IDENTITY_UNVERIFIED}] Fastlane's Preview names a Sending Email that is not an email SureLC ` +
        `holds for producer ${expected.producerId}. Stopped before SUBMIT. Nothing was filed.`,
      details: { added, notFound },
    }
  }
  if (!preview.sendingEmail) logger.warn("[Fastlane] could not read the Sending Email on Preview")
  if (preview.carriersCount !== null && preview.carriersCount !== added.length) {
    await snapshot(ctx, "fastlane-08b-preview-carrier-count")
    logger.error(
      { previewCount: preview.carriersCount, added: added.length },
      "[Fastlane] REFUSING — Preview lists a different number of carriers than we added",
    )
    return {
      ok: false,
      reason:
        `Fastlane's Preview lists ${preview.carriersCount} carrier(s) but the agent selected ${added.length} ` +
        `(${added.join(", ")}). Stopped before SUBMIT. Nothing was filed.`,
      details: { added, notFound },
    }
  }
  if (preview.carriersCount === null) logger.warn("[Fastlane] could not read 'Carriers (N)' on Preview")

  // SUBMIT: a real <button> named SUBMIT, enabled by SureLC itself. Never
  // force-enabled — a disabled SUBMIT means the step is invalid, and clicking
  // it anyway would file an invalid request.
  const submitBtn = await findSubmitButton(page, 20_000)
  if (!submitBtn) {
    const visibleLabels = (
      await page
        .evaluate(() =>
          Array.from(document.querySelectorAll("button, a[role='button'], [role='button']"))
            .filter((el) => {
              const st = window.getComputedStyle(el as Element)
              return st.display !== "none" && st.visibility !== "hidden"
            })
            .map((el) => ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 40))
            .filter((t) => t.length > 0)
            .slice(0, 20)
            .join(" | "),
        )
        .catch(() => "")
    ).trim()
    logger.warn({ visibleLabels }, "[Fastlane] SUBMIT button not found on preview after retries")
    return {
      ok: false,
      reason: `Fastlane SUBMIT button not found on preview${visibleLabels ? ` (visible CTAs: ${visibleLabels})` : ""}`,
    }
  }
  if (!(await waitEnabled(submitBtn, 10_000))) {
    const why = await visibleValidationText(page)
    await snapshot(ctx, "fastlane-08c-submit-disabled")
    return {
      ok: false,
      reason: `Fastlane SUBMIT is disabled on preview — SureLC considers the request incomplete${why ? ` (${why})` : ""}. Nothing was filed.`,
      details: { added, notFound },
    }
  }

  await submitBtn.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined)
  await submitBtn.click({ timeout: 5000 })
  await settle(page, 1500)
  await snapshot(ctx, "fastlane-09-after-submit")

  // SUBMIT posts the request from a "Processing Contracting Requests" dialog
  // that lists one row per carrier (success / error) and then shows DONE.
  // Wait for it so a carrier-level rejection is reported, not lost. If the
  // results never finish (they arrive over a websocket), the request has still
  // been posted — botRunner's post-submit verification is then the judge.
  let dlg = await readSubmitDialog(page)
  for (let i = 0; i < 80 && !dlg.done; i++) {
    if (!dlg.open && i >= 6) break
    await page.waitForTimeout(1500)
    dlg = await readSubmitDialog(page)
  }
  await snapshot(ctx, "fastlane-10-submit-results")
  if (!dlg.open) {
    return {
      ok: false,
      reason: "Fastlane SUBMIT was clicked but the 'Processing Contracting Requests' dialog never appeared; nothing confirms a filing",
      details: { added, notFound },
    }
  }
  if (dlg.done) {
    const doneBtn = page.getByRole("button", { name: /^\s*done\s*$/i })
    await doneBtn.first().click({ timeout: 3000 }).catch(() => undefined)
  }
  logger.info({ done: dlg.done, ok: dlg.ok, failed: dlg.failed }, "[Fastlane] submit results")
  if (dlg.failed.length > 0) {
    return {
      ok: false,
      reason:
        "Fastlane SUBMIT reported errors: " +
        dlg.failed.map((f) => `${f.carrier || "(carrier)"}: ${f.error || "error"}`).join(" | "),
      details: { added, notFound, submitOk: dlg.ok, submitFailed: dlg.failed },
    }
  }
  if (dlg.done) return { ok: true, details: { added, notFound, submitOk: dlg.ok } }
  return {
    ok: true,
    reason: "Submitted but SureLC's results dialog did not finish; check evidence screenshots",
    details: { added, notFound },
  }
}

/** The enabled-or-not SUBMIT button of the last wizard step, by role and name. */
async function findSubmitButton(page: Page, timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs
  do {
    for (const name of [/^\s*submit\s*$/i, /^\s*(submit|send request|finish)\b/i]) {
      const loc = page.getByRole("button", { name })
      const n = await loc.count().catch(() => 0)
      for (let i = 0; i < n; i++) {
        if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i)
      }
    }
    await page.waitForTimeout(1000)
  } while (Date.now() < deadline)
  return null
}

async function waitEnabled(loc: Locator, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  do {
    if (await loc.isEnabled().catch(() => false)) return true
    await new Promise((r) => setTimeout(r, 500))
  } while (Date.now() < deadline)
  return false
}

/**
 * Click NEXT and confirm the wizard reached `to` ("carriers" | "states" |
 * "products" | "preview"). Returns null on success (or when the step nav
 * cannot be read — legacy behaviour), otherwise a failure result that says
 * which step it stayed on and what SureLC's validation printed.
 */
async function advanceTo(ctx: TabContext, to: string): Promise<TabResult | null> {
  const { page, logger } = ctx
  await clickNextSafe(ctx)
  let r = await waitForWizardStep(page, to, 10_000)
  if (!r.reached && r.active !== null) {
    logger.warn({ to, active: r.active }, "[Fastlane] wizard did not advance — clicking NEXT once more")
    await clickNextSafe(ctx)
    r = await waitForWizardStep(page, to, 8_000)
  }
  if (r.reached || r.active === null) return null
  const why = await visibleValidationText(page)
  await snapshot(ctx, `fastlane-stuck-before-${to}`)
  return {
    ok: false,
    reason:
      `Fastlane stayed on the "${r.active}" step after NEXT (expected "${to}")` +
      (why ? `: ${why}` : "") +
      ". Nothing was filed.",
  }
}

/**
 * The Carriers step's cart must hold exactly the carriers we clicked ADD on:
 * its "Selected (N)" counter equals the number added, and every Selected row
 * is one of the agent's carriers. Anything else fails closed before NEXT.
 */
async function verifyCart(
  ctx: TabContext,
  added: string[],
  selected: Array<{ carrierName: string; carrierNaic?: string }>,
): Promise<TabResult | null> {
  const { page, logger } = ctx
  const count = await readSelectedCount(page)
  const names = await readSelectedCarrierNames(page)
  const wanted = selected.flatMap((c) => expandCarrierNames(c.carrierName).map(normalizeCarrier)).filter(Boolean)
  const stray = names.filter((n) => {
    const nn = normalizeCarrier(n)
    return !wanted.some(
      (w) =>
        nn.includes(w) ||
        w.includes(nn) ||
        w.split(" ").filter((t) => t.length > 2).every((t) => nn.includes(t)),
    )
  })
  logger.info({ count, names, added }, "[Fastlane] cart check")
  // Names are advisory (an id-based ADD may show SureLC's legal name, which
  // our DB spelling need not resemble); the counter is the hard gate.
  if (stray.length > 0) logger.warn({ stray }, "[Fastlane] a Selected row does not resemble any carrier the agent picked")
  if (count !== null && count !== added.length) {
    await snapshot(ctx, "fastlane-04a-cart-mismatch")
    logger.error({ count, names, added, stray }, "[Fastlane] REFUSING — the cart does not match the agent's selection")
    return {
      ok: false,
      reason:
        `Fastlane's cart holds ${count ?? names.length} carrier(s) [${names.join(", ")}] but the agent selected ` +
        `${added.length} [${added.join(", ")}]. Stopped before NEXT. Nothing was filed.`,
      details: { added, notFound: [] },
    }
  }
  return null
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
  if (await addSingleCarrierInDom(ctx, carrierName, carrierNaic)) return true
  // The available list is a virtual scroll: only the rows near the viewport
  // exist in the DOM. Narrow it with the step's own "Search by Carrier name"
  // filter (client-side, changes nothing in SureLC) and look again.
  const { page, logger } = ctx
  const search = await firstVisible(page, [
    'bga-step-carriers sb-search-filter input',
    'input[placeholder*="Search by Carrier" i]',
  ])
  if (!search) return false
  const terms = Array.from(
    new Set(
      expandCarrierNames(carrierName)
        .map((n) => n.split(/\s+/).slice(0, 2).join(" "))
        .filter((n) => n.length > 2),
    ),
  ).slice(0, 4)
  try {
    for (const term of terms) {
      await (search as any).fill(term)
      await page.waitForTimeout(1000) // the step debounces the filter by 300ms
      if (await addSingleCarrierInDom(ctx, carrierName, carrierNaic)) {
        logger.info({ carrierName, term }, "[Fastlane] found the carrier through the step's search filter")
        return true
      }
    }
  } finally {
    await (search as any).fill("").catch(() => undefined)
    await page.waitForTimeout(600)
  }
  return false
}

async function addSingleCarrierInDom(
  ctx: TabContext,
  carrierName: string,
  carrierNaic?: string,
): Promise<boolean> {
  const { page, logger } = ctx

  // SureLC's Fastlane "Step 2 — Carriers" (2026-07 rebuild) renders each
  // available carrier as:
  //   <div class="items__item item" id="item-<NAIC>">
  //     <div class="item__left">
  //       <div class="item__line1">Carrier Name</div> …
  //     </div>
  //     <button class="item__select-button">ADD</button>
  //   </div>
  // The prior markup this bot scanned (mat-row / tr / mat-list-item /
  // [class*="row"]) is GONE — none of those match `div.items__item.item`,
  // so the old code silently added 0 carriers, left NEXT disabled, and
  // stalled every activation at admin_setup_partial fleet-wide (2026-07-10
  // onward). Two robust locators now:
  //   1. `#item-<NAIC>` — the row id carries the carrier's NAIC. Exact,
  //      language/label-proof. Primary path.
  //   2. Carrier-name text inside `.items__item` / `.item`. Fallback.
  // Adding a carrier moves its row into the Selected column and swaps
  // ADD→REMOVE, so we only ever click a button whose text is ADD.

  const clickAddInRow = async (row: any, via: string): Promise<boolean> => {
    await row.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined)
    const addSelectors = [
      'button.item__select-button:has-text("ADD")',
      'button.item__select-button',
      'button:has-text("ADD")',
      'button:has-text("Add")',
      'button[aria-label*="add" i]',
      'button:has(mat-icon:has-text("add"))',
    ]
    for (const addSel of addSelectors) {
      const addBtn = await row.$(addSel).catch(() => null)
      if (!addBtn) continue
      if (!(await addBtn.isVisible().catch(() => false))) continue
      // Never click a REMOVE control (an already-selected row reuses the
      // same button class with different text).
      const btnText = (
        await addBtn
          .evaluate((el: Element) => (el.textContent || "").trim())
          .catch(() => "")
      ).toUpperCase()
      if (btnText.includes("REMOVE")) continue
      try {
        await addBtn.click({ timeout: 3000 })
        logger.info(
          { carrierName, via: `${via} / ${addSel}` },
          "[Fastlane] clicked ADD for selected carrier",
        )
        await settle(page, 400)
        return true
      } catch {
        /* try next selector */
      }
    }
    return false
  }

  // ── Primary: NAIC row id (#item-<naic>) ──
  const naic = (carrierNaic || "").trim() || aliasNaic(carrierName) || ""
  if (/^\d+$/.test(naic)) {
    const row = await page.$(`#item-${naic}`).catch(() => null)
    if (row && (await clickAddInRow(row, `#item-${naic}`))) return true
  }

  // ── Fallback: match the row by carrier-name text (+ short-code aliases) ──
  const nameCandidates = expandCarrierNames(carrierName)
  // A distinctive prefix (first 3 significant words) helps when the
  // on-screen name has extra suffixes our DB may abbreviate or omit.
  for (const base of [...nameCandidates]) {
    const words = base.split(/\s+/).filter(Boolean)
    if (words.length > 3) nameCandidates.push(words.slice(0, 3).join(" "))
  }
  const targetNorms = nameCandidates.map(normalizeCarrier).filter(Boolean)

  // Available rows are div.items__item.item#item-<id>. The Selected column
  // reuses .items__item (as a <button>, no id), so only id'd rows count.
  const containerSelectors = ['[id^="item-"]']

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
        const overlaps = targetNorms.some(
          (tn) =>
            rowNorm.includes(tn) ||
            tn.includes(rowNorm) ||
            // Token overlap: every significant word of a short target
            // appears in the row (e.g. "united home life" ⊂ full label).
            (tn.split(" ").filter((w) => w.length > 2).length > 0 &&
              tn
                .split(" ")
                .filter((w) => w.length > 2)
                .every((w) => rowNorm.includes(w))),
        )
        if (!overlaps) continue
        // Skip a row already in the Selected column.
        const cls = await row
          .evaluate((el: Element) => (el as HTMLElement).className || "")
          .catch(() => "")
        if (/\bselected\b/.test(cls)) continue
        if (await clickAddInRow(row, container)) return true
      }
    }
  }

  // Last resort: scan every available item row for alias token overlap
  // (handles cases where :has-text fails on nested Angular nodes).
  try {
    const allItems = await page.$$('[id^="item-"]')
    for (const row of allItems) {
      const rowText = await row
        .evaluate((el: Element) => (el.textContent || "").trim())
        .catch(() => "")
      const rowNorm = normalizeCarrier(rowText)
      const hit = targetNorms.some((tn) => {
        if (!tn || tn.length < 2) return false
        if (rowNorm.includes(tn) || tn.includes(rowNorm)) return true
        const toks = tn.split(" ").filter((w) => w.length > 2)
        return toks.length > 0 && toks.every((w) => rowNorm.includes(w))
      })
      if (!hit) continue
      if (await clickAddInRow(row, "scan-all-items")) return true
    }
  } catch {
    /* ignore */
  }

  logger.warn(
    { carrierName, carrierNaic: naic || carrierNaic, triedNames: nameCandidates },
    "[Fastlane] could not find ADD control for selected carrier",
  )
  return false
}

async function clickNextSafe(ctx: TabContext): Promise<void> {
  const { page, logger } = ctx
  // NEXT is "NEXT arrow_forward" in the wizard footer. Match by role and a
  // leading NEXT/CONTINUE; never the producer list's "Next page" paginator.
  const byRole = page.getByRole("button", { name: /^\s*(next|continue)\b(?!\s*page)/i })
  const n = await byRole.count().catch(() => 0)
  let next: Locator | null = null
  for (let i = 0; i < n && !next; i++) {
    if (await byRole.nth(i).isVisible().catch(() => false)) next = byRole.nth(i)
  }
  if (!next) {
    logger?.warn?.("[Fastlane] NEXT button not found")
    return
  }
  // SureLC greys NEXT until the step validates; give it a moment, then click.
  // Not force-enabled: the wizard's own handler refuses an invalid step anyway.
  await waitEnabled(next, 6_000)
  try {
    await next.click({ timeout: 5000 })
  } catch (err: any) {
    logger?.warn?.(`[Fastlane] NEXT click failed: ${err?.message || err}`)
    await next.evaluate((el: HTMLElement) => el.click()).catch(() => undefined)
  }
  await settle(page, 1200)
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
/**
 * ─── Finding the producer in Fastlane's list ────────────────────────
 *
 * Fastlane's list is virtualised, so the bot narrows it with the Search box
 * before looking for a card. It searched on our WHOLE last name, and for a
 * double surname that returns nothing at all: Paula is "LANDINO VALBUENA"
 * on our side and simply "Landino" in SureLC, so "LANDINO VALBUENA" matched
 * no producer, no card rendered, and the code below concluded the producer
 * had been flagged with issues. It had not. There was no card to flag.
 *
 * Ten of the twenty producers stuck on "SELECT button not found" since
 * 2026-08-01 are this, and the pattern is unmistakable once listed:
 *
 *   LANDINO VALBUENA · LEON TEMPONI · MARASCIA PITARRESI ·
 *   MOLERO DE MONTERO · TURIZO ESCOLA · DE JESUS MUNOZ ·
 *   Betancurt Castano          ← paternal + maternal surname
 *   AVENDAÑO · Muñoz␣          ← non-ASCII, and a trailing space
 *
 * Edgar Aponte contracts fine because ours ("Aponte") is a PREFIX of
 * SureLC's ("Aponte Hernandez"). The mismatch only bites when our name is
 * the longer one — which is most of a Spanish-speaking field.
 *
 * So search on the narrowest thing that is a prefix of both spellings: the
 * first token of the surname, folded to ASCII. Broader match, and the card
 * matching below still has to agree before we click anything.
 */
export function searchTermsForProducer(displayName: string): string[] {
  const lastName = (displayName.split(",")[0] || displayName).trim()
  const terms: string[] = []
  const push = (t: string) => {
    const v = t.trim()
    if (v.length >= 2 && !terms.includes(v)) terms.push(v)
  }
  push(lastName)
  const firstToken = lastName.split(/\s+/)[0] || ""
  push(firstToken)
  // Accent-folded, for a search box that may not normalise: AVENDAÑO →
  // AVENDANO, MUÑOZ → MUNOZ.
  push(foldAscii(lastName))
  push(foldAscii(firstToken))
  return terms
}

/** Strip diacritics so "MUÑOZ" and "MUNOZ" compare equal. */
export function foldAscii(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
}

/**
 * Does this producer card's name agree with the agent we are looking for?
 *
 * WHOLE-TOKEN since 2026-10-02 (producerIdentity.nameTokensMatch): the first
 * surname token of each side must be equal, and the first given-name token
 * when both have one. "LANDINO, PAULA" still matches "LANDINO VALBUENA,
 * PAULA CAROLINA" and "APONTE HERNANDEZ, EDGAR" matches "APONTE, EDGAR"; but
 * "TOVAR, CARLOS" no longer matches "NUNEZ-TOVAR, CARLOS EDUARDO, SR." — the
 * old substring test did, and filed Carlos Tovar's carriers on that card.
 *
 * A name match is never enough to SELECT a card on its own — see
 * decideProducerCard, which requires the producer's email on the card.
 */
export function cardMatchesProducer(
  cardText: string,
  displayName: string,
): boolean {
  return nameTokensMatch(cardText, displayName)
}

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
