import express from "express"
import { z } from "zod"
import pino from "pino"
import { runActivation, type RunActivationInput } from "./botRunner.js"
import { captureBgaTokens } from "./bgaTokenCapture.js"
import { CHROMIUM_ARGS, launchChromium, browserPoolStats } from "./browserArgs.js"
import { getAuthenticatedPage } from "./admin/sessionCache.js"

const logger = pino({ name: "s4l-surelc-bot" })

const BEARER = process.env.BOT_SHARED_SECRET || ""
if (!BEARER) {
  logger.warn(
    "BOT_SHARED_SECRET not set — container will run but all requests will 401",
  )
}

const adminCredsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const producerSchema = z.object({
  ssn: z.string(),
  lastName: z.string(),
  firstName: z.string().optional(),
  dob: z.string().optional(),
  email: z.string().email(),
  phone: z.string().optional(),
  affiliationName: z.string(),
  // When the main app already has the SureLC producerId, pass it in so
  // the bot skips the "Add Producer" search/add flow and goes straight
  // to filling the profile. Prevents the "Add Producer button not
  // found" dead-end seen for Zach Love (producer 11474885 already on
  // file) on 2026-05-05.
  existingProducerId: z.string().optional(),
})

const profileSchema = z.object({
  residentAddress: z
    .object({
      addressLine1: z.string().min(1),
      addressLine2: z.string().optional(),
      city: z.string().min(1),
      state: z.string().min(2).max(2),
      postalCode: z.string().min(5),
    })
    .optional(),
  dba: z
    .object({
      // Owner directive 2026-05-05: SureLC producers are ALWAYS created
      // as "License Only" regardless of how the agent signed up in
      // Set4Life. Even if a future caller passes "Business Only" the
      // schema rejects it — they have to literal-string match the only
      // accepted value. fillProfile.ts has a redundant guard that
      // coerces anything else back to "License Only" too.
      businessType: z.literal("License Only").optional(),
      solicitingFor: z.string(),
    })
    .optional(),
  questions: z
    .object({
      surelcAnswers: z
        .record(
          z.string(),
          z.object({
            answer: z.enum(["yes", "no"]),
            occurrenceDate: z.string().optional(),
            documents: z
              .array(
                z.object({
                  url: z.string().url(),
                  fileName: z.string().optional(),
                  slot: z.string().optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
      questionTexts: z.record(z.string(), z.string()).optional(),
      attestationName: z.string().optional(),
      attestationDate: z.string().optional(),
      attestationInitials: z.string().optional(),
      finraRegistered: z.boolean().optional(),
      finraCrd: z.string().optional(),
      militaryStatus: z.enum(["none", "active", "reserve", "veteran"]).optional(),
      employmentHistory: z
        .array(
          z.object({
            employer: z.string(),
            position: z.string(),
            startDate: z.string(),
            endDate: z.string().optional(),
            address: z.string().optional(),
          }),
        )
        .optional(),
      addressHistory: z
        .array(
          z.object({
            street: z.string(),
            city: z.string(),
            state: z.string(),
            zip: z.string(),
            from: z.string(),
            to: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  training: z
    .object({
      amlCompletionDate: z.string().optional(),
      amlCertificateUrl: z.string().url().optional(),
      amlProvider: z.string().optional(),
      amlCourseName: z.string().optional(),
      ltcRiderCompleted: z.boolean().optional(),
    })
    .optional(),
  eno: z
    .object({
      provider: z.string().optional(),
      policyNumber: z.string().optional(),
      effectiveDate: z.string().optional(),
      expirationDate: z.string().optional(),
      coverageAmount: z.string().optional(),
      caseLimit: z.number().int().positive().optional(),
      totalLimit: z.number().int().positive().optional(),
      certificateUrl: z.string().url().optional(),
    })
    .optional(),
  signature: z
    .object({
      signatureImageUrl: z.string().url().optional(),
      // The fully-rendered Signature Authorization PDF (legal text +
      // cursive signature + audit stamp). Pulled from
      // agents.signatureAuthPdfUrl. fillSignature.ts prefers this
      // over the bare image and crops the signature out of it.
      signatureAuthPdfUrl: z.string().url().optional(),
      // When true, click REMOVE on an existing signature before
      // uploading fresh. Without this, the bot's "REMOVE+EDIT
      // visible → already-done" heuristic strands producers with
      // a stale/broken signature that Fastlane refuses ("N issues").
      // Set by the main app's activationPipeline when input.force===true.
      forceReupload: z.boolean().optional(),
    })
    .optional(),
})

const carrierSchema = z.object({
  carrierName: z.string(),
  carrierNaic: z.string().optional(),
  requestType: z.enum(["Contract", "Transfer", "Recontract"]).optional(),
  products: z.array(z.string()).optional(),
  states: z.array(z.string()).optional(),
  carrierQuestions: z.record(z.string(), z.enum(["yes", "no"])).optional(),
  reviewEmailOverride: z.string().email().optional(),
  /**
   * Letter of Release (absolute S3 URL) for a requestType="Transfer"
   * carrier. Sent by the main app's activationPipeline from
   * agent_carrier_contracting.releaseFormUrl.
   *
   * Flipping a request to "Transfer" (see admin/setTransferTypes) is
   * precisely what makes the carrier ask for an LOR instead of treating
   * the rep as a fresh appointment — so without this the bot opts every
   * transfer into a requirement it cannot satisfy. See
   * admin/uploadReleaseForms for the consumer.
   */
  releaseFormUrl: z.string().url().optional(),
})

const contractingSchema = z.object({
  defaultReviewEmail: z.string().email(),
  carriers: z.array(carrierSchema),
})

const repReviewSchema = z.object({
  reviewUrl: z.string().url(),
  /**
   * Additional pending appointment URLs the bot should chain through
   * after signing the first one. Each is the same /sbweb/login.jsp
   * format with a different appointmentId. Without this Phase B can
   * only process 1 carrier (the initial reviewUrl), regardless of
   * maxCarriers — verified production 2026-05-07 17:16: bot reported
   * "signed:1, attempted:1" because additionalReviewUrls was being
   * stripped by Zod (field wasn't in schema).
   */
  additionalReviewUrls: z.array(z.string().url()).optional(),
  ssnLast6: z.string(),
  dob: z.string(),
  policyAccepted: z.boolean().optional(),
  maxCarriers: z.number().int().positive().optional(),
  /**
   * Pre-fill the wizard for the rep but bail BEFORE the Step 6 sign
   * action. SureLC auto-saves each step on Next so the rep lands on
   * Step 6 with disclosures + carrier-questions already filled when
   * they later log in. See rep/review.ts RepReviewInput.prefillOnly.
   */
  prefillOnly: z.boolean().optional(),
  /** Per-carrier text inputs (cellPhone, placeOfBirth, residentCounty). */
  producerProfile: z
    .object({
      cellPhone: z.string().optional(),
      homePhone: z.string().optional(),
      placeOfBirth: z.string().optional(),
      residentCounty: z.string().optional(),
      email: z.string().optional(),
      fallback: z.string().optional(),
    })
    .optional(),
  /**
   * Onboarding disclosure flags so the bot answers per-question Y/N
   * accurately. Mirrors questionnaire_responses columns (q1_felony …
   * q19_irs_matters). Defaults to "all No" when missing.
   */
  disclosures: z
    .object({
      q1_felony: z.boolean().optional(),
      q2_misdemeanor: z.boolean().optional(),
      q3_regulatory_action: z.boolean().optional(),
      q3_securities_violation: z.boolean().optional(),
      q4_license_denied: z.boolean().optional(),
      q5_license_revoked: z.boolean().optional(),
      q6_insurer_terminated: z.boolean().optional(),
      q7_bankruptcy: z.boolean().optional(),
      q7_bankruptcy_personal: z.boolean().optional(),
      q7_firm_bankruptcy: z.boolean().optional(),
      q7_bankruptcy_pending: z.boolean().optional(),
      q8_bond_denied: z.boolean().optional(),
      q9_unpaid_premiums: z.boolean().optional(),
      q10_fiduciary_breach: z.boolean().optional(),
      q11_fraud_investigation: z.boolean().optional(),
      q12_consent_order: z.boolean().optional(),
      q13_ce_violation: z.boolean().optional(),
      q14_lawsuit_pending: z.boolean().optional(),
      q15_eo_claim: z.boolean().optional(),
      q16_unsatisfied_judgments: z.boolean().optional(),
      q17_financial_institution: z.boolean().optional(),
      q18_other_names: z.boolean().optional(),
      q19_irs_matters: z.boolean().optional(),
    })
    .optional(),
  /**
   * Per-disclosure explanation letters + supporting docs (from
   * questionnaire_responses.surelc_answers). Used to fill the red
   * "ADD" explanation modal on a carrier's Carrier-Questions step when
   * a "Yes" answer demands a description/attachment. See
   * rep/review.ts fillCarrierQuestionExplanations.
   */
  carrierQuestionExplanations: z
    .array(
      z.object({
        questionText: z.string().optional(),
        occurrenceDate: z.string().optional(),
        explanation: z.string().optional(),
        docUrl: z.string().optional(),
        fileName: z.string().optional(),
      }),
    )
    .optional(),
})

const processSchema = z.object({
  requestId: z.string().optional(),
  carrierName: z.string(),
  recruiterName: z.string(),
  certifiedByName: z.string(),
  carrierAgencyAnswers: z.record(z.string(), z.string()).optional(),
})

const activationSchema = z.object({
  jobId: z.string().min(1),
  agentOpenId: z.string().min(1),
  phases: z
    .array(z.enum(["admin_setup", "rep_review", "admin_process"]))
    .optional(),
  adminCreds: adminCredsSchema,
  producer: producerSchema,
  profile: profileSchema.optional(),
  contracting: contractingSchema.optional(),
  repReview: repReviewSchema.optional(),
  process: z.array(processSchema).optional(),
  /**
   * Phase C bulk-mode credential. When set, the bot calls
   * bulkProcessBga (single PUT per At-BGA appointment) instead of
   * walking the 8-step wizard. The orchestrator should always pass
   * SURELC_API_TOKEN here.
   */
  bulkApiKey: z.string().optional(),
  bulkComment: z.string().optional(),
  callbackUrl: z.string().url().optional(),
})

const app = express()
app.use(express.json({ limit: "1mb" }))

app.get("/health", (_req, res) => {
  // browserPool makes the 2026-07-27 starvation visible before it bites:
  // sustained queued>0 means runs are waiting on a browser, and active
  // pinned at max with a growing queue is the shape that used to end in
  // "operation aborted due to timeout" alerts.
  res.json({ ok: true, browserPool: browserPoolStats() })
})

app.post("/run-activation", async (req, res) => {
  const auth = req.headers.authorization || ""
  if (!BEARER || auth !== `Bearer ${BEARER}`) {
    return res.status(401).json({ error: "unauthorized" })
  }
  const parsed = activationSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: "bad_request", issues: parsed.error.issues })
  }
  const input = parsed.data as RunActivationInput
  logger.info(
    { jobId: input.jobId, agentOpenId: input.agentOpenId, phases: input.phases },
    "starting activation",
  )
  try {
    const result = await runActivation(input, logger)
    return res.json(result)
  } catch (err: any) {
    logger.error({ err: err?.message, jobId: input.jobId }, "runActivation threw")
    return res.status(500).json({
      success: false,
      error: err?.message || "bot crashed",
    })
  }
})

const bgaTokensSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

/**
 * POST /producer-appointments
 *
 * Logs into the BGA portal as the admin service account, harvests a
 * Bearer JWT from the SPA's outbound traffic, and calls the internal
 * /surecrm/appointments-requests endpoint to retrieve the producer's
 * full appointment-request list (including CARRIER-stage records the
 * public x-api-key endpoint hides). Returns the appointments raw so
 * the main app can sync them into agent_carrier_contracting.
 *
 * Used by syncLocalContracts.ts as a fallback when the public API
 * returns 0 records — typically because all the producer's contracts
 * already moved to CARRIER stage and the public API drops them from
 * its in-progress view.
 */
const producerAppointmentsSchema = z.object({
  producerId: z.string().min(1),
  adminCreds: adminCredsSchema,
  /** Defaults to 1322 (Set 4 Life). */
  gaId: z.number().int().positive().optional(),
})
app.post("/producer-appointments", async (req, res) => {
  const auth = req.headers.authorization || ""
  if (!BEARER || auth !== `Bearer ${BEARER}`) {
    return res.status(401).json({ error: "unauthorized" })
  }
  const parsed = producerAppointmentsSchema.safeParse(req.body)
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "bad_request", issues: parsed.error.issues })
  }
  const { producerId, adminCreds } = parsed.data
  const gaId = parsed.data.gaId ?? 1322
  try {
    const { chromium } = await import("playwright")
    const { loginAdmin } = await import("./admin/login.js")
    const browser = await launchChromium(logger)
    try {
      const { page, loginResult } = await getAuthenticatedPage(
        browser,
        adminCreds,
        logger,
        { contextOptions: { viewport: { width: 1280, height: 900 } } },
      )
      if (loginResult && !loginResult.ok) {
        return res
          .status(502)
          .json({ ok: false, error: loginResult.reason || "admin login failed" })
      }
      // Harvest Bearer from the SPA's outbound traffic.
      let bearer = ""
      const handler = (req: any) => {
        const a = req.headers()["authorization"]
        if (
          !bearer &&
          req.url().includes("/surecrm/") &&
          typeof a === "string" &&
          a.startsWith("Bearer ")
        ) {
          bearer = a.replace(/^Bearer /, "")
          page.off("request", handler)
        }
      }
      page.on("request", handler)
      await page
        .evaluate((id) => {
          history.pushState({}, "", `/bga/producers/${id}/profile`)
          window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
        }, producerId)
        .catch(() => undefined)
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !bearer) {
        await page.waitForTimeout(250)
      }
      if (!bearer) {
        return res
          .status(502)
          .json({ ok: false, error: "could not harvest Bearer from SPA" })
      }
      const r = await fetch(
        `https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${producerId}&gaId=${gaId}`,
        { headers: { Authorization: `Bearer ${bearer}` } },
      )
      if (!r.ok) {
        return res
          .status(502)
          .json({ ok: false, error: `SPA fetch HTTP ${r.status}` })
      }
      const appointments = (await r.json()) as Array<Record<string, unknown>>
      return res.json({ ok: true, count: appointments.length, appointments })
    } finally {
      await browser.close().catch(() => {})
    }
  } catch (err: any) {
    logger.error({ err: err?.message }, "/producer-appointments threw")
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "bot crashed" })
  }
})

/**
 * POST /resend-rep-emails
 *
 * For a given producer, list all Producer-stage appointment-requests
 * and POST to /surecrm/appointments-requests/{id}/email to make
 * SureLC re-dispatch the rep-review email. Used when Phase B finds
 * "no email arrived in time" — typically because the original email
 * was already used 13+ hours ago and the link is one-shot consumed.
 *
 * Returns: { ok, resent: [{ id, carrierName, status }] }
 *
 * Discovered 2026-05-09 — Keyon Foresters + Josue MoO/Corebridge
 * stuck at Producer stage, original review emails one-shot used.
 * /surecrm/appointments-requests/{id}/email returns 204 to re-dispatch.
 */
const resendRepEmailsSchema = z.object({
  producerId: z.string().min(1),
  adminCreds: adminCredsSchema,
  gaId: z.number().int().positive().optional(),
})
app.post("/resend-rep-emails", async (req, res) => {
  const auth = req.headers.authorization || ""
  if (!BEARER || auth !== `Bearer ${BEARER}`) {
    return res.status(401).json({ error: "unauthorized" })
  }
  const parsed = resendRepEmailsSchema.safeParse(req.body)
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "bad_request", issues: parsed.error.issues })
  }
  const { producerId, adminCreds } = parsed.data
  const gaId = parsed.data.gaId ?? 1322
  try {
    const { chromium } = await import("playwright")
    const { loginAdmin } = await import("./admin/login.js")
    const browser = await launchChromium(logger)
    try {
      const { page, loginResult } = await getAuthenticatedPage(
        browser,
        adminCreds,
        logger,
        { contextOptions: { viewport: { width: 1280, height: 900 } } },
      )
      if (loginResult && !loginResult.ok) {
        return res.status(502).json({ ok: false, error: loginResult.reason || "admin login failed" })
      }
      let bearer = ""
      const handler = (req: any) => {
        const a = req.headers()["authorization"]
        if (
          !bearer &&
          req.url().includes("/surecrm/") &&
          typeof a === "string" &&
          a.startsWith("Bearer ")
        ) {
          bearer = a.replace(/^Bearer /, "")
          page.off("request", handler)
        }
      }
      page.on("request", handler)
      await page
        .evaluate((id) => {
          history.pushState({}, "", `/bga/producers/${id}/profile`)
          window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
        }, producerId)
        .catch(() => undefined)
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !bearer) {
        await page.waitForTimeout(250)
      }
      if (!bearer) {
        return res.status(502).json({ ok: false, error: "could not harvest Bearer from SPA" })
      }

      const listRes = await fetch(
        `https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${producerId}&gaId=${gaId}`,
        { headers: { Authorization: `Bearer ${bearer}` } },
      )
      if (!listRes.ok) {
        return res.status(502).json({ ok: false, error: `appointments-requests HTTP ${listRes.status}` })
      }
      const requests = (await listRes.json()) as Array<{
        appointmentRequestId: number
        stage: string
        carrierName: string
      }>
      const stuck = (Array.isArray(requests) ? requests : []).filter((r) => r.stage === "Producer")
      const resent: Array<{ id: number; carrierName: string; status: number }> = []
      for (const r of stuck) {
        const id = r.appointmentRequestId
        try {
          const x = await fetch(
            `https://surelc.surancebay.com/surecrm/appointments-requests/${id}/email`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${bearer}`,
                "Content-Type": "application/json",
              },
              body: "{}",
            },
          )
          resent.push({ id, carrierName: r.carrierName, status: x.status })
        } catch (err: any) {
          logger.warn({ err: err?.message, id }, "resend-rep-email POST threw")
          resent.push({ id, carrierName: r.carrierName, status: 0 })
        }
      }
      return res.json({ ok: true, count: resent.length, resent })
    } finally {
      await browser.close().catch(() => {})
    }
  } catch (err: any) {
    logger.error({ err: err?.message }, "/resend-rep-emails threw")
    return res.status(500).json({ ok: false, error: err?.message || "bot crashed" })
  }
})

/**
 * POST /create-appointment-requests
 *
 * Direct API fallback for when Fastlane's wizard is broken (e.g.,
 * SureLC's upstream Sandi Kruise training-cert provider down → wizard
 * "Red notices" block) — Demetrius 2026-05-10 case. POSTs to
 * /surecrm/appointments-requests directly per carrier, copying a
 * working template from a sibling agent (resident-state config that
 * we know SureLC accepts at Producer/BGA stage). Phase C bulk-release
 * then advances BGA → Carrier.
 *
 * Body: { producerId, gaId?, templateProducerId, residentState? }
 *   - producerId: target rep
 *   - gaId: defaults to 1322 (Set4Life)
 *   - templateProducerId: another rep whose Carrier-stage appointments
 *     we copy as the field template (Sydney 11482453 is a good source)
 *   - residentState: state to use (defaults to producer's resident state
 *     fetched from SureLC license API)
 *
 * Returns: { ok, count, created: [{ carrier, status }] }
 */
const createAppointmentRequestsSchema = z.object({
  producerId: z.string().min(1),
  templateProducerId: z.string().min(1),
  adminCreds: adminCredsSchema,
  gaId: z.number().int().positive().optional(),
  residentState: z.string().length(2).optional(),
})
app.post("/create-appointment-requests", async (req, res) => {
  const auth = req.headers.authorization || ""
  if (!BEARER || auth !== `Bearer ${BEARER}`) {
    return res.status(401).json({ error: "unauthorized" })
  }
  const parsed = createAppointmentRequestsSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: "bad_request", issues: parsed.error.issues })
  }
  const { producerId, templateProducerId, adminCreds, residentState } = parsed.data
  const gaId = parsed.data.gaId ?? 1322
  try {
    const { chromium } = await import("playwright")
    const { loginAdmin } = await import("./admin/login.js")
    const browser = await launchChromium(logger)
    try {
      const { page, loginResult } = await getAuthenticatedPage(
        browser,
        adminCreds,
        logger,
        { contextOptions: { viewport: { width: 1280, height: 900 } } },
      )
      if (loginResult && !loginResult.ok) {
        return res.status(502).json({ ok: false, error: loginResult.reason || "admin login failed" })
      }
      let bearer = ""
      const handler = (req: any) => {
        const a = req.headers()["authorization"]
        if (!bearer && req.url().includes("/surecrm/") && typeof a === "string" && a.startsWith("Bearer ")) {
          bearer = a.replace(/^Bearer /, "")
          page.off("request", handler)
        }
      }
      page.on("request", handler)
      await page.evaluate((id) => {
        history.pushState({}, "", `/bga/producers/${id}/profile`)
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
      }, producerId).catch(() => undefined)
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !bearer) await page.waitForTimeout(250)
      if (!bearer) return res.status(502).json({ ok: false, error: "could not harvest Bearer" })

      // Default resident state from rep's licenses if not provided
      let state = residentState
      if (!state) {
        const lic = await fetch(`https://surelc.surancebay.com/surecrm/licenses/producer/${producerId}`, {
          headers: { Authorization: `Bearer ${bearer}` },
        }).then((r) => (r.ok ? r.json() : []))
        const resident = (Array.isArray(lic) ? lic : []).find(
          (l: any) => l.isResidentLicense === "Y" && l.status === "Active",
        )
        state = resident?.state
      }
      if (!state) return res.status(400).json({ ok: false, error: "no resident state found" })

      // Producer's existing non-Discarded carriers — skip these
      const existing = await fetch(
        `https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${producerId}&gaId=${gaId}`,
        { headers: { Authorization: `Bearer ${bearer}` } },
      ).then((r) => r.json())
      const existingCarriers = new Set(
        (Array.isArray(existing) ? existing : [])
          .filter((a: any) => a.stage !== "Discarded")
          .map((a: any) => a.carrierName),
      )

      // Get an existing appointment from the producer (any) to copy
      // npn/dbaId/email/phone fields from. For a fresh producer this is
      // undefined — the producer-info fallback below covers that case.
      const repSample = (Array.isArray(existing) ? existing : [])[0]

      // Always GET the producer record so we have authoritative
      // npn/email/name fields. Without this, fresh producers (no prior
      // appointments → repSample undefined) had producerEmailUsed=null
      // on every created request — Thomas then saw editable/unsigned
      // agreements at BGA stage with no producer email to send back to
      // (Javier Castro 2026-05-27). The SureLC SPA exposes the producer
      // resource under /surecrm/producer/{id}.
      const producerRecord = await fetch(
        `https://surelc.surancebay.com/surecrm/producer/${producerId}`,
        { headers: { Authorization: `Bearer ${bearer}` } },
      )
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
      const producerEmail: string | null =
        producerRecord?.email || producerRecord?.effectiveEmail || null
      const producerEffectiveEmail: string | null =
        producerRecord?.effectiveEmail || producerRecord?.email || null
      const producerNpn: string | null = producerRecord?.npn || null
      const producerName: string | null =
        producerRecord?.fullName ||
        (producerRecord?.lastName && producerRecord?.firstName
          ? `${producerRecord.lastName}, ${producerRecord.firstName}`
          : null)
      const producerPhone: string | null =
        producerRecord?.phone || producerRecord?.cell || null

      // Pull template producer's signed Carrier-stage appointments
      const templates = await fetch(
        `https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${templateProducerId}&gaId=${gaId}`,
        { headers: { Authorization: `Bearer ${bearer}` } },
      ).then((r) => r.json())
      const targets = (Array.isArray(templates) ? templates : []).filter(
        (t: any) => t.stage === "Carrier" && !existingCarriers.has(t.carrierName),
      )

      const created: Array<{ carrier: string; status: number }> = []
      for (const t of targets) {
        const newAppt = {
          ...t,
          appointmentRequestId: undefined,
          producerId: Number(producerId),
          // Priority: repSample (prior real appointment for THIS producer)
          // → producer record (always available for any producer SureLC
          // knows about) → template clone (last resort). The template
          // values are someone ELSE's data (Sydney 11482453), so they
          // are the worst possible source for producer-identity fields.
          npn: repSample?.npn || producerNpn || t.npn,
          dbaId: repSample?.dbaId || t.dbaId,
          producerName: repSample?.producerName || producerName || t.producerName,
          producerEmail: repSample?.producerEmail || producerEmail || t.producerEmail,
          producerEffectiveEmail:
            repSample?.producerEffectiveEmail ||
            producerEffectiveEmail ||
            t.producerEffectiveEmail,
          // producerEmailUsed is the address SureLC will send the
          // rep-review email to. MUST be the target producer's own
          // address — never the template's. Falling through to null
          // (the old bug) produces editable BGA-stage requests with no
          // way to send the producer-review email.
          producerEmailUsed:
            repSample?.producerEmailUsed ||
            repSample?.producerEffectiveEmail ||
            producerEffectiveEmail ||
            producerEmail,
          producerEffectivePhone: repSample?.producerEffectivePhone || producerPhone,
          carrierStatus: "ProducerReview",
          stage: "Producer",
          reviewed: "N",
          states: state,
          statesInfo: [],
          digitalSignature: false,
        }
        delete (newAppt as any).appointmentRequestId
        delete (newAppt as any).ts
        delete (newAppt as any).paperworkDate
        delete (newAppt as any).requestReviewDate
        delete (newAppt as any).stageChangeDate
        delete (newAppt as any).confirmationDate
        delete (newAppt as any).confirmationIP
        delete (newAppt as any).comments

        // Guard: refuse to POST if producerEmailUsed is missing — that
        // path produces unsigned BGA-stage orphans that block the BGA
        // admin from promoting to Carrier. Skip the carrier and log so
        // the caller can fix the producer record before retrying.
        if (!newAppt.producerEmailUsed) {
          logger.warn(
            { producerId, carrier: t.carrierName },
            "[create-appointment-requests] skipping carrier — producerEmailUsed unresolved",
          )
          created.push({ carrier: t.carrierName, status: 0 })
          continue
        }

        const r = await fetch("https://surelc.surancebay.com/surecrm/appointments-requests", {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify(newAppt),
        })
        created.push({ carrier: t.carrierName, status: r.status })
      }
      return res.json({
        ok: true,
        producerId,
        residentStateUsed: state,
        count: created.length,
        created,
      })
    } finally {
      await browser.close().catch(() => undefined)
    }
  } catch (err: any) {
    logger.error({ err: err?.message }, "/create-appointment-requests threw")
    return res.status(500).json({ ok: false, error: err?.message || "bot crashed" })
  }
})

