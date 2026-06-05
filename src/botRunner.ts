/**
 * SureLC end-to-end activation orchestrator.
 *
 * Runs in three logical phases driven off the same browser instance
 * (with separate contexts for admin and rep so cookies don't bleed):
 *
 *   PHASE A — Admin BGA login → Add producer (skip if already exists)
 *             → Fill profile (DBA / Questions / Training / E&O /
 *             Signature) → Create contracting requests (one per
 *             carrier) → Triggers SureLC to email the rep.
 *
 *   PHASE B — Rep portal: open the temporary signed URL extracted
 *             from the rep's @agent.set4lifeagency.com mailbox
 *             (read by the main app, passed in via input.repReviewUrl)
 *             → Auth with last 6 SSN + DOB → Step through the wizard
 *             for each pending carrier → "Apply My Signature".
 *
 *   PHASE C — DISABLED 2026-05-12 (Thomas). The bot must not confirm
 *             contracts to the carrier — Thomas releases At-BGA
 *             appointments BGA→Carrier manually now. The phase is
 *             still accepted in the `phases` array (for API
 *             compatibility with existing callers) but its body is
 *             a no-op: it logs `[DISABLED] Phase C skipped` and
 *             records a synthetic success result so the completion
 *             gate still fires. `bulkApiKey` / `bulkComment` /
 *             `process[]` inputs are accepted and ignored.
 *
 * Each phase is independently invocable so the main app can run them
 * with delays in between (waiting for SureLC to send emails, etc.).
 */

import { chromium, type Browser } from "playwright"
import pino from "pino"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { loginAdmin } from "./admin/login.js"
import { addProducer, changeAffiliation, type AddProducerInput } from "./admin/addProducer.js"
import { fillFullProfile, type ProfileFillInput } from "./admin/fillProfile.js"
import {
  createContractingRequests,
  type CreateRequestInput,
} from "./admin/createRequest.js"
import type { AdminReviewInput } from "./admin/processReview.js"
import { repReview, type RepReviewInput } from "./rep/review.js"
import { CHROMIUM_ARGS } from "./browserArgs.js"
import { makeTabContext, type TabResult } from "./tabs/helpers.js"
import { makeProgressReporter } from "./progressReporter.js"

export interface RunActivationInput {
  jobId: string
  agentOpenId: string
  /** Which phases to run. Defaults to all three. */
  phases?: Array<"admin_setup" | "rep_review" | "admin_process">

  /** Admin BGA portal credentials. */
  adminCreds: { email: string; password: string }

  /** Producer creation + affiliation. */
  producer: AddProducerInput

  /** Profile content for Phase A — DBA / Questions / Training / E&O / Signature. */
  profile?: Omit<ProfileFillInput, "producerId">

  /** Carrier requests to create in Phase A. */
  contracting?: Omit<CreateRequestInput, "producerId">

  /** Phase B input — only required when phase=rep_review. */
  repReview?: RepReviewInput

  /**
   * Phase C inputs — accepted for API compatibility but ignored.
   * Phase C is hard-disabled by owner directive 2026-05-12. The
   * BGA→Carrier release is done manually by the admin now. See the
   * file-level docstring.
   */
  process?: Array<Omit<AdminReviewInput, "producerId">>
  bulkApiKey?: string
  bulkComment?: string

  /**
   * Live-progress callback URL. Each step start/end POSTs the event
   * here so the admin UI can show real-time progress. Optional.
   */
  callbackUrl?: string
}

export type RunActivationStage =
  | "launched"
  | "admin_login_failed"
  | "admin_setup_complete"
  | "admin_setup_partial"
  | "rep_review_complete"
  | "rep_review_failed"
  | "admin_process_complete"
  | "admin_process_failed"
  | "complete"

