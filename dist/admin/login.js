/**
 * Login to the SureLC BGA admin portal.
 *
 * Per Loom spec: BGA admin URL is https://surelc.surancebay.com/bga/.
 * The producer-rep portal is at /producer/ — different login, different
 * flow. This module is for the AGENCY ADMIN only. For the rep flow
 * (Step 0 of the Producer Review wizard) see ../rep/review.ts.
 *
 * Credentials come from the bot's env (SURELC_ADMIN_EMAIL +
 * SURELC_ADMIN_PASSWORD) — owner created a dedicated bot@... account
 * to keep MFA off (per spec section D, Trou #9). Real admins
 * (Thomas / Anna / Marilyn) can keep MFA on their own logins.
 */
import { firstVisible } from "../tabs/helpers.js";
export const BGA_LOGIN_URL = "https://surelc.surancebay.com/bga/";
export async function loginAdmin(page, creds, logger) {
    await page.goto(BGA_LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
    });
    // Wait up to 25s for the login form (the SPA may redirect to the
    // accounts.surancebay.com auth domain on cold start). Parse the URL
    // properly — the previous regex `/\/bga\//.test(url)` would match the
    // OAuth authorize URL because its `redirect_uri` query parameter
    // contains `/bga/oauth`, falsely declaring the bot already logged in
    // (owner-reported failure 2026-05-05: bot reported "Logged in" then
    // immediately failed at "Add Producer button not found" because it
    // was actually still on the OAuth login form).
    //
    // We don't break the wait loop on "any visible input" anymore — the
    // 2026-05-22 failure mode was that `input:visible` matched a transient
    // input (cookie banner / SPA bootstrap form) before the actual OAuth
    // form rendered, then firstVisible ran against an unsettled DOM and
    // returned null. Instead wait specifically for the OAuth form's
    // username field to be in the DOM, and only THEN proceed.
    const start = Date.now();
    while (Date.now() - start < 25_000) {
        if (isLoggedInBgaUrl(page.url()))
            return { ok: true }; // already logged in
        const formReady = await page.$('input[data-cy="email-input"], input[type="email"], input[name="username"]');
        if (formReady)
            break;
        await page.waitForTimeout(500);
    }
    // Extra beat for Material to finish wiring up the input. Without it
    // isVisible() can race the form's slide-in animation and return false
    // for an input that's already in the DOM.
    await page.waitForTimeout(1_500);
    const emailField = await firstVisible(page, [
        'input[data-cy="email-input"]',
        'input[formcontrolname="username"]',
        'input[type="email"]',
        'input[name*="email" i]',
        'input[name*="username" i]',
        'input[id*="email" i]',
        'input[id*="username" i]',
        'input[autocomplete="username"]',
        'input[autocomplete="email"]',
        'input[aria-label*="email" i]',
        'input[placeholder*="email" i]',
    ]);
    if (!emailField) {
        logger.warn({ url: page.url() }, "admin login: email input not found");
        return { ok: false, reason: `Email input not found at ${page.url()}` };
    }
    await emailField.fill(creds.email);
    const pwField = await firstVisible(page, [
        'input[data-cy="password-input"]',
        'input[formcontrolname="password"]',
        'input[type="password"]',
        'input[name*="password" i]',
        'input[id*="password" i]',
        'input[autocomplete="current-password"]',
    ]);
    if (!pwField) {
        logger.warn("admin login: password input not found");
        return { ok: false, reason: "Password input not found on SureLC OAuth page" };
    }
    await pwField.fill(creds.password);
    const submit = await firstVisible(page, [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("LOGIN")', // Material caps the visible text
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
        'button:has-text("Login")',
    ]);
    if (submit) {
        await submit.click().catch(() => { });
    }
    else {
        await pwField.press("Enter").catch(() => { });
    }
    // Wait for the URL to land on the actual BGA app — meaning OAuth
    // completed AND the SPA processed the callback. We accept any path
    // under surelc.surancebay.com/bga/ EXCEPT /bga/oauth which is the
    // intermediate callback handler. Stays on /oauth/authorize → login
    // failed (wrong creds, MFA needed, etc.).
    try {
        await page.waitForURL((u) => isLoggedInBgaUrl(u.href), { timeout: 30_000 });
    }
    catch {
        // Capture any visible error text so the timeline shows WHY login
        // bounced — "Invalid email or password" / "MFA required" / etc.
        // Without this the owner has to dig into Dokku logs to see what
        // SureLC is actually complaining about.
        const errors = await collectVisibleErrors(page);
        const finalUrl = page.url();
        logger.warn({ url: finalUrl, errors }, "admin login: did not land on /bga/* — likely wrong credentials or MFA prompt");
        const reason = errors.length
            ? `SureLC: ${errors.join(" / ")}`
            : looksLikeStillOnOauthForm(finalUrl)
                ? `Login bounced — still on OAuth page (${finalUrl}). Likely wrong email/password or MFA was enabled on the bot service account.`
                : `Login did not land on /bga/* (final URL: ${finalUrl}).`;
        return { ok: false, reason };
    }
    // URL transitioned to /bga/* — but that's not a guarantee the SPA
    // actually stored OAuth tokens. The previous failure mode (owner-
    // reported 2026-05-05 21:56) was: bot reports "Logged in" because the
    // URL settled on /bga/home, then the very next goto to /bga/producers
    // bounces straight back to /oauth/authorize because no Bearer token
    // is in localStorage. Defensive checks below close that gap:
    //
    //   1. Wait up to 15 s for an OAuth token (id_token / access_token)
    //      to appear in localStorage. SureLC's SPA stores them under
    //      `sb:id_token` + `sb:refresh_token` (verified 2026-04-28).
    //   2. Probe the producers list with a goto. If the SPA bounces us
    //      back to accounts.surancebay.com or /bga/oauth, the session
    //      isn't real — fail the login with the actual final URL logged.
    const haveToken = await waitForBgaToken(page, 15_000);
    if (!haveToken) {
        const storageKeys = await page
            .evaluate(() => {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++)
                keys.push(`local:${localStorage.key(i)}`);
            for (let i = 0; i < sessionStorage.length; i++)
                keys.push(`session:${sessionStorage.key(i)}`);
            return keys;
        })
            .catch(() => []);
        logger.warn({ url: page.url(), storageKeys }, "admin login: URL on /bga/* but no OAuth token in storage — SPA did not finish auth");
        return {
            ok: false,
            reason: `Logged-in URL but no OAuth token in storage (keys: ${storageKeys.join(", ") || "none"}). ` +
                `The SPA didn't finish authenticating — most likely the password is wrong or the account ` +
                `requires MFA. Reset the bot service account password in SureLC and update SURELC_ADMIN_PASSWORD.`,
        };
    }
    // Log the JWT claims for diagnostics, but do NOT use them to decide
    // whether login worked. Different SureLC accounts get different role
    // claim shapes (officeManager / agencyWorker / agencyAdmin / etc.)
    // and the same account that opens /bga/producers fine in a real
    // browser sometimes shows only "officeManager"+"agencyWorker" in
    // the bot's token. The owner verified manually 2026-05-06 with the
    // exact same credentials the bot uses — claims look "producer-only"
    // but /bga/producers loads with the full Add Producer / agency view.
    // So claims are NOT a reliable admin signal; record them and move on.
    const claims = await readBgaTokenClaims(page).catch(() => null);
    logger.info({ claims }, "admin login: token claims captured (informational)");
    // Wait for the SPA to fully bootstrap before returning. Without this,
    // the next phase's first hard navigation (page.goto /bga/producers)
    // races the SPA's auth-guard initialization and bounces back to OAuth
    // even though the session is valid (owner-observed 2026-05-06: bot
    // logs in fine, then 5 s later the next step fails with "BGA session
    // lost between login and addProducer"). Letting network settle and
    // giving the SPA an additional generous beat lets cookies + in-memory
    // auth context finish wiring up before downstream navigations land.
    await page
        .waitForLoadState("networkidle", { timeout: 15_000 })
        .catch(() => { });
    await page.waitForTimeout(4_000);
    return { ok: true };
}
/** Read whatever JWT is in localStorage / sessionStorage and decode its
 *  payload (no signature verification — we just want to inspect claims).
 *  Returns the first JWT-shaped value found, decoded. */