/**
 * POST /recover-orphan-bga-requests
 *
 * Recover orphan BGA-stage appointment-requests for a producer. An
 * "orphan" is an appointment-request at stage="BGA" whose
 * producerEmailUsed is null/empty — created by the old
 * fastlane_fallback_direct_post path before the 2026-05-27 fix.
 * These have unsigned/editable agreement segments and block the BGA
 * admin from promoting to Carrier ("send back to producer for review"
 * error). Move them back to stage="Producer" so the producer-review
 * email is dispatched and the rep can sign.
 *
 * Body: { producerId, gaId?, adminCreds, comment? }
 * Returns: { ok, total, reverted, failed }
 */
const recoverOrphanSchema = z.object({
  producerId: z.string().min(1),
  adminCreds: adminCredsSchema,
  gaId: z.number().int().positive().optional(),
  comment: z.string().max(500).optional(),
})
app.post("/recover-orphan-bga-requests", async (req, res) => {
  const auth = req.headers.authorization || ""
  if (!BEARER || auth !== `Bearer ${BEARER}`) {
    return res.status(401).json({ error: "unauthorized" })
  }
  const parsed = recoverOrphanSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: "bad_request", issues: parsed.error.issues })
  }
  const { producerId, adminCreds } = parsed.data
  const gaId = parsed.data.gaId ?? 1322
  const comment = parsed.data.comment ?? "Set4Life bot — revert orphan back to producer for review"
  try {
    const { chromium } = await import("playwright")
    const { loginAdmin } = await import("./admin/login.js")
    const browser = await launchChromium(logger)
    try {
      const { page, loginResult } = await getAuthenticatedPage(
        browser,
        adminCreds,
        logger,
        { contextOptions: { viewport: { width: 1280, height: 900 } } },
      )
      if (loginResult && !loginResult.ok) {
        return res.status(502).json({ ok: false, error: loginResult.reason || "admin login failed" })
      }
      let bearer = ""
      const handler = (req: any) => {
        const a = req.headers()["authorization"]
        if (!bearer && req.url().includes("/surecrm/") && typeof a === "string" && a.startsWith("Bearer ")) {
          bearer = a.replace(/^Bearer /, "")
          page.off("request", handler)
        }
      }
      page.on("request", handler)
      await page
        .evaluate((id) => {
          history.pushState({}, "", `/bga/producers/${id}/profile`)
          window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
        }, producerId)
        .catch(() => undefined)
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !bearer) await page.waitForTimeout(250)
      if (!bearer) {
        return res.status(502).json({ ok: false, error: "could not harvest Bearer from SPA" })
      }

      const listRes = await fetch(
        `https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${producerId}&gaId=${gaId}`,
        { headers: { Authorization: `Bearer ${bearer}` } },
      )
      if (!listRes.ok) {
        return res.status(502).json({ ok: false, error: `appointments-requests HTTP ${listRes.status}` })
      }
      const all = (await listRes.json()) as Array<{
        appointmentRequestId: number
        stage: string
        carrierName: string
        producerEmailUsed?: string | null
      }>
      const orphans = (Array.isArray(all) ? all : []).filter((r) => {
        if (r.stage !== "BGA") return false
        const v = (r.producerEmailUsed || "").trim()
        return v === "" || v === "null"
      })

      logger.info(
        { producerId, totalAtBga: all.filter((r) => r.stage === "BGA").length, orphans: orphans.length },
        "[recover-orphan-bga-requests] discovery",
      )

      const reverted: Array<{ id: number; carrierName: string; status: number }> = []
      const failed: Array<{ id: number; carrierName: string; status: number; reason: string }> = []
      for (const o of orphans) {
        const url = `https://surelc.surancebay.com/surecrm/appointments-requests/${o.appointmentRequestId}/stage`
        try {
          const r = await fetch(url, {
            method: "PUT",
            headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
            body: JSON.stringify({ stage: "Producer", comment, isPrivate: false }),
          })
          if (r.ok) {
            reverted.push({ id: o.appointmentRequestId, carrierName: o.carrierName, status: r.status })
            logger.info(
              { id: o.appointmentRequestId, carrier: o.carrierName },
              "[recover-orphan-bga-requests] reverted BGA → Producer",
            )
          } else {
            const body = (await r.text().catch(() => "")).slice(0, 200)
            failed.push({
              id: o.appointmentRequestId,
              carrierName: o.carrierName,
              status: r.status,
              reason: body || `HTTP ${r.status}`,
            })
          }
        } catch (err: any) {
          failed.push({
            id: o.appointmentRequestId,
            carrierName: o.carrierName,
            status: 0,
            reason: err?.message || "fetch threw",
          })
        }
      }

      return res.json({
        ok: failed.length === 0,
        producerId,
        total: orphans.length,
        reverted,
        failed,
      })
    } finally {
      await browser.close().catch(() => undefined)
    }
  } catch (err: any) {
    logger.error({ err: err?.message }, "/recover-orphan-bga-requests threw")
    return res.status(500).json({ ok: false, error: err?.message || "bot crashed" })
  }
})

