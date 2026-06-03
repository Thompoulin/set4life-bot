// Capture every HTTP call SureLC's signature-upload flow makes, using
// the bot's own loginAdmin helper to handle the OAuth bounce reliably.
import { chromium } from "playwright";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import pino from "pino";
import { loginAdmin } from "../dist/admin/login.js";

const PRODUCER_ID = process.argv[2];
if (!PRODUCER_ID) {
  console.error("usage: node probe-signature-flow.mjs <producerId>");
  process.exit(1);
}
const adminEmail = process.env.SURELC_ADMIN_EMAIL;
const adminPassword = process.env.SURELC_ADMIN_PASSWORD;
if (!adminEmail || !adminPassword) {
  console.error("SURELC_ADMIN_EMAIL + SURELC_ADMIN_PASSWORD env vars required");
  process.exit(1);
}
const trace = [];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("surancebay.com")) return;
    if (/\.(js|css|svg|png|woff2?|ico|jpg|gif|ttf|map)/.test(url)) return;
    trace.push({
      phase: "request",
      ts: Date.now(),
      method: req.method(),
      url,
      headers: req.headers(),
      postData: req.postData()?.slice(0, 3000),
    });
  });
  page.on("response", async (res) => {
    const url = res.url();
    if (!url.includes("surancebay.com")) return;
    if (/\.(js|css|svg|png|woff2?|ico|jpg|gif|ttf|map)/.test(url)) return;
    const ct = res.headers()["content-type"] || "";
    let body = "";
    if (ct.includes("json") || ct.includes("text") || ct === "") {
      body = (await res.text().catch(() => "")).slice(0, 3000);
    } else {
      body = `(binary ${ct})`;
    }
    trace.push({
      phase: "response",
      ts: Date.now(),
      status: res.status(),
      url,
      headers: res.headers(),
      body,
    });
  });

  const logger = pino({ level: "info" });

  console.error("[probe] logging in via bot's loginAdmin…");
  const loginResult = await loginAdmin(page, { email: adminEmail, password: adminPassword }, logger);
  if (!loginResult.ok) {
    console.error("[probe] login failed:", loginResult);
    await browser.close();
    process.exit(1);
  }
  console.error("[probe] logged in. Navigating to signature tab…");

  const target = `https://surelc.surancebay.com/bga/producers/${PRODUCER_ID}/signature`;
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4000);
  console.error("[probe] on signature tab. Pre-upload trace size:", trace.length);

  const preUploadIdx = trace.length;

  // Click REMOVE if a signature is already present, to get back to the fresh-upload screen.
  const existingRemove = await page.$('button:has-text("REMOVE")').catch(() => null);
  if (existingRemove) {
    console.error("[probe] producer has existing signature — clicking REMOVE first");
    await existingRemove.click().catch(() => {});
    await page.waitForTimeout(2500);
    const yes =
      (await page.$('mat-dialog-container button:has-text("YES")').catch(() => null)) ||
      (await page.$('button:has-text("YES")').catch(() => null));
    if (yes) await yes.click().catch(() => {});
    await page.waitForTimeout(4000);
  }

  // Click UPLOAD IT NOW
  const uploadBtn =
    (await page.$('button:has-text("UPLOAD IT NOW")').catch(() => null)) ||
    (await page.$('button:has-text("Upload it now")').catch(() => null));
  if (uploadBtn) {
    console.error("[probe] clicking UPLOAD IT NOW");
    await uploadBtn.click().catch(() => {});
    await page.waitForTimeout(1500);
  }

  // Generate a 100x40 black-line PNG as test signature (signature-ish).
  const testPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAYAAACqNX6+AAAAAXNSR0IArs4c6QAAAGNJREFUeJzt3DERAAAIw7CBf8/wAUmUBPe9zMyZQEZsHcCRkBgJiZGQGAmJkZAYCYmRkBgJiZGQGAmJkZAYCYmRkBgJiZGQGAmJkZAYCYmRkBgJiZGQGAmJkZAYCYmRkBgJicEPGGsBSGm0RJsAAAAASUVORK5CYII=",
    "base64",
  );
  const tmp = join(tmpdir(), `probe-sig-${Date.now()}.png`);
  await writeFile(tmp, testPng);

  const fileInput = await page.$('input[type="file"]').catch(() => null);
  if (!fileInput) {
    console.error("[probe] no file input found");
    await page.waitForTimeout(10_000);
  } else {
    console.error("[probe] setting input files…");
    await fileInput.setInputFiles(tmp);
    console.error("[probe] file set; waiting 30s for upload + cropper traffic…");
    await page.waitForTimeout(30_000);
  }
  console.error("[probe] done. Total entries:", trace.length, "new since upload:", trace.length - preUploadIdx);

  // Emit just the post-upload entries to keep output focused.
  console.log(JSON.stringify({ preUploadIdx, trace }, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error("[probe] threw:", err);
  console.log(JSON.stringify({ error: String(err), trace }, null, 2));
  process.exit(1);
});