async function readBgaTokenClaims(page) {
    const jwt = await page.evaluate(() => {
        const isJwtLike = (s) => s.split(".").length === 3 && s.length > 40;
        const collect = [];
        for (let i = 0; i < localStorage.length; i++) {
            const v = localStorage.getItem(localStorage.key(i) || "") || "";
            if (isJwtLike(v))
                collect.push(v);
            try {
                const o = JSON.parse(v);
                for (const key of ["access_token", "id_token", "accessToken", "idToken"]) {
                    if (o && typeof o[key] === "string" && isJwtLike(o[key]))
                        collect.push(o[key]);
                }
            }
            catch {
                /* not JSON */
            }
        }
        for (let i = 0; i < sessionStorage.length; i++) {
            const v = sessionStorage.getItem(sessionStorage.key(i) || "") || "";
            if (isJwtLike(v))
                collect.push(v);
        }
        return collect[0] || null;
    });
    if (!jwt)
        return null;
    try {
        const payload = jwt.split(".")[1];
        // Browser-safe base64url → base64 + decode
        const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const json = Buffer.from(padded, "base64").toString("utf8");
        return JSON.parse(json);
    }
    catch {
        return null;
    }
}
/** Collect the top mat-error / role=alert / snack-bar messages on the
 *  page so we can surface SureLC's own error copy back to the operator. */
