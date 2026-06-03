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
