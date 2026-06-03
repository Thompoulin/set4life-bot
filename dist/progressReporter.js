/**
 * Live progress reporter for the SureLC bot.
 *
 * Each tab module / orchestrator step calls reporter.report(step,
 * status, msg) at start + end + on error. The reporter POSTs each
 * event to the main app's callback URL so admin sees live progress
 * in the SureLC Activation page (per-agent expandable row).
 *
 * Failures to POST are logged but never crash the bot — the bot
 * continues even when the main app is unreachable.
 */
/** No-op reporter when the bot wasn't given a callbackUrl. */
const noopReporter = {
    async report() { },
    async startStep() {
        return async () => { };
    },
};
/**
 * Build a reporter that POSTs each event to the callback URL with a
 * shared bearer secret. The callback writes to
 * surelc_enrollment_events on the main app side (status mapped 1:1).
 */
export function makeProgressReporter(opts) {
    if (!opts.callbackUrl || !opts.bearerSecret) {
        return noopReporter;
    }
    const post = async (body) => {
        // 5s timeout — the callback is fire-and-forget telemetry, not a
        // blocking ACK. Without this the main app hangs the bot indefinitely
        // when it's deadlocked waiting on the bot's own response (Sydney
        // 2026-05-07: bot finished all 6 profile tabs in 28s, then sat idle
        // for the next 3 minutes silently waiting on this fetch).
        try {
            await fetch(opts.callbackUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${opts.bearerSecret}`,
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(5000),
            });
        }
        catch (err) {
            opts.logger.warn({ err: err.message }, "[Progress] callback POST failed (telemetry only — continuing)");
        }
    };
    return {
        async report(input) {
            await post({ agentOpenId: opts.agentOpenId, ...input });
        },
        async startStep(step, msg) {
            await post({
                agentOpenId: opts.agentOpenId,
                step,
                status: "in_progress",
                message: msg,
            });
            return async (end) => {
                await post({
                    agentOpenId: opts.agentOpenId,
                    step,
                    status: end.ok ? "success" : "failed",
                    message: end.msg,
                    metadata: end.meta,
                });
            };
        },
    };
}