export interface RunActivationResult {
  success: boolean
  stage: RunActivationStage
  producerId?: string
  phases: {
    admin_setup?: {
      ok: boolean
      addedProducer?: { ok: boolean; producerId?: string; reason?: string }
      profile?: Record<string, TabResult>
      contracting?: {
        submitted: string[]
        failed: Array<{ carrier: string; reason: string }>
      }
    }
    rep_review?: {
      ok: boolean
      signed: number
      failed: Array<{ reason: string }>
      skipped: Array<{ reason: string }>
    }
    admin_process?: {
      ok: boolean
      results: Array<{ carrier: string; ok: boolean; reason?: string }>
    }
  }
  evidenceFiles: string[]
  error?: string
  needsHumanReason?: string
}

export async function runActivation(
  input: RunActivationInput,
  logger: pino.Logger,
): Promise<RunActivationResult> {
  const evidenceDir = path.join(tmpdir(), "surelc-evidence", input.jobId)
  await fs.mkdir(evidenceDir, { recursive: true })

  const phases = new Set(
    input.phases ?? ["admin_setup", "rep_review", "admin_process"],
  )

  const browser: Browser = await chromium.launch({
    headless: true,
    // --disable-blink-features=AutomationControlled stops Chrome from
    // exposing the "I am being controlled by automation" signal that
    // bot-detection scripts read from navigator.webdriver and the
    // CDP client_id. Combined with the addInitScript on each context
    // (sets navigator.webdriver = undefined before any page JS runs),
    // this hides the most common Playwright fingerprints. Owner
    // confirmed 2026-05-06 same credentials work fine in a real
    // Chrome browser; only the bot bounces — strongest remaining
    // suspect after UA cleanup is webdriver fingerprinting.
    args: CHROMIUM_ARGS,
  })

  const result: RunActivationResult = {
    success: true,
    stage: "launched",
    phases: {},
    evidenceFiles: [],
  }

  // Live-progress reporter — POSTs each step's start/end to the main
  // app's callback URL so admin sees a real-time timeline in the
  // SureLC Activation page (per-agent expandable row).
  const progress = makeProgressReporter({
    agentOpenId: input.agentOpenId,
    callbackUrl: input.callbackUrl,
    bearerSecret: process.env.BOT_SHARED_SECRET,
    logger,
  })
  await progress.report({
    step: "bot_launched",
    status: "info",
    message: `Phases: ${[...phases].join(", ")}. Job ${input.jobId}.`,
  })

  try {
    // ── PHASE A — Admin setup ─────────────────────────────────────
    // Seed producerId from the orchestrator's existingProducerId so
    // Phase B+C combo runs (which skip admin_setup) still have a
    // producerId for Phase C. Without this, Phase C silently no-ops
    // because its `producerId` gate stays undefined — verified Sydney
    // 2026-05-07: Phase B signed 11/18 carriers but Phase C never
    // dispatched any wizard run.
    let producerId: string | undefined = input.producer.existingProducerId
    if (phases.has("admin_setup")) {
      const finishLogin = await progress.startStep(
        "phaseA_admin_login",
        "Logging into SureLC BGA admin",
      )
      const ctxBrowser = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        // Standard Chrome 124 / Linux UA. Previously we appended
        // "Set4LifeBot" to make our outbound traffic identifiable in
        // SureLC's logs, but that was a giant "I am a bot, please
        // block me" flag — owner-confirmed 2026-05-06 the SureLC
        // OAuth portal accepts the login (which is also the path
        // most-likely to be UA-checked) but every admin page (like
        // /bga/producers) bounces back to OAuth on the very first
        // navigation. Account has no MFA and works flawlessly
        // manually with the same credentials, so the only meaningful
        // remaining difference between manual + bot is the bot
        // identifier in the User-Agent. Drop it.
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      })
      // Hide navigator.webdriver before any SureLC page JS reads it.
      // I removed this 2026-05-06 thinking it was crashing pages,
      // but the post-removal run revealed the bot was getting
      // bounced to the OAuth login page on every tab navigation
      // (diagnostic showed 'visible buttons: FORGOT PASSWORD? |
      // LOGIN'). Tab navigation worked one run earlier WHEN this
      // override was active. Restore the minimal version (just the
      // webdriver flag — drop the plugins/languages/window.chrome
      // patches that may have been the actual crash source). Owner-
      // confirmed: same credentials manually open every page fine,
      // so SureLC's auth guard is reading webdriver=true and
      // refusing the session for admin pages.
      await ctxBrowser.addInitScript(() => {
        try {
          Object.defineProperty(Navigator.prototype, "webdriver", {
            get: () => undefined,
            configurable: true,
          })
        } catch {
          /* property already locked; best-effort */
        }
      })
      const page = await ctxBrowser.newPage()
      page.setDefaultTimeout(30_000)
      const tabCtx = makeTabContext(page, logger, input.jobId)

      const loginResult = await loginAdmin(page, input.adminCreds, logger)
      await finishLogin({
        ok: loginResult.ok,
        msg: loginResult.ok
          ? "Logged in"
          : loginResult.reason
            ? `Login failed — ${loginResult.reason}`
            : "Login failed — check credentials",
      })
      if (!loginResult.ok) {
        result.success = false
        result.stage = "admin_login_failed"
        result.needsHumanReason = loginResult.reason ?? "admin BGA login failed"
        await ctxBrowser.close().catch(() => {})
        return finalize(result, evidenceDir, [...tabCtx.evidenceFiles])
      }

      const adminPhase: NonNullable<RunActivationResult["phases"]["admin_setup"]> = {
        ok: true,
      }

      // Add producer (or detect existing).
      const finishAdd = await progress.startStep(
        "phaseA_add_producer",
        "Adding producer or linking existing",
      )
      const added = await addProducer(tabCtx, input.producer)
      adminPhase.addedProducer = added
      await finishAdd({
        ok: added.ok,
        msg: added.ok
          ? `Producer #${added.producerId}`
          : added.reason || "addProducer failed",
        meta: { producerId: added.producerId },
      })
      if (added.ok && added.producerId) {
        producerId = added.producerId
        result.producerId = producerId

        // Force-assign the affiliation. SureLC's "Use Always" toggle
        // on the affiliation template doesn't auto-apply for producers
        // created via API (the API ignores agency-level templates).
        // Calling changeAffiliation here makes sure every producer ends
        // up on Set4Life LOA, including ones that already exist from a
        // prior manual or API creation. Idempotent — re-applying the
        // same affiliation is a no-op on the SureLC side.
        //
        // **Affiliation is gating, not optional.** The BGA portal
        // refuses to load `/producers/{id}/{tab}` for unaffiliated
        // producers (it bounces straight back to OAuth). Sydney
        // 2026-05-07: every fillProfile tab returned `bounced to
        // OAuth` because she was "Not Affiliated" in the producer
        // list. If we can't set the affiliation, profile + Fastlane
        // can't run either — bail with `needs_human` so the timeline
        // surfaces a clear reason instead of 5 cascading tab failures.
        let affOk = false
        try {
          affOk = await changeAffiliation(
            tabCtx,
            producerId,
            input.producer.affiliationName,
          )
        } catch (err: any) {
          logger.warn({ err: err?.message }, "changeAffiliation threw")
          affOk = false
        }
        if (!affOk) {
          logger.warn(
            { producerId, affiliation: input.producer.affiliationName },
            "changeAffiliation failed — bailing admin_setup before profile/contracting",
          )
          adminPhase.ok = false
          result.success = false
          result.stage = "admin_setup_partial"
          result.needsHumanReason =
            `Could not set affiliation "${input.producer.affiliationName}" on producer ${producerId}. ` +
            `BGA profile tabs are inaccessible without affiliation; admin must set it manually in SureLC, then re-run the bot.`
          return result
        }
      } else {
        adminPhase.ok = false
      }

      // Fill profile.
      // Owner directive 2026-05-05: tab failures must NOT block Phase
      // A — the bot continues regardless so it always reaches
      // Fastlane (the contracting submit). Tab failures are still
      // logged + shown in the timeline; only Fastlane failure marks
      // the whole admin phase as failed.
      if (producerId && input.profile) {
        adminPhase.profile = await fillFullProfile(tabCtx, {
          ...input.profile,
          producerId,
        })
        // Emit one timeline event per tab so admin sees per-tab status
        // rather than a single "Profile tabs running" line.
        for (const [tabName, r] of Object.entries(adminPhase.profile)) {
          await progress.report({
            step: `phaseA_profile_${tabName}`,
            status: r.ok || r.alreadyDone ? "success" : "failed",
            message: r.alreadyDone
              ? "Already done — skipped"
              : r.ok
                ? "Filled"
                : r.reason || "failed",
            metadata: r.details as any,
          })
        }
        const failedTabNames = Object.entries(adminPhase.profile)
          .filter(([, r]) => !r.ok && !r.alreadyDone)
          .map(([name]) => name)
        const failedCount = failedTabNames.length
        const totalCount = Object.values(adminPhase.profile).length
        await progress.report({
          step: "phaseA_fill_profile_all",
          status: failedCount === 0 ? "success" : "failed",
          message:
            failedCount === 0
              ? `All ${totalCount} tabs OK — proceeding to contracting`
              : `${totalCount - failedCount}/${totalCount} tabs OK — ` +
                `BLOCKING contracting until ${failedTabNames.join(", ")} ` +
                `${failedCount === 1 ? "is" : "are"} fixed`,
        })
      }

      // Contracting requests via Fastlane (per Loom + verified 2026-05-07).
      //
      // The producer's own /bga/producers/{id}/contracts tab only
      // shows ACTIVE/TERMINATED/NIPR appointments — read-only, no
      // "New Contracting Request" button. The previous per-carrier
      // wizard implementation looked for buttons that don't exist on
      // that tab (Sydney 2026-05-07 04:02: bot landed on Contracts
      // tab cleanly, but admin-contracting-before screenshot showed
      // an empty ACTIVE(0) list with only "ADD CONTRACT RECORD" — a
      // manual entry button for already-existing contracts, not a
      // way to REQUEST new ones).
      //
      // Per the Loom (10:24-11:12), the canonical contract-request
      // submit is **Fastlane** → "1 Producer, Multiple Carriers" →
      // SELECT producer → ADD ALL → NEXT through States/Products →
      // SUBMIT. The fastlane.ts module already implements this flow.
      // Older comments here said Fastlane bounces to OAuth — that
      // claim was from before the affiliation/profile-entry fixes
      // that solved the "BGA session lost on agency URLs" class of
      // bugs. Re-test Fastlane now that the rest of the flow works.
      if (producerId && input.contracting) {
        // Gate: do not submit contracting requests until every
        // required profile tab is complete. Owner directive
        // 2026-05-06: contracting must NEVER fire on a half-filled
        // profile. SureLC's validation rules would reject the
        // submission anyway (and worse, partial submissions create
        // half-baked appointment-request rows that BGAs then have
        // to manually clean up). Fail fast with a clear message
        // listing exactly which tabs blocked the gate.
        const incompleteTabs = adminPhase.profile
          ? Object.entries(adminPhase.profile)
              .filter(([, r]) => !r.ok && !r.alreadyDone)
              .map(([name, r]) => `${name} (${r.reason || "incomplete"})`)
          : []
        if (incompleteTabs.length > 0) {
          const finishGate = await progress.startStep(
            "phaseA_contracting",
            "Submitting contracting requests via Fastlane",
          )
          adminPhase.contracting = {
            submitted: [],
            failed: [
              {
                carrier: "(gate)",
                reason: `profile incomplete: ${incompleteTabs.join("; ")}`,
              },
            ],
          }
          adminPhase.ok = false
          await finishGate({
            ok: false,
            msg:
              "Contracting BLOCKED — profile is not fully filled. " +
              `Fix these tab(s) first and re-run: ${incompleteTabs.join("; ")}.`,
          })
        } else {
          const finishContracting = await progress.startStep(
            "phaseA_contracting",
            "Submitting contracting requests via Fastlane",
          )

          // Pre-Fastlane self-clean: each Phase A re-fire creates
          // duplicate appointment-request rows for every carrier
          // not yet at Carrier stage. Without dedup, retries pile
          // up dupes (Zachary 2026-05-09: 72 rows for 9 carriers).
          // dedupAppointmentRequests deletes duplicates and reports
          // current per-carrier stage. If we already have ALL 9
          // carriers active (any stage), we SKIP Fastlane below.
          let preDedupSkipsFastlane = false
          if (producerId) {
            try {
              const { dedupAppointmentRequests } = await import(
                "./admin/dedupAppointmentRequests.js"
              )
              const dedup = await dedupAppointmentRequests(
                tabCtx.page,
                producerId,
                "1322",
                logger,
              )
              if (dedup) {
                logger.info({ producerId, dedup }, "[Fastlane] pre-dedup result")
                // Skip Fastlane if the producer has ANY active
                // appointment-requests. Fastlane is a "submit one
                // producer for many carriers" wizard — it doesn't
                // take a missing-carriers list, it just creates a
                // fresh Producer-stage row for every configured
                // carrier. Firing on top of existing active rows
                // produces the BGA duplicates that Ana then has to
                // discard by hand (2026-05-23 incident; previously
                // Tonette 2026-05-18→05-20 and Zachary 2026-05-09).
                //
                // The earlier `>= 8 OR (deleted > 0 with active)`
                // threshold was a workaround for the 8-active-rep
                // common case; reps stuck at 1–7 active still
                // triggered Fastlane each retry and accumulated
                // dupes. Now: if the dedup pass found any alive
                // request, contracting is considered already-
                // submitted — admin handles further additions
                // manually via the BGA portal. The brand-new case
                // (zero alive) still fires Fastlane normally.
                if (dedup.uniqueCarriers >= 1) {
                  adminPhase.contracting = {
                    submitted: ["already-submitted-skipped-fastlane"],
                    failed: [],
                  }
                  await finishContracting({
                    ok: true,
                    msg: `Skipped Fastlane — already have ${dedup.uniqueCarriers} active appointment-request(s) (deleted ${dedup.deleted} dup(s))`,
                  })
                  preDedupSkipsFastlane = true
                }
                // else dedup.uniqueCarriers === 0 → confirmed zero active
                // requests → genuine first-time contracting; Fastlane
                // runs normally below.
              } else {
                // dedup === null: could not read existing-request state.
                // FAIL-SAFE: skip Fastlane rather than risk duplicates.
                logger.warn(
                  { producerId },
                  "[Fastlane] pre-dedup returned null — SKIPPING Fastlane (fail-safe; cannot verify existing requests)",
                )
                adminPhase.contracting = {
                  submitted: ["deferred-dedup-null"],
                  failed: [],
                }
                await finishContracting({
                  ok: true,
                  msg: "Skipped Fastlane — could not verify existing appointment-requests; deferring to manual carrier add to avoid duplicates",
                })
                preDedupSkipsFastlane = true
              }
            } catch (err: any) {
              // FAIL-SAFE (2026-06-05 incident): a transient dedup error
              // must NOT fall through to Fastlane — that path duplicated
              // ~17 agents' carrier requests in one day. If we can't
              // verify existing state, skip Fastlane and defer to a
              // manual carrier add.
              logger.warn(
                { err: err?.message },
                "[Fastlane] pre-dedup threw — SKIPPING Fastlane (fail-safe; no duplicate submissions)",
              )
              adminPhase.contracting = {
                submitted: ["deferred-dedup-threw"],
                failed: [],
              }
              await finishContracting({
                ok: true,
                msg: `Skipped Fastlane — pre-dedup check failed (${err?.message ?? "error"}); deferring to manual carrier add to avoid duplicates`,
              })
              preDedupSkipsFastlane = true
            }
          }
          if (!preDedupSkipsFastlane) {
            const { runFastlaneOneProducerManyCarriers } = await import(
              "./admin/fastlane.js"
            )
            // Producer display name in SureLC is `LASTNAME, FIRSTNAME`
            // (uppercase, comma-separated) — verified across all 8
            // producers in the agency list 2026-05-07.
            const lastName = (input.producer.lastName || "").toUpperCase()
            const firstName = (input.producer.firstName || "").toUpperCase()
            const producerDisplayName = lastName && firstName
              ? `${lastName}, ${firstName}`
              : input.producer.lastName || ""
            const r = await runFastlaneOneProducerManyCarriers(tabCtx, {
              producerDisplayName,
              producerId,
            })
            adminPhase.contracting = {
              submitted: r.ok ? ["all-via-fastlane"] : [],
              failed: r.ok
                ? []
                : [{ carrier: "(fastlane)", reason: r.reason || "Fastlane failed" }],
            }
            if (!r.ok) adminPhase.ok = false
            await finishContracting({
              ok: r.ok,
              msg: r.ok
                ? `Fastlane submitted (one-producer/many-carriers)`
                : r.reason || `Fastlane failed`,
            })

            // Post-Fastlane: for any carrier the agent declared a
            // prior contracting with during onboarding, flip the
            // appointment-request type from Contract → Transfer via
            // the BGA portal API. Fastlane itself has no transfer
            // affordance, so without this step the carrier would
            // decline the request (rep is already on file with their
            // previous broker). LOR file upload is a separate phase
            // — pending route discovery.
            if (r.ok) {
              const transferCarrierNames = (input.contracting?.carriers || [])
                .filter((c) => c.requestType === "Transfer")
                .map((c) => c.carrierName)
                .filter((n): n is string => !!n)
              if (transferCarrierNames.length > 0) {
                try {
                  const { setTransferTypesForProducer } = await import(
                    "./admin/setTransferTypes.js"
                  )
                  const flipResult = await setTransferTypesForProducer(
                    tabCtx.page,
                    logger,
                    { producerId, transferCarrierNames },
                  )
                  logger.info(
                    {
                      flipped: flipResult.flipped,
                      alreadyTransfer: flipResult.alreadyTransfer,
                      notFound: flipResult.notFound,
                      failed: flipResult.failed,
                    },
                    "[Phase A] post-Fastlane transfer-type flip",
                  )
                  // Surface failures back into the contracting result
                  // so the timeline + admin alert see them.
                  if (flipResult.failed.length > 0) {
                    adminPhase.contracting.failed.push(
                      ...flipResult.failed.map((f) => ({
                        carrier: `${f.carrier} (transfer flip)`,
                        reason: f.reason,
                      })),
                    )
                  }
                } catch (err: any) {
                  logger.warn(
                    { err: err?.message },
                    "[Phase A] transfer-type flip threw — non-blocking",
                  )
                }
              }
            }
          }
        }
      }

      result.phases.admin_setup = adminPhase
      result.stage = adminPhase.ok ? "admin_setup_complete" : "admin_setup_partial"
      // Surface a concrete reason whenever Phase A doesn't fully
      // succeed. Owner reported 2026-05-05 the timeline was showing
      // "(no reason returned)" because we only set needsHumanReason
      // for admin_login_failed. Now we synthesize one from whichever
      // sub-step actually failed (addProducer, Fastlane, or per-tab).
      if (!adminPhase.ok) {
        const reasons: string[] = []
        if (adminPhase.addedProducer && !adminPhase.addedProducer.ok) {
          reasons.push(
            `addProducer: ${adminPhase.addedProducer.reason || "unknown"}`,
          )
        }
        if (adminPhase.contracting?.failed?.length) {
          reasons.push(
            `contracting: ${adminPhase.contracting.failed
              .map((f) => `${f.carrier}=${f.reason}`)
              .join("; ")}`,
          )
        }
        if (adminPhase.profile) {
          const failedTabs = Object.entries(adminPhase.profile)
            .filter(([, r]) => !r.ok && !r.alreadyDone)
            .map(([t, r]) => `${t}=${r.reason || "failed"}`)
          if (failedTabs.length) reasons.push(`tabs: ${failedTabs.join("; ")}`)
        }
        result.needsHumanReason =
          reasons.join(" | ") || "Phase A partial — see screenshots"
      }
      result.evidenceFiles.push(...tabCtx.evidenceFiles)
      await ctxBrowser.close().catch(() => {})
    }

    // ── PHASE B — Rep review ──────────────────────────────────────
    if (phases.has("rep_review") && input.repReview) {
      const finishRep = await progress.startStep(
        "phaseB_rep_review",
        "Rep auth (last 6 SSN + DOB) + signing each carrier",
      )
      try {
        const r = await repReview(browser, input.repReview, logger, input.jobId)
        result.phases.rep_review = r
        result.stage = r.ok ? "rep_review_complete" : "rep_review_failed"
        if (!r.ok) result.success = false
        const skippedCount = r.skipped?.length ?? 0
        await finishRep({
          ok: r.ok,
          msg: r.ok
            ? `Signed ${r.signed} carrier(s)${skippedCount ? `, ${skippedCount} skipped (withdrawn)` : ""}`
            : `Signed ${r.signed}, ${r.failed.length} failed${skippedCount ? `, ${skippedCount} skipped (withdrawn)` : ""}`,
          meta: r as any,
        })
      } catch (err: any) {
        result.phases.rep_review = {
          ok: false,
          signed: 0,
          failed: [{ reason: err?.message || "exception" }],
          skipped: [],
        }
        result.success = false
        result.stage = "rep_review_failed"
        await finishRep({ ok: false, msg: `Threw: ${err?.message || "exception"}` })
      }
    }

    // ── PHASE C — Admin process ───────────────────────────────────
    // Owner directive 2026-05-12 (Thomas): the bot must NOT send
    // contract confirmations to carriers. Phase C (BGA → Carrier
    // release) is the "confirmation" step — Thomas processes those
    // manually now. Hard-gate here so any caller (auto-chain, debug
    // endpoint, admin UI manual trigger) gets a clean no-op + log
    // line rather than the bot silently re-enabling itself if a
    // future caller starts passing bulkApiKey again.
    if (phases.has("admin_process")) {
      logger.warn(
        {
          producerId,
          hadBulkApiKey: !!input.bulkApiKey,
          legacyProcessCount: input.process?.length ?? 0,
        },
        "[DISABLED] Phase C skipped — owner directive: bot must not confirm contracts to carrier",
      )
      result.phases.admin_process = {
        ok: true,
        results: [
          {
            carrier: "(disabled)",
            ok: true,
            reason:
              "Phase C disabled by owner directive — admin processes BGA→Carrier manually",
          },
        ],
      }
      await progress.report({
        step: "phaseC_disabled",
        status: "info",
        message:
          "Phase C skipped by policy — admin will release At-BGA appointments manually",
      })
    }

    if (
      result.phases.admin_setup?.ok &&
      (!input.repReview || result.phases.rep_review?.ok) &&
      (!input.process?.length || result.phases.admin_process?.ok)
    ) {
      result.stage = "complete"
    }
    await progress.report({
      step: "bot_finished",
      status: result.success ? "success" : "failed",
      message: `Final stage: ${result.stage}`,
    })

    return finalize(result, evidenceDir, result.evidenceFiles)
  } catch (err: any) {
    result.success = false
    result.error = err?.message || "orchestrator threw"
    return finalize(result, evidenceDir, result.evidenceFiles)
  } finally {
    await browser.close().catch(() => {})
  }
}

function finalize(
  result: RunActivationResult,
  evidenceDir: string,
  files: string[],
): RunActivationResult {
  result.evidenceFiles = files
  void evidenceDir // referenced by the file paths
  return result
}
