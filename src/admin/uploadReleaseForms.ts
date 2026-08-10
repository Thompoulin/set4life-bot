/**
 * Attach a Letter of Release for a Transfer appointment-request.
 *
 * Why this exists
 * ---------------
 * `admin/setTransferTypes` flips a rep's appointment from "Contract" to
 * "Transfer" whenever they declared a prior contracting during
 * onboarding. That flip is correct — without it the carrier declines the
 * request, because the rep is already on record with another broker. But
 * a transfer is the case where somebody eventually wants the release
 * form from the previous agency, and nothing ever attached one: the LOR
 * step was parked as "route not discovered", and the main app didn't
 * even put `releaseFormUrl` on the wire.
 *
 * Where the document actually goes (verified in live BGA, 2026-08-10)
 * -------------------------------------------------------------------
 * Not on the appointment-request. Every attempt to find an
 * appointment-level document route failed because there isn't one — the
 * appointment object carries `requirements`, and none of its 40 entries
 * is a Letter of Release.
 *
 * Compliance documents live on the PRODUCER, under the Documents tab:
 *
 *     UI    /bga/producers/{producerId}/documents
 *     API   GET /surecrm/attachments/{producerId}
 *
 * Each attachment carries `tags` (e.g. "E&O Insurance", "Training",
 * "Signature Authorization"), a `formType`, and a `carrierId` — so a
 * carrier-specific document is representable.
 *
 * And we already write there. A live producer's E&O attachment is named
 * `surelc-upload-1780419757680-eo_insurance-…pdf`, which is exactly the
 * temp-file pattern from tabs/helpers.ts `uploadRemoteFile`. So this is
 * not a new integration — it is the same upload the bot already performs
 * twice per agent (AML on Training, cert on E&O), pointed at a third
 * file.
 *
 * Staging
 * -------
 * The one detail still unconfirmed is the exact TAG SureLC wants on a
 * release form; the tag picker only appears in the "ADD NEW DOCUMENT"
 * dialog, which opens a native file chooser. So the write stays behind
 * LOR_UPLOAD_ENABLED until one real run confirms it, and every run —
 * enabled or not — logs the dialog structure it encounters plus a
 * before/after diff of the producer's attachments. Verification is by
 * read-back against the attachments API, not by trusting the click.
 */
import type { Page } from "playwright"
import { gotoBga, settle, uploadRemoteFile, firstVisible } from "../tabs/helpers.js"
import { harvestBearer } from "./setTransferTypes.js"

export interface ReleaseFormCarrier {
  carrierName: string
  /** Absolute S3 URL of the LOR PDF. */
  releaseFormUrl: string
}

export interface UploadReleaseFormsInput {
  producerId: string
  carriers: ReleaseFormCarrier[]
}

export interface AttachmentSummary {
  id: number
  tags: string[]
  formType?: string
  file?: string
  carrierId?: number
}

export interface UploadReleaseFormsResult {
  ok: boolean
  uploadEnabled: boolean
  /** Carriers whose LOR was confirmed present after upload (read-back). */
  uploaded: string[]
  /** Recon-mode: inspected, nothing written. */
  reconOnly: string[]
  failed: Array<{ carrier: string; reason: string }>
  /** Producer attachments before / after — the review artifact. */
  attachmentsBefore: AttachmentSummary[]
  attachmentsAfter?: AttachmentSummary[]
  /** Text of any dialog seen after picking the file — reveals the tag picker. */
  dialogRecon?: string[]
}

const BGA_BASE = "https://surelc.surancebay.com"

async function readAttachments(
  page: Page,
  producerId: string,
): Promise<AttachmentSummary[]> {
  const bearer = await harvestBearer(page, 15_000)
  if (!bearer) return []
  const res = await fetch(
    `${BGA_BASE}/surecrm/attachments/${producerId}?withUndefined=true&withUnlinkedBusinessChecks=false`,
    { headers: { Authorization: `Bearer ${bearer}` } },
  )
  if (!res.ok) return []
  const rows = (await res.json()) as any[]
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    id: r.id,
    tags: r.tags ?? [],
    formType: r.formType,
    file: r.uploadedFileName ?? r.description,
    carrierId: r.carrierId,
  }))
}

