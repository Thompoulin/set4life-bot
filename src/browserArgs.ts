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
export const CHROMIUM_ARGS: string[] = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-gpu-compositing",
]

import { chromium, type Browser } from "playwright"
import type pino from "pino"

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
export async function launchChromium(logger?: pino.Logger): Promise<Browser> {
  const MAX_ATTEMPTS = 3
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await chromium.launch({ headless: true, args: CHROMIUM_ARGS })
    } catch (err: any) {
      lastErr = err
      const msg = String(err?.message ?? err)
      const isCrash =
        /SIGSEGV|signal 11|General Protection Fault|Target (?:page,? |closed)|browser has been closed|Target page, context or browser has been closed/i.test(
          msg,
        )
      logger?.warn(
        { attempt, of: MAX_ATTEMPTS, isCrash, err: msg.slice(0, 200) },
        "chromium launch failed — retrying after transient crash",
      )
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 1500 * attempt))
      }
    }
  }
  throw lastErr
}
