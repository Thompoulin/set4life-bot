/**
 * Pre-Fastlane self-clean for appointment-request duplicates.
 *
 * Each Phase A re-fire of the Fastlane "One Producer Many Carriers"
 * wizard creates fresh appointment-request rows for every carrier
 * the producer doesn't already have at Carrier stage — including
 * carriers they DO have at Producer / BGA stage. Result: re-firing
 * the bot N times produces ~N×9 duplicate rows that pile up at
 * Producer stage and never get signed.
 *
 * (Discovered 2026-05-09 after Zachary's 72 appointment-requests vs
 * the 9 we ever wanted; cleanup script confirmed 63 dupes.)
 *
 * This module captures the BGA SPA Bearer JWT off the live admin
 * session, queries /surecrm/appointments-requests, and DELETEs
 * duplicates by carrier (keeping the most-advanced stage). Called
 * by botRunner before Fastlane runs to make Phase A re-fires
 * idempotent. Returns counts so the caller can SKIP Fastlane
 * entirely if we already have an active request for every carrier.
 */
import type { Page } from "playwright"

const STAGE_RANK: Record<string, number> = {
  Carrier: 4,
  BGA: 3,
  Producer: 2,
  Discarded: 0,
}

interface AppointmentRequest {
  appointmentRequestId: number
  producerId: number
  carrierName?: string
  stage?: string
  subStatus?: string
}

export interface DedupResult {
  total: number
  active: number
  uniqueCarriers: number
  deleted: number
  /** Per-carrier most-advanced stage after dedup. */
  byCarrierStage: Record<string, string>
}

export async function dedupAppointmentRequests(
  page: Page,
  producerId: string | number,
  gaId: string | number,
  logger: any,
): Promise<DedupResult | null> {
  // Capture a valid 3-segment Bearer JWT off any /surecrm/* request
  // the SPA fires while we're navigated.
  let bearer: string | null = null
  const handler = (req: import("playwright").Request) => {
    const a = req.headers()["authorization"]
    if (req.url().includes("/surecrm/") && a?.startsWith("Bearer ")) {
      const b = a.replace("Bearer ", "")
      if (!bearer && b.split(".").length === 3) {
        bearer = b
        page.off("request", handler)
      }
    }
  }
  page.on("request", handler)

  // Touch the SPA so a /surecrm/* call fires (idempotent — if we're
  // already on a producer page, this just re-renders the same view).
  try {
    await page.evaluate((id) => {
      history.pushState({}, "", `/bga/producers/${id}/appointments`)
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
    }, String(producerId))
    await page.waitForTimeout(3000)
  } catch {
    /* fall through */
  }
  if (!bearer) {
    logger.warn(
      { producerId },
      "[dedup] could not capture Bearer JWT — skipping dedup",
    )
    return null
  }

  const listUrl = `https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${producerId}&gaId=${gaId}`
  const res = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  if (!res.ok) {
    logger.warn(
      { producerId, status: res.status },
      "[dedup] could not list appointment-requests",
    )
    return null
  }
  const data: unknown = await res.json()
  const rows: AppointmentRequest[] = Array.isArray(data)
    ? (data as AppointmentRequest[])
    : ((data as { content?: AppointmentRequest[] }).content ?? [])

  const byCarrier = new Map<string, AppointmentRequest[]>()
  for (const r of rows) {
    if (r.stage === "Discarded") continue
    const k = r.carrierName || "?"
    if (!byCarrier.has(k)) byCarrier.set(k, [])
    byCarrier.get(k)!.push(r)
  }

  let deleted = 0
  const byCarrierStage: Record<string, string> = {}
  for (const [carrier, items] of byCarrier.entries()) {
    items.sort((a, b) => {
      const ra = STAGE_RANK[a.stage || ""] ?? 0
      const rb = STAGE_RANK[b.stage || ""] ?? 0
      if (ra !== rb) return rb - ra
      return (b.appointmentRequestId || 0) - (a.appointmentRequestId || 0)
    })
    const keeper = items[0]
    byCarrierStage[carrier] = keeper.stage || "?"
    for (const dup of items.slice(1)) {
      const delUrl = `https://surelc.surancebay.com/surecrm/appointments-requests/${dup.appointmentRequestId}`
      const dr = await fetch(delUrl, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bearer}` },
      })
      if (dr.ok) {
        deleted++
        logger.info(
          {
            producerId,
            carrier,
            deletedId: dup.appointmentRequestId,
            keptId: keeper.appointmentRequestId,
            keptStage: keeper.stage,
          },
          "[dedup] deleted duplicate",
        )
      } else {
        logger.warn(
          {
            producerId,
            carrier,
            id: dup.appointmentRequestId,
            status: dr.status,
          },
          "[dedup] DELETE failed",
        )
      }
    }
  }

  const active = Array.from(byCarrier.values()).reduce(
    (n, list) => n + Math.min(1, list.length),
    0,
  )
  return {
    total: rows.length,
    active,
    uniqueCarriers: byCarrier.size,
    deleted,
    byCarrierStage,
  }
}