/**
 * POST /diagnose-producer
 *
 * Returns SureLC's authoritative validation errors for a producer —
 * the same data the BGA SPA reads to render the "N issues" badges
 * and the popover tooltips. Use this instead of guessing what
 * Fastlane is complaining about.
 *
 * Calls POST /surecrm/validation/list with [producerId] via the
 * SureCRM Bearer JWT. Returns whatever SureLC sends back.
 *
 * 2026-05-27 motivation: Javier Castro keeps failing Fastlane with
 * the misleading "[signature] delete_outline REMOVE" diagnostic
 * (which actually means signature IS present). The bot's profile-
 * scan can't surface the real blockers. /validation/list is the
 * source of truth.
 *
 * Body: { producerId, adminCreds }
 * Returns: { ok, validation: <raw SureLC response> }
 */
const diagnoseProducerSchema = z.object({
  producerId: z.string().min(1),
  adminCreds: adminCredsSchema,
})
app.post("/diagnose-producer", async (req, res) => {
  const auth = req.headers.authorization || ""
  if (!BEARER || auth !== `Bearer ${BEARER}`) {
    return res.status(401).json({ error: "unauthorized" })
  }
  const parsed = diagnoseProducerSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: "bad_request", issues: parsed.error.issues })
  }
  const { producerId, adminCreds } = parsed.data
  try {
    const { chromium } = await import("playwright")
    const { loginAdmin } = await import("./admin/login.js")
    const browser = await launchChromium(logger)
    try {
      const { page, loginResult: lr } = await getAuthenticatedPage(
        browser,
        adminCreds,
        logger,
        { contextOptions: { viewport: { width: 1280, height: 900 } } },
      )
      if (lr && !lr.ok) {
        return res.status(502).json({ ok: false, error: lr.reason || "admin login failed" })
      }
      let bearer = ""
      page.on("request", (req) => {
        const a = req.headers()["authorization"]
        if (!bearer && req.url().includes("/surecrm/") && typeof a === "string" && a.startsWith("Bearer ")) {
          bearer = a.replace(/^Bearer /, "")
        }
      })
      await page.evaluate((id) => {
        history.pushState({}, "", `/bga/producers/${id}/profile`)
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
      }, producerId).catch(() => undefined)
      const dl = Date.now() + 15_000
      while (Date.now() < dl && !bearer) await page.waitForTimeout(250)
      if (!bearer) {
        return res.status(502).json({ ok: false, error: "could not harvest Bearer from SPA" })
      }

      // The /surecrm/validation/list endpoint takes an array of
      // producerIds and returns validation issues per producer.
      // Captured from the SPA's network probe on 2026-05-27.
      const r = await fetch(
        `https://surelc.surancebay.com/surecrm/validation/list`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify([Number(producerId)]),
        },
      )
      const text = await r.text().catch(() => "")
      let body: any = null
      try { body = JSON.parse(text) } catch { body = text }
      if (!r.ok) {
        return res.status(502).json({
          ok: false,
          producerId,
          error: `validation/list HTTP ${r.status}: ${text.slice(0, 300)}`,
        })
      }
      return res.json({ ok: true, producerId, validation: body })
    } finally {
      await browser.close().catch(() => undefined)
    }
  } catch (err: any) {
    logger.error({ err: err?.message }, "/diagnose-producer threw")
    return res.status(500).json({ ok: false, error: err?.message || "bot crashed" })
  }
})

