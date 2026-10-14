/**
 * Pure helpers for the DBA tab's contact info.
 *
 * Why: 2026-10-14, Luis Lopez Torres (11410634) and Jairo Medina Segovia
 * (11168535). Fastlane refused to offer them ("Contact info is not valid /
 * DBA information is not valid") while the bot reported the DBA tab green and
 * "filled by bot". SureLC's own POST /surecrm/validation/list said:
 *
 *   {type:"Blocker", view:"appointments", code:"APPOINTMENT:DBA_MISSING_INFO"}
 *   {type:"Error",   view:"dba", code:"DBA:CONTACT_INFO_NOT_VALID",
 *    messageData:{dbaId, errors:"CONTACT_PHONE"}}
 *
 * The tab icon was clear, so the icon alone cannot be trusted. These helpers
 * turn the validation payload into a decision. No I/O here (see
 * dbaContact.test.ts).
 */

/** 10 US digits, or null. Strips formatting and a leading country code 1. */
export function normalizeUsPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  let d = String(raw).replace(/\D/g, "")
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1)
  if (d.length !== 10) return null
  // NANP: area code and exchange cannot start with 0 or 1.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null
  return d
}

export interface DbaValidationIssue {
  code: string
  type?: string
  /** SureLC's sub-fields, e.g. ["CONTACT_PHONE"]. */
  fields: string[]
}

export interface DbaValidationVerdict {
  /** True when SureLC reports any DBA-view error or DBA blocker. */
  hasDbaIssue: boolean
  /** DBA:CONTACT_INFO_NOT_VALID lists CONTACT_PHONE. */
  contactPhoneInvalid: boolean
  /** Other DBA fields SureLC rejects (addresses, ...): not ours to invent. */
  otherFields: string[]
  issues: DbaValidationIssue[]
}

/**
 * Walks whatever shape validation/list returns (array, or keyed per producer)
 * and collects DBA-related issues. Deliberately shape-agnostic: any object
 * with a string `code` that is DBA-prefixed, names APPOINTMENT:DBA_*, or has
 * view "dba" counts.
 */
export function parseDbaValidation(payload: unknown): DbaValidationVerdict {
  const issues: DbaValidationIssue[] = []
  const seen = new Set<unknown>()
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object" || seen.has(n)) return
    seen.add(n)
    if (Array.isArray(n)) return n.forEach(walk)
    const o = n as Record<string, any>
    if (typeof o.code === "string") {
      const code = o.code
      const isDba =
        code.startsWith("DBA:") ||
        /^APPOINTMENT:DBA_/.test(code) ||
        String(o.view || "").toLowerCase() === "dba"
      if (isDba) {
        const raw = o.messageData?.errors
        const fields = (Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(/[,\s]+/))
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
        issues.push({ code, type: typeof o.type === "string" ? o.type : undefined, fields })
      }
    }
    Object.values(o).forEach(walk)
  }
  walk(payload)
  const all = issues.flatMap((i) => i.fields)
  return {
    hasDbaIssue: issues.length > 0,
    contactPhoneInvalid: all.includes("CONTACT_PHONE"),
    otherFields: [...new Set(all.filter((f) => f !== "CONTACT_PHONE"))],
    issues,
  }
}

/** The tab needs work if the icon is not green OR SureLC reports a DBA issue. */
export function dbaNeedsWork(iconGreen: boolean, v: DbaValidationVerdict | null): boolean {
  return !iconGreen || (v?.hasDbaIssue ?? false)
}