async function collectVisibleErrors(page) {
    return page
        .evaluate(() => {
        const out = [];
        document
            .querySelectorAll("mat-error, .error, .alert, [role=alert], snack-bar-container, .mat-mdc-snack-bar-label")
            .forEach((el) => {
            const s = (el.textContent || "").trim();
            if (s)
                out.push(s);
        });
        return Array.from(new Set(out)).slice(0, 5);
    })
        .catch(() => []);
}
function looksLikeStillOnOauthForm(href) {
    try {
        const u = new URL(href);
        return /accounts\.surancebay\.com$/.test(u.hostname) && /oauth\/authorize/.test(u.pathname);
    }
    catch {
        return false;
    }
}
/**
 * Poll localStorage / sessionStorage for an OAuth token. Returns true as
 * soon as a JWT-shaped string is found under any key matching the SPA's
 * known token-key conventions (sb:id_token, *access*, *id_token*).
 */
async function waitForBgaToken(page, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const found = await page
            .evaluate(() => {
            const isJwtLike = (s) => s.split(".").length === 3 && s.length > 40;
            const all = {};
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i) || "";
                all[k] = localStorage.getItem(k) || "";
            }
            for (let i = 0; i < sessionStorage.length; i++) {
                const k = sessionStorage.key(i) || "";
                all[k] = sessionStorage.getItem(k) || "";
            }
            for (const [k, v] of Object.entries(all)) {
                if (!v)
                    continue;
                if (/(?:^|:)id_token$/i.test(k) && isJwtLike(v))
                    return true;
                if (/access(?:_?token)?/i.test(k) && isJwtLike(v))
                    return true;
                // JSON-wrapped tokens (older SDK shape)
                try {
                    const obj = JSON.parse(v);
                    if (obj && typeof obj === "object") {
                        if (typeof obj.access_token === "string" && isJwtLike(obj.access_token))
                            return true;
                        if (typeof obj.accessToken === "string" && isJwtLike(obj.accessToken))
                            return true;
                        if (typeof obj.id_token === "string" && isJwtLike(obj.id_token))
                            return true;
                    }
                }
                catch {
                    /* not JSON */
                }
            }
            return false;
        })
            .catch(() => false);
        if (found)
            return true;
        await page.waitForTimeout(500);
    }
    return false;
}
/**
 * True if the given URL is a "we're logged in and inside the BGA admin"
 * URL. Strict: must be on the surelc.surancebay.com host, path must
 * start with /bga/, and must NOT be /bga/oauth (the OAuth callback
 * handler). Anything else — including the OAuth authorize URL whose
 * redirect_uri query string contains "/bga/" — returns false.
 */
function isLoggedInBgaUrl(href) {
    let u;
    try {
        u = new URL(href);
    }
    catch {
        return false;
    }
    if (u.hostname !== "surelc.surancebay.com")
        return false;
    if (!u.pathname.startsWith("/bga"))
        return false;
    if (/^\/bga\/oauth\b/.test(u.pathname))
        return false;
    if (/login|sign-?in/i.test(u.pathname))
        return false;
    return true;
}
