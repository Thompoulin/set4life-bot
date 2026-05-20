#!/usr/bin/env node
/**
 * Local Phase B testing harness — drives surelc-bot/src/rep/review.ts
 * directly against surelc.surancebay.com in headed Chromium so the
 * dev can watch + step through.
 *
 * Iterates the bot's rep-flow code without going through:
 *   git push → GitHub Actions → Dokku build → bot restart → trigger
 *   curl → SSH-fetch screenshots
 *
 * Usage:
 *   cd surelc-bot
 *   pnpm build          # build dist/ once after editing src/rep/review.ts
 *   node scripts/local-rep-review.mjs
 *
 * Iteration loop while debugging:
 *   1. edit src/rep/review.ts
 *   2. pnpm build  (or pnpm tsc --watch in another terminal)
 *   3. node scripts/local-rep-review.mjs
 *   → headed browser opens, walks the wizard, leaves browser open
 *     when HEADED so you can inspect.
 *
 * Env (all optional):
 *   AGENT_OPEN_ID     — default Sydney's openId.
 *   REP_REVIEW_URL    — explicit URL. If unset, fetches the freshest
 *                       review URL from the production app's
 *                       /api/debug/surelc-rep-creds endpoint.
 *   REP_URL_INDEX     — when fetching, pick the Nth URL (default 0 =
 *                       newest). Use to burn through unused URLs if a
 *                       previous run consumed one.
 *   HEADED            — "0" to run headless. Default headed.
 *   SLOW_MO           — Playwright slowMo ms. Default 100 in headed.
 *   APP_URL           — base URL for /api/debug. Default prod.
 *   COOKIE_SECRET     — bearer token. Default = prod JWT_SECRET.
 *
 * Note on URL freshness: SureLC review URLs include a `sec=` timestamp
 * and an appointmentId. Each appointment has its own URL — Sydney has
 * 9 (one per carrier). They're long-lived but consume on auth-success.
 * If you need fresh ones, re-run Phase A (Fastlane) for the agent.
 */

import { chromium } from "playwright"
import pino from "pino"
import path from "node:path"
import fs from "node:fs/promises"
import { repReview } from "../dist/rep/review.js"

const APP_URL = process.env.APP_URL || "https://app.set4lifeagency.com"
const COOKIE_SECRET =
  process.env.COOKIE_SECRET ||
  // Prod JWT_SECRET — see Dokku config:show s4l-production
  "713df7896eaa71b7b405b5fc6f85a68a531e7ec46b7b5024fddcca3acb8dff41"
const AGENT_OPEN_ID =
  process.env.AGENT_OPEN_ID || "pending-sydney-desilva-yahoo-com-72"

const HEADED = process.env.HEADED !== "0"
const SLOW_MO = Number(process.env.SLOW_MO ?? (HEADED ? 100 : 0))
const REP_URL_INDEX = Number(process.env.REP_URL_INDEX ?? 0)

async function fetchCreds() {
  const res = await fetch(`${APP_URL}/api/debug/surelc-rep-creds`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${COOKIE_SECRET}`,
    },
    body: JSON.stringify({ agentOpenId: AGENT_OPEN_ID }),
  })
  if (!res.ok) {
    throw new Error(`/api/debug/surelc-rep-creds HTTP ${res.status}`)
  }
  const data = await res.json()
  if (!data.ssnLast6 || !data.dob || !data.reviewUrls?.length) {
    throw new Error(
      `creds endpoint returned incomplete data: ${JSON.stringify(data)}`,
    )
  }
  return data
}

async function main() {
  console.log(`[local] agent=${AGENT_OPEN_ID}  app=${APP_URL}`)
  const creds = await fetchCreds()
  const reviewUrl =
    process.env.REP_REVIEW_URL ||
    creds.reviewUrls[Math.min(REP_URL_INDEX, creds.reviewUrls.length - 1)].url
  const pickedSubject =
    process.env.REP_REVIEW_URL
      ? "(env override)"
      : creds.reviewUrls[Math.min(REP_URL_INDEX, creds.reviewUrls.length - 1)].subject

  console.log(`[local] picked URL #${REP_URL_INDEX} :  ${pickedSubject}`)
  console.log(`[local] reviewUrl: ${reviewUrl}`)
  console.log(
    `[local] ssnLast6=${creds.ssnLast6}  dob=${creds.dob}  headed=${HEADED}  slowMo=${SLOW_MO}`,
  )
  console.log(`[local] available URLs: ${creds.reviewUrls.length}`)

  const jobId = `local-${Date.now()}`
  const evidenceRoot = `/tmp/surelc-bot-rep-${jobId}`
  await fs.mkdir(evidenceRoot, { recursive: true })
  console.log(`[local] screenshots → ${evidenceRoot}`)

  const browser = await chromium.launch({
    headless: !HEADED,
    slowMo: SLOW_MO,
    args: ["--disable-blink-features=AutomationControlled"],
  })

  const logger = pino({ name: "local-rep" })

  try {
    // Pass ALL pending URLs so the bot can chain through every
    // carrier. The first URL is the one we navigate to initially;
    // subsequent ones are reused via page.goto after each signature.
    const startIdx = Math.min(REP_URL_INDEX, creds.reviewUrls.length - 1)
    const additionalReviewUrls = creds.reviewUrls
      .map((e, i) => ({ url: e.url, idx: i }))
      .filter((x) => x.idx !== startIdx)
      .map((x) => x.url)
    console.log(`[local] additionalReviewUrls: ${additionalReviewUrls.length}`)

    const result = await repReview(
      browser,
      {
        reviewUrl,
        additionalReviewUrls,
        ssnLast6: creds.ssnLast6,
        dob: creds.dob,
        policyAccepted: false,
        maxCarriers: Number(process.env.MAX_CARRIERS ?? creds.reviewUrls.length),
        producerProfile: {
          cellPhone: process.env.PROFILE_CELL_PHONE || "(301) 648-8778",
          placeOfBirth: process.env.PROFILE_PLACE_OF_BIRTH || "Maryland",
          residentCounty: process.env.PROFILE_RESIDENT_COUNTY || "Howard",
        },
        // Sydney's actual onboarding disclosures: all false (clean
        // record). Same shape production builds from
        // questionnaire_responses. Override per-key with env vars when
        // testing positive-disclosure flows on a different agent.
        disclosures: {
          q1_felony: process.env.HAS_FELONY === "1",
          q2_misdemeanor: process.env.HAS_MISDEMEANOR === "1",
          q3_regulatory_action: process.env.HAS_REGULATORY === "1",
          q4_license_denied: process.env.HAS_LICENSE_DENIED === "1",
          q5_license_revoked: process.env.HAS_LICENSE_REVOKED === "1",
          q6_insurer_terminated: process.env.HAS_INSURER_TERMINATED === "1",
          q7_bankruptcy: process.env.HAS_BANKRUPTCY === "1",
          q14_lawsuit_pending: process.env.HAS_LAWSUIT === "1",
          q16_unsatisfied_judgments: process.env.HAS_JUDGMENTS === "1",
        },
      },
      logger,
      jobId,
    )
    console.log("\n[local] === RESULT ===")
    console.log(JSON.stringify(result, null, 2))
    if (HEADED) {
      console.log(
        "\n[local] Browser left open. Inspect the page, then Ctrl+C to exit.",
      )
      await new Promise(() => {}) // keep alive
    }
  } finally {
    if (!HEADED) await browser.close()
  }
}

main().catch((err) => {
  console.error("[local] FATAL:", err)
  process.exit(1)
})