/** Dump any open dialog's text so one run tells us what the tag picker asks for. */
async function captureDialogs(page: Page): Promise<string[]> {
  return page
    .$$eval(
      "[role=dialog], mat-dialog-container, .mat-mdc-dialog-container",
      (els) => els.map((e) => (e as HTMLElement).innerText.slice(0, 600)),
    )
    .catch(() => [] as string[])
}

export async function uploadReleaseFormsForProducer(
  page: Page,
  logger: any,
  input: UploadReleaseFormsInput,
): Promise<UploadReleaseFormsResult> {
  const uploadEnabled = process.env.LOR_UPLOAD_ENABLED === "true"
  const result: UploadReleaseFormsResult = {
    ok: true,
    uploadEnabled,
    uploaded: [],
    reconOnly: [],
    failed: [],
    attachmentsBefore: [],
  }

  const wanted = input.carriers.filter((c) => c.carrierName && c.releaseFormUrl)
  if (wanted.length === 0) return result

  const nav = await gotoBga(
    page,
    `${BGA_BASE}/bga/producers/${input.producerId}/documents`,
    logger,
  )
  if (!nav.ok) {
    result.ok = false
    result.failed.push({
      carrier: "(all)",
      reason: `BGA session bounced to OAuth at ${nav.finalUrl} opening the Documents tab`,
    })
    return result
  }
  await settle(page, 1_200)

  result.attachmentsBefore = await readAttachments(page, input.producerId)
  const beforeIds = new Set(result.attachmentsBefore.map((a) => a.id))

  if (!uploadEnabled) {
    result.reconOnly = wanted.map((c) => c.carrierName)
    logger.info(
      {
        producerId: input.producerId,
        attachments: result.attachmentsBefore,
        carriers: result.reconOnly,
      },
      "[LOR] recon only (LOR_UPLOAD_ENABLED not set) — Documents tab read, nothing written",
    )
    return result
  }

  // ── Write path ──
  for (const carrier of wanted) {
    try {
      // Same primitive that already lands AML + E&O on this producer.
      const picked = await uploadRemoteFile(
        page,
        'input[type="file"]',
        carrier.releaseFormUrl,
        logger,
      )
      if (!picked) {
        result.failed.push({
          carrier: carrier.carrierName,
          reason: "no file input on the Documents tab (UI changed?)",
        })
        continue
      }
      await settle(page, 2_000)

      // SureLC asks for a document type after the file is chosen. Capture
      // whatever it shows — this is what pins the correct tag — then make
      // a best-effort save. If the labels don't match, the read-back below
      // catches it rather than us assuming success.
      const dialogs = await captureDialogs(page)
      if (dialogs.length > 0) {
        result.dialogRecon = [...(result.dialogRecon ?? []), ...dialogs]
        logger.info({ dialogs }, "[LOR] document dialog after file pick")
      }

      const saveBtn = await firstVisible(page, [
        'button:has-text("SAVE")',
        'button:has-text("Save")',
        'button:has-text("UPLOAD")',
        'button:has-text("Upload")',
        'button:has-text("ADD")',
      ])
      if (saveBtn) {
        await saveBtn.click().catch(() => undefined)
        await settle(page, 3_000)
      }

      // Verification is the read-back, not the click. A new attachment
      // must actually exist on the producer.
      const after = await readAttachments(page, input.producerId)
      result.attachmentsAfter = after
      const fresh = after.filter((a) => !beforeIds.has(a.id))
      if (fresh.length > 0) {
        fresh.forEach((a) => beforeIds.add(a.id))
        result.uploaded.push(carrier.carrierName)
        logger.info(
          { carrier: carrier.carrierName, attached: fresh },
          "[LOR] release form attached to producer Documents",
        )
      } else {
        result.failed.push({
          carrier: carrier.carrierName,
          reason:
            "file was picked but no new attachment appeared — the type/tag step probably wasn't satisfied (see dialogRecon)",
        })
      }
    } catch (err: any) {
      result.failed.push({
        carrier: carrier.carrierName,
        reason: `threw: ${err?.message || "error"}`,
      })
    }
  }

  if (result.failed.length > 0) result.ok = false
  return result
}
