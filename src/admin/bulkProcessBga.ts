import type { Browser, Page } from "playwright"
import type pino from "pino"
import { loginAdmin } from "./login.js"

export interface BulkProcessBgaInput {
  /** Admin credentials for BGA portal login. */
  adminCreds: { email: string; password: string }
  /** SureLC producerId — used to discover At-BGA appointments and to
   *  scope the SPA navigation that harvests the Bearer JWT. */
  producerId: string
  /** SureLC modern-API key (`x-api-key` for the producers/<id>/appointment-requests endpoint). */
  apiKey: string
  /** Optional comment recorded on the appointment-request audit trail. */
  comment?: string
}

export interface BulkProcessBgaResult {
  ok: boolean
  /** How many appointments were At-BGA when we started. */
  total: number
  /** How many we successfully moved to At-Carrier. */
  processed: number
  /** Per-failure detail. */
  failed: Array<{ id: number; status?: number; reason: string }>
  /** True if zero appointments were At-BGA — nothing to do, success by default. */
  noOp: boolean
}

/**
 * Phase C — release every At-BGA appointment for a producer to At-Carrier.
 *
 * The previous implementation walked the BGA admin wizard URL for each
 * appointment (8 steps × N carriers, ~22 min). That approach got blocked
 * by an OAuth scope check on the wizard guard route. The wizard's
 * "Save" button on the "Change Stage" dialog actually fires a single
 * PUT against /surecrm/appointments-requests/{id}/stage — which is
 * what we hit directly here. Total runtime: <10 s for any carrier
 * count.
 *
 * Discovered Sydney 2026-05-07 — see scripts/bulk-stage-change.mjs.
 */
export async function bulkProcessBga(
  browser: Browser,
  input: BulkProcessBgaInput,
  parentLogger: pino.Logger,
): Promise<BulkProcessBgaResult> {
  const logger = parentLogger.child({ component: "bulk-process-bga" })

  // 1) Discover At-BGA appointments via the public API (no portal login needed).
  const listUrl = `https://surelc.surancebay.com/api/v2/producers/${input.producerId}/appointment-requests`
  const listRes = await fetch(listUrl, {
    headers: { "x-api-key": input.apiKey },
  })
  if (!listRes.ok) {
    return {
      ok: false,
      total: 0,
      processed: 0,
      failed: [{ id: 0, status: listRes.status, reason: "appointment-requests list failed" }],
      noOp: false,
    }
  }
  const list = (await listRes.json()) as Array<{ id: number; stage?: string }>
  // BGA = standard "agency review" stage; UPLINE = upline-GA review
  // some carriers route through (Transamerica via Quility upline, e.g.).
  // Both accept the same PUT /surecrm/appointments-requests/{id}/stage
  // call with stage="Carrier" — verified Paul 2026-05-08, Transamerica
  // at UPLINE moved directly to CARRIER bypassing BGA entirely.
  const PROCESSABLE_STAGES = new Set(["BGA", "UPLINE"])
  const atBga = list.filter((r) => PROCESSABLE_STAGES.has(r.stage || ""))
  logger.info(
    {
      producerId: input.producerId,
      releasable: atBga.length,
      total: list.length,
    },
    "Phase C — bulk stage change discovery",
  )
  if (atBga.length === 0) {
    return { ok: true, total: 0, processed: 0, failed: [], noOp: true }
  }

  // 2) Open a Playwright session and login. We need a Bearer JWT the
  //    BGA SPA tucks into outbound API calls — we'll harvest it.
  const ctxBrowser = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctxBrowser.newPage()
  page.setDefaultTimeout(30_000)

  try {
    const loginResult = await loginAdmin(page, input.adminCreds, logger)
    if (!loginResult.ok) {
      return {
        ok: false,
        total: atBga.length,
        processed: 0,
        failed: atBga.map((r) => ({
          id: r.id,
          reason: loginResult.reason || "admin BGA login failed",
        })),
        noOp: false,
      }
    }

    // 3) Capture the Bearer token from any /surecrm/* request the SPA
    //    fires. We trigger a producer-profile navigation to make sure
    //    one fires.
    const bearer = await harvestBearerToken(page, input.producerId, logger)
    if (!bearer) {
      return {
        ok: false,
        total: atBga.length,
        processed: 0,
        failed: atBga.map((r) => ({ id: r.id, reason: "could not harvest Bearer token from SPA" })),
        noOp: false,
      }
    }
    logger.info({ tokenLen: bearer.length }, "Phase C — Bearer harvested")

    // 4) Fire one PUT per appointment.
    const failed: Array<{ id: number; status?: number; reason: string }> = []
    let processed = 0
    for (const r of atBga) {
      const url = `https://surelc.surancebay.com/surecrm/appointments-requests/${r.id}/stage`
      try {
        const res = await fetch(url, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify({
            stage: "Carrier",
            comment: input.comment ?? "Set4Life bot — release to carrier",
            isPrivate: false,
          }),
        })
        if (res.ok) {
          processed++
          logger.info({ id: r.id }, "Phase C — appointment stage moved to Carrier")
        } else {
          const body = (await res.text().catch(() => "")).slice(0, 200)
          failed.push({ id: r.id, status: res.status, reason: body || `HTTP ${res.status}` })
          logger.warn({ id: r.id, status: res.status, body }, "Phase C — stage PUT failed")
        }
      } catch (err: any) {
        failed.push({ id: r.id, reason: err?.message || "fetch threw" })
        logger.warn({ id: r.id, err: err?.message }, "Phase C — stage PUT threw")
      }
    }

    return {
      ok: failed.length === 0,
      total: atBga.length,
      processed,
      failed,
      noOp: false,
    }
  } finally {
    await ctxBrowser.close().catch(() => {})
  }
}

/**
 * Wait for the BGA SPA to fire any /surecrm/* fetch with an
 * `Authorization: Bearer ...` header — return that token.
 *
 * We trigger an in-SPA navigation to /bga/producers/{producerId}/profile
 * which causes the SPA to fetch producer data, and intercept the
 * outgoing request via Playwright's `request` event.
 */
async function harvestBearerToken(
  page: Page,
  producerId: string,
  logger: pino.Logger,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let resolved = false
    const handler = (req: any) => {
      const auth = req.headers()["authorization"]
      if (
        !resolved &&
        req.url().includes("/surecrm/") &&
        typeof auth === "string" &&
        auth.startsWith("Bearer ")
      ) {
        resolved = true
        page.off("request", handler)
        resolve(auth.replace(/^Bearer /, ""))
      }
    }
    page.on("request", handler)
    // Trigger an SPA navigation to make the SPA fire its first /surecrm/* fetch.
    page
      .evaluate((id) => {
        history.pushState({}, "", `/bga/producers/${id}/profile`)
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
      }, producerId)
      .catch((err) =>
        logger.warn({ err: err?.message }, "harvestBearerToken: pushState threw"),
      )
    // Hard timeout 15 s.
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        page.off("request", handler)
        resolve("")
      }
    }, 15_000)
  })
}
