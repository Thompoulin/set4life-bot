import { harvestBearer } from "./setTransferTypes.js";
const BGA_BASE = "https://surelc.surancebay.com/surecrm";
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
];
function summarizeRequirements(appointment) {
    const out = {};
    for (const [key, value] of Object.entries(appointment)) {
        const k = key.toLowerCase();
        if (!REQUIREMENT_KEY_HINTS.some((h) => k.includes(h)))
            continue;
        // Keep arrays shallow — we want shape, not a giant dump in the log.
        if (Array.isArray(value)) {
            out[key] = value.slice(0, 12).map((entry) => entry && typeof entry === "object"
                ? Object.fromEntries(Object.entries(entry).filter(([, v]) => typeof v !== "object" || v === null))
                : entry);
        }
        else {
            out[key] = value;
        }
    }
    return out;
}
/**
 * Candidate attach routes, tried in order. Every one of these is a
 * GUESS modelled on the known `/appointments-requests/{id}` surface —
 * none is confirmed. They only ever run with LOR_UPLOAD_ENABLED=true.
 */
function candidateUploadUrls(appointmentRequestId) {
    const base = `${BGA_BASE}/appointments-requests/${appointmentRequestId}`;
    return [`${base}/documents`, `${base}/attachments`, `${base}/files`];
}
export async function uploadReleaseFormsForProducer(page, logger, input) {
    const uploadEnabled = process.env.LOR_UPLOAD_ENABLED === "true";
    const result = {
        ok: true,
        uploaded: [],
        reconOnly: [],
        notFound: [],
        failed: [],
        recon: [],
        uploadEnabled,
    };
    const wanted = input.carriers.filter((c) => c.carrierName && c.releaseFormUrl);
    if (wanted.length === 0)
        return result;
    // Same SPA nudge as setTransferTypes — cheapest idempotent way to make
    // the page issue a /surecrm/* request so we can lift the Bearer.
    page
        .evaluate((id) => {
        history.pushState({}, "", `/bga/producers/${id}/profile`);
        window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    }, input.producerId)
        .catch(() => undefined);
    const bearer = await harvestBearer(page, 15_000);
    if (!bearer) {
        result.ok = false;
        result.failed.push({ carrier: "(all)", reason: "could not harvest Bearer from SPA" });
        return result;
    }
    const gaId = input.gaId || "1322";
    let list;
    try {
        const listRes = await fetch(`${BGA_BASE}/appointments-requests?producerId=${input.producerId}&gaId=${gaId}`, { headers: { Authorization: `Bearer ${bearer}` } });
        if (!listRes.ok) {
            result.ok = false;
            result.failed.push({
                carrier: "(all)",
                reason: `list appointment-requests HTTP ${listRes.status}`,
            });
            return result;
        }
        list = (await listRes.json());
    }
    catch (err) {
        result.ok = false;
        result.failed.push({
            carrier: "(all)",
            reason: `list appointment-requests threw: ${err?.message || "error"}`,
        });
        return result;
    }
    for (const carrier of wanted) {
        const target = list
            .filter((a) => (a.carrierName || "").trim().toLowerCase() ===
            carrier.carrierName.trim().toLowerCase())
            .filter((a) => a.stage !== "Discarded")[0];
        if (!target) {
            result.notFound.push(carrier.carrierName);
            continue;
        }
        // GET the full row — the list view omits requirements.
        let full;
        try {
            const res = await fetch(`${BGA_BASE}/appointments-requests/${target.appointmentRequestId}`, { headers: { Authorization: `Bearer ${bearer}` } });
            if (!res.ok) {
                result.failed.push({
                    carrier: carrier.carrierName,
                    reason: `GET single HTTP ${res.status}`,
                });
                continue;
            }
            full = (await res.json());
        }
        catch (err) {
            result.failed.push({
                carrier: carrier.carrierName,
                reason: `GET single threw: ${err?.message || "error"}`,
            });
            continue;
        }
        result.recon.push({
            carrier: carrier.carrierName,
            appointmentRequestId: target.appointmentRequestId,
            stage: target.stage,
            type: target.type,
            objectKeys: Object.keys(full).sort(),
            requirementSummary: summarizeRequirements(full),
        });
        if (!uploadEnabled) {
            result.reconOnly.push(carrier.carrierName);
            continue;
        }
        // ── Write path — only with LOR_UPLOAD_ENABLED=true ──
        let fileBuf;
        let filename;
        try {
            const fileRes = await fetch(carrier.releaseFormUrl);
            if (!fileRes.ok) {
                result.failed.push({
                    carrier: carrier.carrierName,
                    reason: `LOR fetch HTTP ${fileRes.status}`,
                });
                continue;
            }
            fileBuf = Buffer.from(await fileRes.arrayBuffer());
            filename =
                decodeURIComponent(carrier.releaseFormUrl.split("?")[0]?.split("/").pop() || "release-form.pdf") || "release-form.pdf";
        }
        catch (err) {
            result.failed.push({
                carrier: carrier.carrierName,
                reason: `LOR fetch threw: ${err?.message || "error"}`,
            });
            continue;
        }
        let attached = false;
        const attempts = [];
        for (const url of candidateUploadUrls(target.appointmentRequestId)) {
            try {
                const form = new FormData();
                form.append("file", new Blob([new Uint8Array(fileBuf)], { type: "application/pdf" }), filename);
                const res = await fetch(url, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${bearer}` },
                    body: form,
                });
                attempts.push(`${url} → ${res.status}`);
                if (res.ok) {
                    attached = true;
                    break;
                }
            }
            catch (err) {
                attempts.push(`${url} → threw ${err?.message || "error"}`);
            }
        }
        logger.info({ carrier: carrier.carrierName, attempts }, "[LOR] upload attempts");
        if (attached) {
            result.uploaded.push(carrier.carrierName);
        }
        else {
            result.failed.push({
                carrier: carrier.carrierName,
                reason: `no candidate upload route accepted the LOR (${attempts.join("; ")})`,
            });
        }
    }
    if (result.failed.length > 0)
        result.ok = false;
    return result;
}
