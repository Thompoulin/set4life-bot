/**
 * Letter of Release (LOR) attachment for Transfer appointment-requests.
 *
 * Why this exists
 * ---------------
 * `admin/setTransferTypes` flips a rep's appointment-request from
 * "Contract" to "Transfer" whenever they declared a prior contracting
 * during onboarding. That flip is correct — without it the carrier sees
 * a fresh appointment and declines it, because the rep is already on
 * record with another broker.
 *
 * But the flip is also precisely what makes the carrier stop asking
 * "who are you" and start asking "where is your Letter of Release".
 * Until 2026-08-10 nothing ever attached one: the LOR upload route was
 * never discovered (see the header note in setTransferTypes.ts), AND
 * the main app never even put `releaseFormUrl` on the wire. So every
 * transfer was opted into a requirement it could not satisfy.
 *
 * Two-stage by design
 * -------------------
 * The BGA portal route for attaching a document to an appointment-request
 * is still unknown. Guessing a POST against live SureLC — a shared
 * production account — is not acceptable, so this module splits:
 *
 *   1. RECON (read-only, on by default). GETs each Transfer appointment
 *      and logs its requirement/document structure. One run against a
 *      real transfer tells us exactly which requirement represents the
 *      LOR and what upload affordance hangs off it. Cannot mutate
 *      anything — GET only.
 *
 *   2. UPLOAD (gated OFF by default via LOR_UPLOAD_ENABLED). Attempts
 *      the actual attach. Stays disabled until a recon run confirms the
 *      route, at which point the candidate list below gets replaced by
 *      the single known-correct endpoint.
 *
 * Enable the write side ONLY after recon output has been reviewed:
 *   LOR_UPLOAD_ENABLED=true
 */
import type { Page } from "playwright"
import { harvestBearer } from "./setTransferTypes.js"

const BGA_BASE = "https://surelc.surancebay.com/surecrm"

export interface ReleaseFormCarrier {
  carrierName: string
  /** Absolute S3 URL of the LOR PDF. */
  releaseFormUrl: string
}

export interface UploadReleaseFormsInput {
  producerId: string
  gaId?: string
  carriers: ReleaseFormCarrier[]
}

export interface LorReconRecord {
  carrier: string
  appointmentRequestId: string | number
  stage?: string
  type?: string
  /** Top-level keys on the appointment object — cheap route discovery. */
  objectKeys: string[]
  /**
   * Anything on the appointment that smells like a requirement, document
   * slot, or upload target. This is the payload a human reads to find
   * the LOR route.
   */
  requirementSummary: unknown
}

export interface UploadReleaseFormsResult {
  ok: boolean
  /** Carriers whose LOR was attached (only possible when enabled). */
  uploaded: string[]
  /** Carriers we inspected but did not write to (recon mode). */
  reconOnly: string[]
  /** Transfer carriers with no matching appointment-request. */
  notFound: string[]
  failed: Array<{ carrier: string; reason: string }>
  /** Structural recon for the owner / next implementer. */
  recon: LorReconRecord[]
  uploadEnabled: boolean
}

/** Keys that plausibly carry a requirement or document collection. */
const REQUIREMENT_KEY_HINTS = [
  "requirement",
  "document",
  "attachment",
  "file",
  "form",
  "upload",
  "lor",
  "release",
]

