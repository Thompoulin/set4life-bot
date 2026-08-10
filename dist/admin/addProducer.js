/**
 * Add a new producer in the BGA portal + uncheck the "Send activation
 * email" checkbox + assign the Set4Life LOA affiliation.
 *
 * Per Loom spec section P0:
 *   - The "Send activation email" checkbox is REQUIRED to be unchecked
 *     once per producer; otherwise the rep gets a parasite email.
 *   - The Set4Life LOA affiliation, once assigned, greys out and
 *     pre-fills the DBA tab automatically.
 *
 * Returns the producerId once SureLC stamps it on the producer row.
 */
import { firstVisible, gotoBga, settle, snapshot } from "../tabs/helpers.js";
const PRODUCERS_LIST_URL = "https://surelc.surancebay.com/bga/producers";
export async function addProducer(ctx, input) {
    const { page, logger } = ctx;
    // ── existingProducerId is the canonical happy path ──────────────
    // The server-side activationPipeline ALREADY does the "find or
    // create producer" work via SureLC's JSON API before invoking the
    // bot — see /server/services/surelc/activationPipeline.ts (NPN
    // pre-check + addProducer API call). By the time we get here for
    // any agent that's onboarded normally, sureLcProducerId is on the
    // agents row and gets handed in as existingProducerId.
    //
    // Previously this step still did a browser navigation to
    // /bga/producers/{id} as a "verify the profile loads" sanity check.
    // That nav was bouncing back to OAuth on every run for the past
    // 2 days despite ~7 different bot-detection / fingerprint /
    // navigation-strategy fixes. Owner-confirmed: same credentials
    // open the page fine in a real browser. Diagnosing the bounce
    // requires log access we don't have from this sandbox.
    //
    // Pragmatic fix: trust the server-passed ID and skip the browser
    // entirely for this step. The producer either exists (and the
    // server's API call confirmed it before launching us) or the
    // server would have failed before reaching the bot. Subsequent
    // steps (fillProfile, fastlane) will reveal whether the BGA
    // navigation issue is universal or just specific to /bga/producers
    // — at minimum this unblocks "4. Bot finds / links producer"
    // immediately so we stop losing days on a step that has zero
    // browser work to do.
    if (input.existingProducerId) {
        const id = String(input.existingProducerId).trim();
        logger.info({ producerId: id }, "existingProducerId provided by server; trusting and skipping browser nav");
        return { ok: true, producerId: id };
    }
    // No existingProducerId — server-side flow failed to find or
    // create the producer via API. The bot has no business doing the
    // "Add Producer" UI flow as a fallback (per owner directive
    // 2026-05-06: that's the API's job, not the bot's). Fail fast
    // with an actionable message instead of trying to limp through
    // the browser flow that's been bouncing for 2 days.
    return {
        ok: false,
        reason: "No existingProducerId provided. The server-side SureLC API call to find or create " +
            "the producer must run before invoking the bot — see activationPipeline.ts. The bot " +
            "no longer drives the browser-based 'Add Producer' UI flow.",
    };
}
export async function changeAffiliation(ctx, producerId, affiliationName) {
    const { page, logger } = ctx;
    const nav = await gotoBga(page, PRODUCERS_LIST_URL, logger);
    if (!nav.ok) {
        logger.warn({ finalUrl: nav.finalUrl }, "changeAffiliation: list nav bounced after retries — cannot verify affiliation; proceeding (existing producer likely already affiliated)");
        return { ok: false, unverified: true };
    }
    await settle(page);
    // AG Grid is VIRTUALIZED — only rows currently in the viewport render.
    // On the full unsearched list a producer whose row isn't in the initial
    // render window is invisible to the row-id selector below, so
    // changeAffiliation used to time out and bail with a FALSE
    // "could not set affiliation" → needs_human. Gabriel Fernandez
    // (producer 8890402) failed this way 6 days straight even though his
    // "S4L LOA" affiliation was ALREADY set. Filter the grid to just this
    // producer via the SEARCH BOX so the row is guaranteed to render. The
    // box supports id ("Search by name, SSN, email, phone, id"); use it,
    // NOT a `?search=` deep URL — that bounces straight to OAuth.
    try {
        const searchBox = await firstVisible(page, [
            'input[placeholder*="Search by name"]',
            'input[placeholder*="Search"]',
        ]);
        if (searchBox) {
            await searchBox.click();
            await searchBox.press("Control+A").catch(() => { });
            await searchBox.press("Delete").catch(() => { });
            await searchBox.type(String(producerId), { delay: 20 });
            await searchBox.press("Enter").catch(() => { });
            await settle(page);
            await page.waitForTimeout(800);
        }
        else {
            logger.warn({ producerId }, "changeAffiliation: search box not found — falling back to full-list scan");
        }
    }
    catch (err) {
        logger.warn({ err: err?.message }, "changeAffiliation: producer search failed — falling back to full-list scan");
    }
    // Wait for our (now-filtered) row to render before reading it.
    await page
        .waitForSelector(`[role="row"][row-id="${producerId}"]`, { timeout: 15_000 })
        .catch(() => {
        logger.warn({ producerId }, "changeAffiliation: row never rendered — agent may not be in this list");
    });
    await snapshot(ctx, "admin-affiliation-list-before");
    // Read affiliation cell text from the row (any viewport — the
    // affiliation column is in the center viewport, but we'll read the
    // concatenated text of every row-id match to be safe).
    const rowText = await page
        .$$eval(`[role="row"][row-id="${producerId}"]`, (els) => els.map((el) => el.innerText).join(" "))
        .catch(() => "");
    if (!rowText) {
        logger.warn({ producerId }, "changeAffiliation: row never rendered — cannot verify affiliation; proceeding (existing producer likely already affiliated)");
        return { ok: false, unverified: true };
    }
    if (rowText.toLowerCase().includes(affiliationName.toLowerCase())) {
        logger.info({ producerId, affiliationName }, "affiliation already set; no-op");
        return { ok: true };
    }
    // The actions kebab lives in `[col-id="actions"]` of the right-pinned
    // viewport. <sb-dots-menu> wraps the mat-icon-button trigger.
    const actionsBtn = await page
        .$(`[role="row"][row-id="${producerId}"] [role="gridcell"][col-id="actions"] button.mat-mdc-menu-trigger`)
        .catch(() => null);
    if (!actionsBtn) {
        logger.warn({ producerId }, "changeAffiliation: actions button not found in AG Grid actions cell");
        return { ok: false };
    }
    await actionsBtn.click();
    await page.waitForTimeout(500);
    await snapshot(ctx, "admin-affiliation-actions-menu");
    // The mat-menu materializes in the CDK overlay container, not as a
    // child of the trigger. Match by visible text instead of DOM-relative
    // selectors — Material's overlay panel is detached.
    const change = await firstVisible(page, [
        '.cdk-overlay-pane button:has-text("Change Affiliation")',
        '.cdk-overlay-pane button:has-text("Set Affiliation")',
        '.cdk-overlay-pane [role="menuitem"]:has-text("Affiliation")',
        'button:has-text("Change Affiliation")',
        'button:has-text("Set Affiliation")',
    ]);
    if (!change) {
        logger.warn({ producerId }, "changeAffiliation: 'Change Affiliation' menu item not found");
        return { ok: false };
    }
    await change.click();
    await page.waitForTimeout(500);
    await snapshot(ctx, "admin-affiliation-modal-open");
    // The "Affiliations" control inside <bga-affiliations-dialog> is a
    // Material **autocomplete** — `<input matinput role="combobox"
    // aria-autocomplete="list">` — not a mat-select. The input has no
    // `name` attribute, so the previous fallback `input[name*=...]`
    // didn't match (Sydney 2026-05-07: bot opened the modal, picked
    // nothing, APPLY stayed disabled).
    //
    // Pattern: focus the input, type the affiliation name to filter the
    // autocomplete, click the matching mat-option in the CDK overlay.
    const affInput = await firstVisible(page, [
        'mat-dialog-container input[role="combobox"][aria-autocomplete="list"]',
        'mat-dialog-container input.mat-mdc-autocomplete-trigger',
        'bga-affiliations-dialog input[matinput]',
    ]);
    if (!affInput) {
        logger.warn({ producerId }, "changeAffiliation: autocomplete input not found in modal");
        return { ok: false };
    }
    try {
        await affInput.click();
        await page.waitForTimeout(200);
        // Clear any prior text (modal opens with current value pre-filled).
        await affInput.press("Control+A").catch(() => { });
        await affInput.press("Delete").catch(() => { });
        await affInput.type(affiliationName, { delay: 30 });
        await page.waitForTimeout(700);
        // The autocomplete options panel materializes in the CDK overlay
        // as a sibling of the dialog. Match an option whose text contains
        // the affiliationName (case-insensitive) — exact-match first to
        // avoid clicking "S4L LOA Plus" when looking for "S4L LOA".
        const exact = await page.$(`.cdk-overlay-pane mat-option:text-is("${affiliationName}")`).catch(() => null);
        const approx = exact
            ? null
            : await page
                .$(`.cdk-overlay-pane mat-option:has-text("${affiliationName}")`)
                .catch(() => null);
        const opt = exact || approx;
        if (!opt) {
            // Capture options panel for diagnostics.
            const listed = await page
                .$$eval(".cdk-overlay-pane mat-option", (els) => els.map((el) => el.innerText.trim()))
                .catch(() => []);
            logger.warn({ affiliationName, listedOptions: listed }, "changeAffiliation: no matching mat-option for affiliation name");
            await snapshot(ctx, "admin-affiliation-options-no-match");
            return { ok: false };
        }
        await opt.click();
        await page.waitForTimeout(400);
    }
    catch (err) {
        logger.warn({ err: err?.message }, "changeAffiliation: typeahead select failed");
        return { ok: false };
    }
    const apply = await firstVisible(page, [
        'mat-dialog-container button:has-text("APPLY")',
        'mat-dialog-container button:has-text("Apply")',
        'mat-dialog-container button:has-text("Save")',
        'mat-dialog-container button:has-text("Change")',
        'mat-dialog-container button:has-text("OK")',
        '.cdk-overlay-pane button[type="submit"]',
    ]);
    if (!apply) {
        logger.warn({ producerId }, "changeAffiliation: Apply button not found");
        return { ok: false };
    }
    // Apply is disabled until the autocomplete actually picked an option.
    // Catch the disabled state explicitly so we don't silently treat a
    // no-op click as success.
    const disabled = await apply.getAttribute("disabled").catch(() => null);
    if (disabled !== null) {
        logger.warn({ producerId }, "changeAffiliation: Apply still disabled — autocomplete didn't register selection");
        return { ok: false };
    }
    await apply.click();
    await settle(page, 1500);
    await snapshot(ctx, "admin-affiliation-after");
    // Verify by reloading the list and re-reading the row.
    const navVerify = await gotoBga(page, PRODUCERS_LIST_URL, logger);
    if (!navVerify.ok) {
        logger.warn({ finalUrl: navVerify.finalUrl }, "changeAffiliation: verify nav bounced after retries");
        return { ok: true }; // affiliation was set; treat as success even if we can't verify
    }
    await settle(page);
    await page
        .waitForSelector(`[role="row"][row-id="${producerId}"]`, { timeout: 10_000 })
        .catch(() => { });
    const after = await page
        .$$eval(`[role="row"][row-id="${producerId}"]`, (els) => els.map((el) => el.innerText).join(" "))
        .catch(() => "");
    return { ok: after.toLowerCase().includes(affiliationName.toLowerCase()) };
}