/**
 * POST /cleanup-orphan-explanations
 *
 * Lists a producer's attachments via /surecrm/attachments/{producerId}
 * and DELETE-s any unlinked ones whose filename matches our bot's
 * temp-upload naming pattern. Used to clean up orphans left by
 * failed Questions v2 modal flows (Gurira 2026-05-29 accumulated 8
 * before pointer-sequence CREATE was figured out).
 *
 * Body: { producerId, adminCreds, deletePatterns? }
 *   deletePatterns: regex strings (default: bot's temp-upload prefixes)
 * Returns: { ok, producerId, scanned, deleted: [{id, fileName}] }
 */
const cleanupOrphansSchema = z.object({
  producerId: z.string().min(1),
  adminCreds: adminCredsSchema,
  deletePatterns: z.array(z.string()).optional(),
})
app.post("/cleanup-orphan-explanations", async (req, res) => {
  const auth = req.headers.authorization || ""
  if (!BEARER || auth !== `Bearer ${BEARER}`) {
    return res.status(401).json({ error: "unauthorized" })
  }
  const parsed = cleanupOrphansSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: "bad_request", issues: parsed.error.issues })
  }
  const { producerId, adminCreds } = parsed.data
  const patterns = (parsed.data.deletePatterns ?? [
    "surelc-v2-simple-",
    "surelc-v2-statement-",
    "surelc-v2-notice-",
    "surelc-v2-resolution-",
    "surelc-modal-",
    "surelc-upload-",
  ]).map((p) => new RegExp(p, "i"))
  // SureLC strips fileName off uploads — they show as empty strings in
  // the /surecrm/attachments listing. The reliable orphan-detector is
  // formType === "Explanation" AND entityId === "0" (unlinked).
  const treatAllExplanationsUnlinkedAsOrphans = true
  try {
    const { chromium } = await import("playwright")
    const { loginAdmin } = await import("./admin/login.js")
    const browser = await launchChromium(logger)
    try {
      const { page, loginResult: lr } = await getAuthenticatedPage(
        browser,
        adminCreds,
        logger,
        { contextOptions: { viewport: { width: 1280, height: 900 } } },
      )
      if (lr && !lr.ok) return res.status(502).json({ ok: false, error: lr.reason || "admin login failed" })
      let bearer = ""
      page.on("request", (req) => {
        const a = req.headers()["authorization"]
        if (!bearer && req.url().includes("/surecrm/") && typeof a === "string" && a.startsWith("Bearer ")) {
          bearer = a.replace(/^Bearer /, "")
        }
      })
      await page.evaluate((id) => {
        history.pushState({}, "", `/bga/producers/${id}/profile`)
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
      }, producerId).catch(() => undefined)
      const dl = Date.now() + 15_000
      while (Date.now() < dl && !bearer) await page.waitForTimeout(250)
      if (!bearer) return res.status(502).json({ ok: false, error: "no Bearer harvested" })
      // List attachments
      const listRes = await fetch(
        `https://surelc.surancebay.com/surecrm/attachments/${producerId}?withUndefined=true&withUnlinkedBusinessChecks=false`,
        { headers: { Authorization: `Bearer ${bearer}` } },
      )
      if (!listRes.ok) {
        const t = await listRes.text().catch(() => "")
        return res.status(502).json({ ok: false, error: `list HTTP ${listRes.status}: ${t.slice(0, 200)}` })
      }
      const attachments = (await listRes.json().catch(() => [])) as Array<{
        id: number | string
        fileName?: string
        formType?: string
        entityId?: string | number
      }>
      // CAUTION: entityId="0" alone is NOT enough to identify orphans.
      // Verified Gurira 2026-05-29 — legit linked explanations also
      // show entityId="0" because the actual question→explanation
      // linkage lives in a separate SureLC relation, NOT on the
      // attachment record. Deleting all Explanation+entityId=0
      // attachments wiped his linked explanations too, putting his
      // validation back to 3 issues. Now require explicit filename
      // pattern match — only files our bot uploaded match the
      // surelc-v2-* / surelc-modal-* / surelc-upload-* prefixes.
      const candidates = attachments.filter((a) => {
        if (a.formType !== "Explanation") return false
        const fn = a.fileName || ""
        // Only delete if the filename clearly matches our bot's
        // temp-upload pattern. Anything else (including empty
        // fileName) is presumed legit / linked.
        if (!fn) return false
        return patterns.some((p) => p.test(fn))
      })
      const deleted: Array<{ id: number | string; fileName: string }> = []
      for (const a of candidates) {
        const r = await fetch(
          `https://surelc.surancebay.com/surecrm/attachments/${a.id}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${bearer}` } },
        )
        if (r.status === 204 || r.ok) {
          deleted.push({ id: a.id, fileName: a.fileName || "" })
        }
      }
      return res.json({
        ok: true,
        producerId,
        scanned: attachments.length,
        candidates: candidates.length,
        deleted,
      })
    } finally {
      await browser.close().catch(() => undefined)
    }
  } catch (err: any) {
    logger.error({ err: err?.message }, "/cleanup-orphan-explanations threw")
    return res.status(500).json({ ok: false, error: err?.message || "crashed" })
  }
})

