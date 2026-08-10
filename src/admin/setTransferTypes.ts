/**
 * Post-Fastlane sweep: flip appointment-request type from "Contract"
 * (Fastlane's default) to "Transfer" for any carrier the agent
 * declared a prior contracting with during onboarding.
 *
 * Without this flip the carrier sees the rep's request as a fresh
 * appointment and declines it because the rep is already on record
 * with another broker. Once flipped to "Transfer", the carrier's
 * workflow asks for the Letter of Release (LOR) instead.
 *
 * Recon notes (2026-05-11):
 *   - The BGA portal API at `/surecrm/appointments-requests/{id}`
 *     accepts PUT with a full payload. Mutating `type` to "Transfer"
 *     succeeds (HTTP 200). PATCH is not supported (405).
 *   - We use the same Bearer JWT the rest of the bot harvests from
 *     the SPA's outbound traffic — no separate auth.
 *   - LOR upload endpoint is NOT yet discovered (separate phase).
 */
import type { Page } from "playwright"

export interface SetTransferTypesInput {
  /** Numeric producer id from SureLC. */
  producerId: string
  /** Agency id in SureLC; always 1322 for Set 4 Life today. */
  gaId?: string
  /**
   * Carriers the agent declared a prior contracting with. Matching
   * happens against the appointment-request's `carrierName` (string
   * equality, case-insensitive). carrierName is the canonical SureLC
   * label — same shape `Foresters - Independent Order Of`.
   */
  transferCarrierNames: string[]
}

export interface SetTransferTypesResult {
  ok: boolean
  /** Carriers that we successfully flipped to type=Transfer. */
  flipped: string[]
  /**
   * Carriers we wanted to flip but couldn't find an active
   * appointment-request for (likely Fastlane skipped them, or the
   * carrier's request hasn't been created yet).
   */
  notFound: string[]
  /** Carriers where the PUT call itself failed; reason included. */
  failed: Array<{ carrier: string; reason: string }>
  /** Carriers that were already type=Transfer (idempotent no-op). */
  alreadyTransfer: string[]
}

/**
 * Harvest the surecrm bearer JWT from the page's outbound traffic,
 * waiting up to `timeoutMs` for the first matching request.
 */
export async function harvestBearer(page: Page, timeoutMs = 15_000): Promise<string | null> {
  let bearer: string | null = null
  const handler = (req: any) => {
    if (bearer) return
    const a = req.headers()["authorization"]
    if (
      typeof a === "string" &&
      a.startsWith("Bearer ") &&
      req.url().includes("/surecrm/")
    ) {
      const tok = a.replace(/^Bearer /, "")
      if (tok.split(".").length === 3) {
        bearer = tok
        page.off("request", handler)
      }
    }
  }
  page.on("request", handler)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !bearer) {
    await page.waitForTimeout(250)
  }
  if (bearer === null) page.off("request", handler)
  return bearer
}

export async function setTransferTypesForProducer(
  page: Page,
  logger: any,
  input: SetTransferTypesInput,
): Promise<SetTransferTypesResult> {
  const result: SetTransferTypesResult = {
    ok: true,
    flipped: [],
    notFound: [],
    failed: [],
    alreadyTransfer: [],
  }
  const transferSet = new Set(
    input.transferCarrierNames.map((n) => n.trim().toLowerCase()).filter(Boolean),
  )
  if (transferSet.size === 0) {
    return result
  }

  // Nudge the page so it issues a /surecrm/* request and we can grab
  // the Bearer. Navigating to the producer's profile is the cheapest
  // trigger that's idempotent regardless of where we left off.
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
  const listRes = await fetch(
    `https://surelc.surancebay.com/surecrm/appointments-requests?producerId=${input.producerId}&gaId=${gaId}`,
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
  const list = (await listRes.json()) as Array<any>

  for (const wantedNameRaw of input.transferCarrierNames) {
    const wanted = wantedNameRaw.trim().toLowerCase()
    if (!wanted) continue

    // Pick the most-relevant active (non-Discarded) appointment for
    // this carrier. If multiple, prefer one not already at CARRIER
    // (since Carrier-stage requests are usually past the point of
    // editing the type).
    const candidates = list
      .filter((a) => (a.carrierName || "").trim().toLowerCase() === wanted)
      .filter((a) => a.stage !== "Discarded")
    if (candidates.length === 0) {
      result.notFound.push(wantedNameRaw)
      continue
    }
    // Sort: prefer earlier stages (BGA, Producer) over Carrier — the
    // carrier-stage row is the one that's been emailed, and SureLC
    // may refuse type edits on a request already sent out.
    const stageOrder: Record<string, number> = {
      Producer: 0,
      BGA: 1,
      Carrier: 2,
    }
    candidates.sort(
      (a, b) => (stageOrder[a.stage] ?? 9) - (stageOrder[b.stage] ?? 9),
    )
    const target = candidates[0]

    if (target.type === "Transfer") {
      result.alreadyTransfer.push(wantedNameRaw)
      continue
    }

    // PUT requires the full payload back. Re-fetch the single row so
    // we send back fields we never saw in the list view (e.g.
    // requirements, lastNote). Belt-and-suspenders.
    let fullPayload: any
    try {
      const singleRes = await fetch(
        `https://surelc.surancebay.com/surecrm/appointments-requests/${target.appointmentRequestId}`,
        { headers: { Authorization: `Bearer ${bearer}` } },
      )
      if (!singleRes.ok) {
        result.failed.push({
          carrier: wantedNameRaw,
          reason: `GET single HTTP ${singleRes.status}`,
        })
        continue
      }
      fullPayload = await singleRes.json()
    } catch (err: any) {
      result.failed.push({
        carrier: wantedNameRaw,
        reason: `GET single threw: ${err?.message || "error"}`,
      })
      continue
    }

    const putBody = { ...fullPayload, type: "Transfer" }
    const putRes = await fetch(
      `https://surelc.surancebay.com/surecrm/appointments-requests/${target.appointmentRequestId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(putBody),
      },
    )
    if (!putRes.ok) {
      const errText = await putRes.text().catch(() => "")
      result.failed.push({
        carrier: wantedNameRaw,
        reason: `PUT HTTP ${putRes.status} ${errText.slice(0, 150)}`,
      })
      continue
    }
    const after = await putRes.json().catch(() => null)
    if (after?.type !== "Transfer") {
      result.failed.push({
        carrier: wantedNameRaw,
        reason: `PUT 200 but type=${after?.type ?? "(none)"}`,
      })
      continue
    }
    result.flipped.push(wantedNameRaw)
    logger?.info?.(
      { producerId: input.producerId, carrier: wantedNameRaw, requestId: target.appointmentRequestId, stage: target.stage },
      "[setTransferTypes] flipped to Transfer",
    )
  }

  if (result.failed.length > 0) result.ok = false
  return result
}
