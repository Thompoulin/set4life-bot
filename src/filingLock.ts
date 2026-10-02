/**
 * One filing run per agent / producer at a time.
 *
 * 2026-10-01 17:47 and 17:53 UTC: two admin_setup jobs for Carlos Tovar
 * (agent 539) ran at the same time, 5 minutes apart, each walking Fastlane
 * and each filing a full carrier set (on the wrong producer, as it happened —
 * docs/2026-10-02-fastlane-wrong-producer-carlos-tovar.md). Even on the right
 * producer two concurrent runs both pass the pre-dedup check before either
 * submits, so both file: duplicates by construction.
 *
 * The bot is a single Node process (Dockerfile CMD `node dist/server.js`, one
 * `web` container), so an in-process map is a complete lock. A second request
 * for a key that is held is REFUSED (HTTP 409), not queued: the caller's
 * retry/cooldown logic decides whether to come back, and a queued duplicate
 * would only file what the first run already filed.
 */

const held = new Map<string, { since: number; jobId: string }>()

export interface LockHolder {
  key: string
  since: number
  jobId: string
}

/**
 * Take every key or none. Returns a release function, or the holder that is
 * in the way. Keys are free-form, e.g. `agent:<openId>`, `producer:<id>`.
 */
export function tryAcquireFilingLock(
  keys: Array<string | null | undefined>,
  jobId: string,
): { ok: true; release: () => void } | { ok: false; holder: LockHolder } {
  const wanted = Array.from(new Set(keys.filter((k): k is string => !!k)))
  for (const key of wanted) {
    const h = held.get(key)
    if (h) return { ok: false, holder: { key, ...h } }
  }
  const since = Date.now()
  for (const key of wanted) held.set(key, { since, jobId })
  let released = false
  return {
    ok: true,
    release: () => {
      if (released) return
      released = true
      for (const key of wanted) {
        if (held.get(key)?.jobId === jobId) held.delete(key)
      }
    },
  }
}

/** For /health and tests. */
export function heldFilingLocks(): LockHolder[] {
  return Array.from(held.entries()).map(([key, h]) => ({ key, ...h }))
}

export const AGENT_RUN_IN_PROGRESS = "agent_run_in_progress"