/**
 * POST /set-producer-fields
 *
 * General-purpose producer-record patcher. Same plumbing as
 * /set-producer-email — login as admin, harvest the SureCRM Bearer
 * JWT, PUT /surecrm/producers/{id}/update with `{producer: {...fields}}`.
 *
 * Use case (2026-05-27): Javier Castro went through onboarding on
 * our app with full data (DL, address, cell, E&O) but never
 * completed Phase B on SureLC — so SureLC's producer profile fields
 * stayed null and Fastlane refuses to expose SELECT (the wizard
 * pre-flight checks producer completeness). Pre-populating the
 * profile via this endpoint lets Fastlane succeed without needing
 * the producer to come back and re-sign on the SPA portal.
 *
 * Body: { producerId, fields, adminCreds }
 *   fields: any subset of producer fields SureLC accepts on /update
 *     (driverLic, driverLicState, driverLicenseExp, cell, email,
 *     domicileState, etc.) — sent verbatim inside `{producer: {...}}`.
 *
 * Returns: { ok, producerId, fieldsSent, putStatus, response }
 */
const setProducerFieldsSchema = z.object({
  producerId: z.string().min(1),
  fields: z.record(z.string(), z.any()),
  adminCreds: adminCredsSchema,
})
app.post("/set-producer-fields", async (req, res) => {
  const auth = req.headers.authorization || ""
  if (!BEARER || auth !== `Bearer ${BEARER}`) {
    return res.status(401).json({ error: "unauthorized" })
  }
  const parsed = setProducerFieldsSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: "bad_request", issues: parsed.error.issues })
  }
  const { producerId, fields, adminCreds } = parsed.data
  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: "fields must be non-empty" })
  }
  try {
    const { chromium } = await import("playwright")
    const { loginAdmin } = await import("./admin/login.js")
    const browser = await launchChromium(logger)
    try {
      const { page, loginResult: lr } = await getAuthenticatedPage(
        browser,
        adminCreds,
        logger,
        { contextOptions: { viewport: { width: 1280, height: 900 } } },
      )
      if (lr && !lr.ok) {
        return res.status(502).json({ ok: false, error: lr.reason || "admin login failed" })
      }
      let bearer = ""
      page.on("request", (req) => {
        const a = req.headers()["authorization"]
        if (!bearer && req.url().includes("/surecrm/") && typeof a === "string" && a.startsWith("Bearer ")) {
          bearer = a.replace(/^Bearer /, "")
        }
      })
      await page.evaluate((id) => {
        history.pushState({}, "", `/bga/producers/${id}/profile`)
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
      }, producerId).catch(() => undefined)
      const dl = Date.now() + 15_000
      while (Date.now() < dl && !bearer) await page.waitForTimeout(250)
      if (!bearer) {
        return res.status(502).json({ ok: false, error: "could not harvest Bearer from SPA" })
      }

      const body = JSON.stringify({ producer: fields })
      const r = await fetch(
        `https://surelc.surancebay.com/surecrm/producers/${producerId}/update`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body,
        },
      )
      const responseText = (await r.text().catch(() => "")).slice(0, 800)
      if (!r.ok) {
        return res.status(502).json({
          ok: false,
          producerId,
          fieldsSent: Object.keys(fields),
          putStatus: r.status,
          error: responseText,
        })
      }
      logger.info(
        { producerId, fields: Object.keys(fields), putStatus: r.status },
        "[set-producer-fields] PUT ok",
      )
      return res.json({
        ok: true,
        producerId,
        fieldsSent: Object.keys(fields),
        putStatus: r.status,
        response: responseText.slice(0, 200),
      })
    } finally {
      await browser.close().catch(() => undefined)
    }
  } catch (err: any) {
    logger.error({ err: err?.message }, "/set-producer-fields threw")
    return res.status(500).json({ ok: false, error: err?.message || "bot crashed" })
  }
})