function summarizeRequirements(appointment: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(appointment)) {
    const k = key.toLowerCase()
    if (!REQUIREMENT_KEY_HINTS.some((h) => k.includes(h))) continue
    // Keep arrays shallow — we want shape, not a giant dump in the log.
    if (Array.isArray(value)) {
      out[key] = value.slice(0, 12).map((entry) =>
        entry && typeof entry === "object"
          ? Object.fromEntries(
              Object.entries(entry as Record<string, unknown>).filter(
                ([, v]) => typeof v !== "object" || v === null,
              ),
            )
          : entry,
      )
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Candidate attach routes, tried in order. Every one of these is a
 * GUESS modelled on the known `/appointments-requests/{id}` surface —
 * none is confirmed. They only ever run with LOR_UPLOAD_ENABLED=true.
 */
function candidateUploadUrls(appointmentRequestId: string | number): string[] {
  const base = `${BGA_BASE}/appointments-requests/${appointmentRequestId}`
  return [`${base}/documents`, `${base}/attachments`, `${base}/files`]
}

export async function uploadReleaseFormsForProducer(
  page: Page,
  logger: any,
  input: UploadReleaseFormsInput,
): Promise<UploadReleaseFormsResult> {
  const uploadEnabled = process.env.LOR_UPLOAD_ENABLED === "true"
  const result: UploadReleaseFormsResult = {
    ok: true,
    uploaded: [],
    reconOnly: [],
    notFound: [],
    failed: [],
    recon: [],
    uploadEnabled,
  }

  const wanted = input.carriers.filter((c) => c.carrierName && c.releaseFormUrl)
  if (wanted.length === 0) return result

  // Same SPA nudge as setTransferTypes — cheapest idempotent way to make
  // the page issue a /surecrm/* request so we can lift the Bearer.
  page
    .evaluate((id) => {
      history.pushState({}, "", `/bga/producers/${id}/profile`)
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
    }, input.producerId)
    .catch(() => undefined)

  const bearer = await harvestBearer(page, 15_000)
  if (!bearer) {
    result.ok = false
    result.failed.push({ carrier: "(all)", reason: "could not harvest Bearer from SPA" })
    return result
  }

  const gaId = input.gaId || "1322"
  let list: Array<any>
  try {
    const listRes = await fetch(
      `${BGA_BASE}/appointments-requests?producerId=${input.producerId}&gaId=${gaId}`,
      { headers: { Authorization: `Bearer ${bearer}` } },
    )
    if (!listRes.ok) {
      result.ok = false
      result.failed.push({
        carrier: "(all)",
        reason: `list appointment-requests HTTP ${listRes.status}`,
      })
      return result
    }
    list = (await listRes.json()) as Array<any>
  } catch (err: any) {
    result.ok = false
    result.failed.push({
      carrier: "(all)",
      reason: `list appointment-requests threw: ${err?.message || "error"}`,
    })
    return result
  }

  for (const carrier of wanted) {
    const target = list
      .filter(
        (a) =>
          (a.carrierName || "").trim().toLowerCase() ===
          carrier.carrierName.trim().toLowerCase(),
      )
      .filter((a) => a.stage !== "Discarded")[0]

    if (!target) {
      result.notFound.push(carrier.carrierName)
      continue
    }

    // GET the full row — the list view omits requirements.
    let full: Record<string, unknown>
    try {
      const res = await fetch(
        `${BGA_BASE}/appointments-requests/${target.appointmentRequestId}`,
        { headers: { Authorization: `Bearer ${bearer}` } },
      )
      if (!res.ok) {
        result.failed.push({
          carrier: carrier.carrierName,
          reason: `GET single HTTP ${res.status}`,
        })
        continue
      }
      full = (await res.json()) as Record<string, unknown>
    } catch (err: any) {
      result.failed.push({
        carrier: carrier.carrierName,
        reason: `GET single threw: ${err?.message || "error"}`,
      })
      continue
    }

    result.recon.push({
      carrier: carrier.carrierName,
      appointmentRequestId: target.appointmentRequestId,
      stage: target.stage,
      type: target.type,
      objectKeys: Object.keys(full).sort(),
      requirementSummary: summarizeRequirements(full),
    })

    if (!uploadEnabled) {
      result.reconOnly.push(carrier.carrierName)
      continue
    }

    // ── Write path — only with LOR_UPLOAD_ENABLED=true ──
    let fileBuf: Buffer
    let filename: string
    try {
      const fileRes = await fetch(carrier.releaseFormUrl)
      if (!fileRes.ok) {
        result.failed.push({
          carrier: carrier.carrierName,
          reason: `LOR fetch HTTP ${fileRes.status}`,
        })
        continue
      }
      fileBuf = Buffer.from(await fileRes.arrayBuffer())
      filename =
        decodeURIComponent(
          carrier.releaseFormUrl.split("?")[0]?.split("/").pop() || "release-form.pdf",
        ) || "release-form.pdf"
    } catch (err: any) {
      result.failed.push({
        carrier: carrier.carrierName,
        reason: `LOR fetch threw: ${err?.message || "error"}`,
      })
      continue
    }

    let attached = false
    const attempts: string[] = []
    for (const url of candidateUploadUrls(target.appointmentRequestId)) {
      try {
        const form = new FormData()
        form.append(
          "file",
          new Blob([new Uint8Array(fileBuf)], { type: "application/pdf" }),
          filename,
        )
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}` },
          body: form,
        })
        attempts.push(`${url} → ${res.status}`)
        if (res.ok) {
          attached = true
          break
        }
      } catch (err: any) {
        attempts.push(`${url} → threw ${err?.message || "error"}`)
      }
    }

    logger.info(
      { carrier: carrier.carrierName, attempts },
      "[LOR] upload attempts",
    )

    if (attached) {
      result.uploaded.push(carrier.carrierName)
    } else {
      result.failed.push({
        carrier: carrier.carrierName,
        reason: `no candidate upload route accepted the LOR (${attempts.join("; ")})`,
      })
    }
  }

  if (result.failed.length > 0) result.ok = false
  return result
}
