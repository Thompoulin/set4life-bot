import { gotoBga, settle, uploadRemoteFile, firstVisible } from "../tabs/helpers.js";
import { harvestBearer } from "./setTransferTypes.js";
const BGA_BASE = "https://surelc.surancebay.com";
async function readAttachments(page, producerId) {
    const bearer = await harvestBearer(page, 15_000);
    if (!bearer)
        return [];
    const res = await fetch(`${BGA_BASE}/surecrm/attachments/${producerId}?withUndefined=true&withUnlinkedBusinessChecks=false`, { headers: { Authorization: `Bearer ${bearer}` } });
    if (!res.ok)
        return [];
    const rows = (await res.json());
    return (Array.isArray(rows) ? rows : []).map((r) => ({
        id: r.id,
        tags: r.tags ?? [],
        formType: r.formType,
        file: r.uploadedFileName ?? r.description,
        carrierId: r.carrierId,
    }));
}
/** Dump any open dialog's text so one run tells us what the tag picker asks for. */
async function captureDialogs(page) {
    return page
        .$$eval("[role=dialog], mat-dialog-container, .mat-mdc-dialog-container", (els) => els.map((e) => e.innerText.slice(0, 600)))
        .catch(() => []);
}
export async function uploadReleaseFormsForProducer(page, logger, input) {
    const uploadEnabled = process.env.LOR_UPLOAD_ENABLED === "true";
    const result = {
        ok: true,
        uploadEnabled,
        uploaded: [],
        reconOnly: [],
        failed: [],
        attachmentsBefore: [],
    };
    const wanted = input.carriers.filter((c) => c.carrierName && c.releaseFormUrl);
    if (wanted.length === 0)
        return result;
    const nav = await gotoBga(page, `${BGA_BASE}/bga/producers/${input.producerId}/documents`, logger);
    if (!nav.ok) {
        result.ok = false;
        result.failed.push({
            carrier: "(all)",
            reason: `BGA session bounced to OAuth at ${nav.finalUrl} opening the Documents tab`,
        });
        return result;
    }
    await settle(page, 1_200);
    result.attachmentsBefore = await readAttachments(page, input.producerId);
    const beforeIds = new Set(result.attachmentsBefore.map((a) => a.id));
    if (!uploadEnabled) {
        result.reconOnly = wanted.map((c) => c.carrierName);
        logger.info({
            producerId: input.producerId,
            attachments: result.attachmentsBefore,
            carriers: result.reconOnly,
        }, "[LOR] recon only (LOR_UPLOAD_ENABLED not set) — Documents tab read, nothing written");
        return result;
    }
    // ── Write path ──
    for (const carrier of wanted) {
        try {
            // Same primitive that already lands AML + E&O on this producer.
            const picked = await uploadRemoteFile(page, 'input[type="file"]', carrier.releaseFormUrl, logger);
            if (!picked) {
                result.failed.push({
                    carrier: carrier.carrierName,
                    reason: "no file input on the Documents tab (UI changed?)",
                });
                continue;
            }
            await settle(page, 2_000);
            // SureLC asks for a document type after the file is chosen. Capture
            // whatever it shows — this is what pins the correct tag — then make
            // a best-effort save. If the labels don't match, the read-back below
            // catches it rather than us assuming success.
            const dialogs = await captureDialogs(page);
            if (dialogs.length > 0) {
                result.dialogRecon = [...(result.dialogRecon ?? []), ...dialogs];
                logger.info({ dialogs }, "[LOR] document dialog after file pick");
            }
            const saveBtn = await firstVisible(page, [
                'button:has-text("SAVE")',
                'button:has-text("Save")',
                'button:has-text("UPLOAD")',
                'button:has-text("Upload")',
                'button:has-text("ADD")',
            ]);
            if (saveBtn) {
                await saveBtn.click().catch(() => undefined);
                await settle(page, 3_000);
            }
            // Verification is the read-back, not the click. A new attachment
            // must actually exist on the producer.
            const after = await readAttachments(page, input.producerId);
            result.attachmentsAfter = after;
            const fresh = after.filter((a) => !beforeIds.has(a.id));
            if (fresh.length > 0) {
                fresh.forEach((a) => beforeIds.add(a.id));
                result.uploaded.push(carrier.carrierName);
                logger.info({ carrier: carrier.carrierName, attached: fresh }, "[LOR] release form attached to producer Documents");
            }
            else {
                result.failed.push({
                    carrier: carrier.carrierName,
                    reason: "file was picked but no new attachment appeared — the type/tag step probably wasn't satisfied (see dialogRecon)",
                });
            }
        }
        catch (err) {
            result.failed.push({
                carrier: carrier.carrierName,
                reason: `threw: ${err?.message || "error"}`,
            });
        }
    }
    if (result.failed.length > 0)
        result.ok = false;
    return result;
}
