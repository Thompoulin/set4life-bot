import express from "express"
import { z } from "zod"
import pino from "pino"
import { runActivation, type RunActivationInput } from "./botRunner.js"
import { captureBgaTokens } from "./bgaTokenCapture.js"

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
      q4_license_denied: z.boolean().optional(),
      q5_license_revoked: z.boolean().optional(),
      q6_insurer_terminated: z.boolean().optional(),
      q7_bankruptcy: z.boolean().optional(),
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
  res.json({ ok: true })
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
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    })
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      const page = await ctx.newPage()
      page.setDefaultTimeout(30_000)
      const loginResult = await loginAdmin(page, adminCreds, logger)
      if (!loginResult.ok) {
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
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    })
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      const page = await ctx.newPage()
      page.setDefaultTimeout(30_000)
      const loginResult = await loginAdmin(page, adminCreds, logger)
      if (!loginResult.ok) {
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
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
    })
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      const page = await ctx.newPage()
      page.setDefaultTimeout(30_000)
      const loginResult = await loginAdmin(page, adminCreds, logger)
      if (!loginResult.ok) {
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
      // npn/dbaId/email/phone fields from
      const repSample = (Array.isArray(existing) ? existing : [])[0]

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
          npn: repSample?.npn || t.npn,
          dbaId: repSample?.dbaId || t.dbaId,
          producerName: repSample?.producerName || t.producerName,
          producerEmail: repSample?.producerEmail || t.producerEmail,
          producerEffectiveEmail: repSample?.producerEffectiveEmail || t.producerEffectiveEmail,
          producerEmailUsed: repSample?.producerEmailUsed || repSample?.producerEffectiveEmail,
          producerEffectivePhone: repSample?.producerEffectivePhone,
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
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
    })
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      const page = await ctx.newPage()
      page.setDefaultTimeout(30_000)
      const lr = await loginAdmin(page, adminCreds, logger)
      if (!lr.ok) return res.status(502).json({ ok: false, error: lr.reason || "admin login failed" })
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
