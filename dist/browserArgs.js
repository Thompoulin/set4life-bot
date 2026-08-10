/**
 * Single source of truth for Chromium launch args across every browser
 * the bot opens (botRunner rep-review/Phase A, bgaTokenCapture, and the
 * server.ts diagnostic/admin endpoints).
 *
 * Why the GPU flags matter (added 2026-06-02): the headless container has
 * no GPU, so Playwright auto-appends `--enable-unsafe-swiftshader` and
 * Chromium falls back to SwiftShader software GL. That path SIGSEGVs on
 * launch intermittently (`Received signal 11 SI_KERNEL … General
 * Protection Fault` in chrome-headless-shell) — the dominant cause of
 * mid-run crashes that abort a signing run after ~27 min and force a
 * retry. `--disable-gpu` + `--disable-software-rasterizer` keep Chromium
 * off the GPU/SwiftShader code path entirely; we never render WebGL, so
 * there's no downside. The dbus warning ("Failed to connect to
 * /run/dbus/system_bus_socket") is benign and unrelated.
 *
 * `--disable-dev-shm-usage` routes Chromium's scratch space to /tmp
 * because the container's /dev/shm is only 64 MB (Docker default).
 *
 * `--disable-blink-features=AutomationControlled` hides the
 * navigator.webdriver automation signal (kept from the prior args).
 */
export const CHROMIUM_ARGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-gpu-compositing",
];
import { chromium } from "playwright";
/**
 * ── Concurrency gate ────────────────────────────────────────────────────
 *
 * Every browser in this bot is launched through launchChromium(), and until
 * 2026-07-27 nothing bounded how many ran at once: each inbound request
 * launched its own Chromium. On a 15 GB box shared with MySQL and the prod
 * app, that death-spirals — more browsers → memory pressure → slower pages →
 * operation timeouts → retries → more browsers.
 *
 * Observed 2026-07-27: 378 chrome processes, the bot holding 10.7 GB of
 * 15.6 GB with 0 GB free and 4 GB of swap in use, and 12 "SureLC bot crashed
 * … The operation was aborted due to timeout" alerts across 12 DIFFERENT
 * agents in 3 days. The timeouts were a symptom of starvation, not of
 * SureLC being slow.
 *
 * A slot is held from launch until the browser disconnects. Callers already
 * close in a `finally`, so no call site changes — but we deliberately do NOT
 * rely on the caller: the watchdog force-closes and reclaims a slot if a run
 * wedges, otherwise one hung close would permanently shrink the pool.
 */
const MAX_CONCURRENT_BROWSERS = Math.max(1, Number(process.env.SURELC_MAX_BROWSERS ?? 3));
/** Hard ceiling on how long one browser may hold a slot before we reclaim it. */
const BROWSER_SLOT_TTL_MS = Math.max(60_000, Number(process.env.SURELC_BROWSER_TTL_MS ?? 20 * 60_000));
/** How long a caller waits for a free slot before giving up. */
const SLOT_WAIT_TIMEOUT_MS = Math.max(60_000, Number(process.env.SURELC_SLOT_WAIT_MS ?? 15 * 60_000));
let activeBrowsers = 0;
const waiters = [];
function releaseSlot() {
    activeBrowsers = Math.max(0, activeBrowsers - 1);
    const next = waiters.shift();
    if (next)
        next();
}
async function acquireSlot(logger) {
    if (activeBrowsers < MAX_CONCURRENT_BROWSERS) {
        activeBrowsers++;
        return;
    }
    logger?.info({ active: activeBrowsers, max: MAX_CONCURRENT_BROWSERS, queued: waiters.length }, "browser pool full — queueing");
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const i = waiters.indexOf(grant);
            if (i >= 0)
                waiters.splice(i, 1);
            reject(new Error(`Timed out after ${Math.round(SLOT_WAIT_TIMEOUT_MS / 1000)}s waiting for a free browser slot (max ${MAX_CONCURRENT_BROWSERS})`));
        }, SLOT_WAIT_TIMEOUT_MS);
        const grant = () => {
            clearTimeout(timer);
            activeBrowsers++;
            resolve();
        };
        waiters.push(grant);
    });
}
/** Current pool state — surfaced by the /health endpoint. */
export function browserPoolStats() {
    return { active: activeBrowsers, queued: waiters.length, max: MAX_CONCURRENT_BROWSERS };
}
/**
 * Launch headless Chromium with CHROMIUM_ARGS, retrying on the
 * intermittent SwiftShader SIGSEGV-on-launch (`Received signal 11 …
 * General Protection Fault`, surfaced as "Target page, context or
 * browser has been closed"). Despite the --disable-gpu args above the
 * crash still fires on a minority of launches and, unretried, aborts an
 * entire signing/activation run — stranding a producer at Producer stage
 * for the day (owner-observed 2026-07-07, Claudia Martinez). Retrying the
 * launch a few times turns that fatal abort into a ~2 s hiccup, since the
 * crash is non-deterministic and almost never repeats back-to-back.
 *
 * Only launch-time failures are retried here; anything the caller does
 * with the returned Browser is its own concern.
 */
export async function launchChromium(logger) {
    await acquireSlot(logger);
    let launched = false;
    try {
        const browser = await launchChromiumUnpooled(logger);
        launched = true;
        bindSlotToBrowser(browser, logger);
        return browser;
    }
    finally {
        // Launch failed after all retries — hand the slot straight back, or the
        // pool would leak a slot per failed launch and eventually wedge at zero.
        if (!launched)
            releaseSlot();
    }
}
/** Release the slot when this browser goes away, with a watchdog backstop. */
function bindSlotToBrowser(browser, logger) {
    let released = false;
    const release = (reason) => {
        if (released)
            return;
        released = true;
        clearTimeout(watchdog);
        releaseSlot();
        logger?.debug({ reason, ...browserPoolStats() }, "browser slot released");
    };
    const watchdog = setTimeout(() => {
        logger?.warn({ ttlMs: BROWSER_SLOT_TTL_MS, ...browserPoolStats() }, "browser exceeded slot TTL — force-closing and reclaiming its slot");
        void browser.close().catch(() => undefined);
        release("ttl");
    }, BROWSER_SLOT_TTL_MS);
    // Playwright emits this on close() AND on an unexpected browser crash, so
    // it covers the case the caller's finally never runs.
    browser.on("disconnected", () => release("disconnected"));
}
async function launchChromiumUnpooled(logger) {
    const MAX_ATTEMPTS = 3;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            return await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
        }
        catch (err) {
            lastErr = err;
            const msg = String(err?.message ?? err);
            const isCrash = /SIGSEGV|signal 11|General Protection Fault|Target (?:page,? |closed)|browser has been closed|Target page, context or browser has been closed/i.test(msg);
            logger?.warn({ attempt, of: MAX_ATTEMPTS, isCrash, err: msg.slice(0, 200) }, "chromium launch failed — retrying after transient crash");
            if (attempt < MAX_ATTEMPTS) {
                await new Promise((r) => setTimeout(r, 1500 * attempt));
            }
        }
    }
    throw lastErr;
}