/**
 * POST /set-producer-email
 *
 * Update the SureLC producer record's `email` field via the BGA SPA's
 * own Bearer-JWT endpoint (PUT /surecrm/producer/{id}). The public
 * x-api-key API path (PUT /api/v2/producers/) silently NO-OPs the
 * email field on UPDATE — likely because SureLC pins NIPR-sourced
 * values there. The BGA admin SPA is the source-of-truth path admins
 * use when they manually edit email in the portal; calling its
 * underlying endpoint directly mimics that behavior.
 *
 * 2026-05-27 context: Javier Castro + 12 other agents drifted to
 * NIPR-pinned personal emails. The boot migration reported success
 * but SureLC kept the old email. This endpoint lets the email-drift
 * sweep auto-heal instead of just alerting.
 *
 * Body: { producerId, newEmail, adminCreds }
 * Returns: { ok, beforeEmail, afterEmail }
 */
const setProducerEmailSchema = z.object({
  producerId: z.string().min(1),
  newEmail: z.string().email(),
  adminCreds: adminCredsSchema,
})
app.post("/set-producer-email", async (req, res) => {
  const auth = req.headers.authorization || ""
  if (!BEARER || auth !== `Bearer ${BEARER}`) {
    return res.status(401).json({ error: "unauthorized" })
  }
  const parsed = setProducerEmailSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: "bad_request", issues: parsed.error.issues })
  }
  const { producerId, newEmail, adminCreds } = parsed.data
  try {
    const { chromium } = await import("playwright")
    const { loginAdmin } = await import("./admin/login.js")
    const browser = await launchChromium(logger)
    try {
      const { page, loginResult } = await getAuthenticatedPage(
        browser,
        adminCreds,
        logger,
        { contextOptions: { viewport: { width: 1280, height: 900 } } },
      )
      if (loginResult && !loginResult.ok) {
        return res.status(502).json({ ok: false, error: loginResult.reason || "admin login failed" })
      }
      let bearer = ""
      const handler = (req: any) => {
        const a = req.headers()["authorization"]
        if (!bearer && req.url().includes("/surecrm/") && typeof a === "string" && a.startsWith("Bearer ")) {
          bearer = a.replace(/^Bearer /, "")
          page.off("request", handler)
        }
      }
      page.on("request", handler)
      await page
        .evaluate((id) => {
          history.pushState({}, "", `/bga/producers/${id}/profile`)
          window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
        }, producerId)
        .catch(() => undefined)
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !bearer) await page.waitForTimeout(250)
      if (!bearer) {
        return res.status(502).json({ ok: false, error: "could not harvest Bearer from SPA" })
      }

      // 1) Read current email via the public x-api-key API. We use
      //    this (not the SPA's /model) because the body we send to
      //    /update is a tiny delta — no need to fetch the full model.
      let beforeEmail: string | null = null
      try {
        const apiKey = process.env.SURELC_API_KEY || process.env.SURELC_API_TOKEN
        if (apiKey) {
          const cur = await fetch(
            `https://surelc.surancebay.com/api/v2/producers/${producerId}`,
            { headers: { "x-api-key": apiKey } },
          )
          if (cur.ok) {
            const j = (await cur.json()) as { email?: string }
            beforeEmail = j.email ?? null
          }
        }
      } catch {
        /* fall through — beforeEmail just stays null */
      }
      if (beforeEmail && beforeEmail.toLowerCase() === newEmail.toLowerCase()) {
        return res.json({
          ok: true,
          producerId,
          beforeEmail,
          afterEmail: beforeEmail,
          noOp: true,
          message: "email already matches — no PUT issued",
        })
      }

      // 2) PUT /update with the minimal `{producer: {email}}` delta.
      //    Confirmed body shape via network probe of the admin
      //    Change-Email dialog 2026-05-27 — exactly this payload
      //    successfully changed Holton Buggs (11096584) and Vanda
      //    Jamison (3924805) emails to the agency mailbox (verified
      //    via public-API GET post-PUT, both modifiedOn stamps moved).
      //    Sending the FULL /model back triggers SureLC's Java NPE
      //    on certain producers; the delta-only body avoids that.
      const putRes = await fetch(
        `https://surelc.surancebay.com/surecrm/producers/${producerId}/update`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify({ producer: { email: newEmail } }),
        },
      )
      if (!putRes.ok) {
        const body = (await putRes.text().catch(() => "")).slice(0, 300)
        return res.status(502).json({
          ok: false,
          producerId,
          beforeEmail,
          error: `PUT /surecrm/producers/${producerId}/update HTTP ${putRes.status}: ${body}`,
        })
      }

      // 3) Verify via the public API (x-api-key) — it queries SureLC's
      //    canonical producer record. If the BGA SPA accepted our PUT
      //    but the change didn't reach the canonical record, we want
      //    to know now, not days later.
      let afterEmail: string | null = null
      try {
        const apiKey = process.env.SURELC_API_KEY || process.env.SURELC_API_TOKEN
        if (apiKey) {
          const v = await fetch(
            `https://surelc.surancebay.com/api/v2/producers/${producerId}`,
            { headers: { "x-api-key": apiKey } },
          )
          if (v.ok) {
            const j = (await v.json()) as { email?: string }
            afterEmail = j.email ?? null
          }
        }
      } catch {
        /* verify is best-effort */
      }
      const matched = (afterEmail || "").toLowerCase() === newEmail.toLowerCase()
      if (afterEmail !== null && !matched) {
        return res.status(409).json({
          ok: false,
          producerId,
          beforeEmail,
          afterEmail,
          error: `PUT accepted (HTTP ${putRes.status}) but public-API verification shows email is still "${afterEmail || "(empty)"}" — SureLC may have rolled back or NIPR re-sync overwrote`,
        })
      }
      logger.info(
        { producerId, beforeEmail, afterEmail },
        "[set-producer-email] success",
      )
      return res.json({
        ok: true,
        producerId,
        beforeEmail,
        afterEmail,
      })
    } finally {
      await browser.close().catch(() => undefined)
    }
  } catch (err: any) {
    logger.error({ err: err?.message }, "/set-producer-email threw")
    return res.status(500).json({ ok: false, error: err?.message || "bot crashed" })
  }
})

/**
 * POST /patch-appointments-to-resident-state
 *
 * Workaround for Phase B wizard rejections (Keyon Foresters 2026-05-10):
 * carrier wizards inject state-specific steps (e.g. "Florida Counties")
 * that the bot's blind-Next-clicks can't satisfy. Patching the
 * appointment to ONLY the rep's resident state strips those state-
 * specific steps, the wizard accepts, sign succeeds.
 *
 * Body: { producerId, appointmentIds: [number], adminCreds }
 * Returns: { ok, patched: [{ id, state, status }] }
 */
const patchAppointmentsSchema = z.object({
  producerId: z.string().min(1),
  appointmentIds: z.array(z.number().int().positive()).min(1),
  adminCreds: adminCredsSchema,
})
app.post("/patch-appointments-to-resident-state", async (req, res) => {
  const auth = req.headers.authorization || ""
  if (!BEARER || auth !== `Bearer ${BEARER}`) return res.status(401).json({ error: "unauthorized" })
  const parsed = patchAppointmentsSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: "bad_request", issues: parsed.error.issues })
  const { producerId, appointmentIds, adminCreds } = parsed.data
  try {
    const { chromium } = await import("playwright")
    const { loginAdmin } = await import("./admin/login.js")
    const browser = await launchChromium(logger)
    try {
      const { page, loginResult: lr } = await getAuthenticatedPage(
        browser,
        adminCreds,
        logger,
        { contextOptions: { viewport: { width: 1280, height: 900 } } },
      )
      if (lr && !lr.ok) return res.status(502).json({ ok: false, error: lr.reason || "admin login failed" })
      let bearer = ""
      const handler = (req: any) => {
        const a = req.headers()["authorization"]
        if (!bearer && req.url().includes("/surecrm/") && typeof a === "string" && a.startsWith("Bearer ")) {
          bearer = a.replace(/^Bearer /, "")
          page.off("request", handler)
        }
      }
      page.on("request", handler)
      await page.evaluate((id) => {
        history.pushState({}, "", `/bga/producers/${id}/profile`)
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
      }, producerId).catch(() => undefined)
      const dl = Date.now() + 15_000
      while (Date.now() < dl && !bearer) await page.waitForTimeout(250)
      if (!bearer) return res.status(502).json({ ok: false, error: "could not harvest Bearer" })

      // Get resident state from licenses
      const lic = await fetch(`https://surelc.surancebay.com/surecrm/licenses/producer/${producerId}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      }).then((r) => (r.ok ? r.json() : []))
      const resident = (Array.isArray(lic) ? lic : []).find(
        (l: any) => l.isResidentLicense === "Y" && l.status === "Active",
      )
      const state = resident?.state
      if (!state) return res.status(400).json({ ok: false, error: "no resident state" })

      const patched: Array<{ id: number; state: string; status: number }> = []
      for (const id of appointmentIds) {
        const cur = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${id}`, {
          headers: { Authorization: `Bearer ${bearer}` },
        }).then((r) => (r.ok ? r.json() : null))
        if (!cur) {
          patched.push({ id, state, status: 404 })
          continue
        }
        const updated = { ...cur, states: state, statesInfo: [] }
        const r = await fetch(`https://surelc.surancebay.com/surecrm/appointments-requests/${id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify(updated),
        })
        patched.push({ id, state, status: r.status })
      }
      return res.json({ ok: true, count: patched.length, patched })
    } finally {
      await browser.close().catch(() => undefined)
    }
  } catch (err: any) {
    logger.error({ err: err?.message }, "/patch-appointments-to-resident-state threw")
    return res.status(500).json({ ok: false, error: err?.message || "bot crashed" })
  }
})

/**
 * POST /patch-appointment-email
 *
 * Update the `producerEmailUsed` field on existing appointment-requests
 * so SureLC's email/resend flow delivers to a mailbox we actually poll.
 *
 * Verified pattern 2026-05-28 (Sean Way 14881, Gittelman 5188892):
 * the producer record already has the correct agency email, but
 * existing appointment-requests snapshotted an old/external value
 * (sunsera, gmail) at creation time. Resend hits the snapshot, not
 * the producer's current email, so emails keep going to the wrong
 * place until each appointment-request is individually patched.
 *
 * Body: { producerId, appointmentIds: [number], newEmail, adminCreds, triggerResend? }
 * Returns: { ok, patched: [{ id, status, resendStatus? }] }
 */
const patchAppointmentEmailSchema = z.object({
  producerId: z.string().min(1),
  appointmentIds: z.array(z.number().int().positive()).min(1),
  newEmail: z.string().email(),
  adminCreds: adminCredsSchema,
  /** Optional — also POST /surecrm/appointments-requests/{id}/email after each patch. */
  triggerResend: z.boolean().optional(),
})
app.post("/patch-appointment-email", async (req, res) => {
  const auth = req.headers.authorization || ""
  if (!BEARER || auth !== `Bearer ${BEARER}`)
    return res.status(401).json({ error: "unauthorized" })
  const parsed = patchAppointmentEmailSchema.safeParse(req.body)
  if (!parsed.success)
    return res.status(400).json({ error: "bad_request", issues: parsed.error.issues })
  const { producerId, appointmentIds, newEmail, adminCreds, triggerResend } = parsed.data
  try {
    const { chromium } = await import("playwright")
    const { loginAdmin } = await import("./admin/login.js")
    const browser = await launchChromium(logger)
    try {
      const { page, loginResult: lr } = await getAuthenticatedPage(
        browser,
        adminCreds,
        logger,
        { contextOptions: { viewport: { width: 1280, height: 900 } } },
      )
      if (lr && !lr.ok)
        return res.status(502).json({ ok: false, error: lr.reason || "admin login failed" })
      let bearer = ""
      const handler = (req: any) => {
        const a = req.headers()["authorization"]
        if (
          !bearer &&
          req.url().includes("/surecrm/") &&
          typeof a === "string" &&
          a.startsWith("Bearer ")
        ) {
          bearer = a.replace(/^Bearer /, "")
          page.off("request", handler)
        }
      }
      page.on("request", handler)
      await page
        .evaluate((id) => {
          history.pushState({}, "", `/bga/producers/${id}/profile`)
          window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
        }, producerId)
        .catch(() => undefined)
      const dl = Date.now() + 15_000
      while (Date.now() < dl && !bearer) await page.waitForTimeout(250)
      if (!bearer)
        return res.status(502).json({ ok: false, error: "could not harvest Bearer" })

      const patched: Array<{ id: number; status: number; resendStatus?: number; reason?: string }> = []
      for (const id of appointmentIds) {
        const cur = await fetch(
          `https://surelc.surancebay.com/surecrm/appointments-requests/${id}`,
          { headers: { Authorization: `Bearer ${bearer}` } },
        ).then((r) => (r.ok ? r.json() : null))
        if (!cur) {
          patched.push({ id, status: 404, reason: "GET failed" })
          continue
        }
        const updated = {
          ...cur,
          producerEmailUsed: newEmail,
          producerEffectiveEmail: newEmail,
        }
        const r = await fetch(
          `https://surelc.surancebay.com/surecrm/appointments-requests/${id}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${bearer}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(updated),
          },
        )
        const entry: { id: number; status: number; resendStatus?: number; reason?: string } = {
          id,
          status: r.status,
        }
        if (!r.ok) {
          entry.reason = (await r.text().catch(() => "")).slice(0, 200)
        } else if (triggerResend) {
          const resend = await fetch(
            `https://surelc.surancebay.com/surecrm/appointments-requests/${id}/email`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${bearer}` },
            },
          )
          entry.resendStatus = resend.status
        }
        patched.push(entry)
      }
      return res.json({ ok: true, count: patched.length, patched })
    } finally {
      await browser.close().catch(() => undefined)
    }
  } catch (err: any) {
    logger.error({ err: err?.message }, "/patch-appointment-email threw")
    return res.status(500).json({ ok: false, error: err?.message || "bot crashed" })
  }
})

const fillMiscWizardSchema = z.object({
  producerId: z.string(),
  appointmentRequestId: z.string(),
  adminCreds: adminCredsSchema,
  answers: z.record(z.enum(["Y", "N"])).optional(),
  textValues: z.record(z.string()).optional(),
})

/**
 * POST /fill-misc-via-wizard
 *
 * Drives the BGA admin wizard up to and including the Carrier Questions
 * step, fills every ComplianceDetails radio with the supplied answer
 * (default "N"), clicks Next on that step to commit the misc PUT via
 * the wizard-session context, and exits BEFORE the Documents/Process
 * step. Use this to clear AR_MISCELLANEOUS WARNING on appointments that
 * skipped the wizard during Fastlane fill.
 *
 * Direct PUT /surecrm/appointments-requests/{id}/miscellaneous returns
 * 200 but silently no-ops (verified Bates 117916924, 2026-05-29 — see
 * src/admin/fillMiscWizard.ts header for endpoint reverse-engineering
 * notes). The wizard is the only mechanism that persists.
 *
 * Does NOT release the contract to the carrier — Process step is
 * skipped by design (per the 2026-05-12 Phase-C-disabled directive).
 */
app.post("/fill-misc-via-wizard", async (req, res) => {
  const auth = req.headers.authorization || ""
  if (!BEARER || auth !== `Bearer ${BEARER}`) {
    return res.status(401).json({ error: "unauthorized" })
  }
  const parsed = fillMiscWizardSchema.safeParse(req.body)
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "bad_request", issues: parsed.error.issues })
  }
  const { producerId, appointmentRequestId, adminCreds, answers, textValues } = parsed.data
  try {
    const { chromium } = await import("playwright")
    const { loginAdmin } = await import("./admin/login.js")
    const { fillMiscWizard } = await import("./admin/fillMiscWizard.js")
    const browser = await launchChromium(logger)
    try {
      const { page, loginResult } = await getAuthenticatedPage(
        browser,
        adminCreds,
        logger,
        { contextOptions: { viewport: { width: 1440, height: 900 } } },
      )
      if (loginResult && !loginResult.ok) {
        return res
          .status(502)
          .json({ ok: false, error: loginResult.reason || "admin login failed" })
      }
      const jobId = `misc-${appointmentRequestId}-${Date.now()}`
      const tabCtx = {
        page,
        logger,
        jobId,
        evidenceDir: `/tmp/surelc-evidence/${jobId}`,
        evidenceFiles: [] as string[],
      }
      const result = await fillMiscWizard(tabCtx, {
        producerId,
        appointmentRequestId,
        answers,
        textValues,
      })
      return res.json(result)
    } finally {
      await browser.close().catch(() => undefined)
    }
  } catch (err: any) {
    logger.error({ err: err?.message }, "/fill-misc-via-wizard threw")
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "bot crashed" })
  }
})

app.post("/get-bga-tokens", async (req, res) => {
  const auth = req.headers.authorization || ""
  if (!BEARER || auth !== `Bearer ${BEARER}`) {
    return res.status(401).json({ error: "unauthorized" })
  }
  const parsed = bgaTokensSchema.safeParse(req.body)
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "bad_request", issues: parsed.error.issues })
  }
  try {
    const result = await captureBgaTokens(parsed.data, logger)
    return res.json(result)
  } catch (err: any) {
    logger.error({ err: err?.message }, "captureBgaTokens threw")
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "bot crashed" })
  }
})

const PORT = parseInt(process.env.PORT || "3000", 10)
app.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT }, "s4l-surelc-bot listening")
})
