/** Run with: `npx tsx src/admin/dbaContact.test.ts` (no runner in this repo). */
import assert from "node:assert/strict"
import { dbaNeedsWork, normalizeUsPhone, parseDbaValidation } from "./dbaContact.js"

assert.equal(normalizeUsPhone("(318) 555-0142"), "3185550142")
assert.equal(normalizeUsPhone("+1 318.555.0142"), "3185550142")
assert.equal(normalizeUsPhone("13185550142"), "3185550142")
assert.equal(normalizeUsPhone("555-0142"), null)
assert.equal(normalizeUsPhone("0185550142"), null)
assert.equal(normalizeUsPhone(""), null)
assert.equal(normalizeUsPhone(undefined), null)

const luis = [
  { type: "Blocker", view: "appointments", code: "APPOINTMENT:DBA_MISSING_INFO" },
  { type: "Error", view: "dba", code: "DBA:CONTACT_INFO_NOT_VALID", messageData: { dbaId: 1, errors: "CONTACT_PHONE" } },
]
let v = parseDbaValidation(luis)
assert.equal(v.hasDbaIssue, true)
assert.equal(v.contactPhoneInvalid, true)
assert.deepEqual(v.otherFields, [])
assert.equal(dbaNeedsWork(true, v), true, "green icon must not win over a validation error")

v = parseDbaValidation({ "16880769": [
  { type: "Error", view: "dba", code: "DBA:CONTACT_INFO_NOT_VALID", messageData: { errors: "CONTACT_MAILING_ADDRESS, CONTACT_BUSINESS_ADDRESS" } },
  { type: "Error", view: "profile", code: "PROFILE:ADDRESS_NOT_VALID" },
] })
assert.equal(v.contactPhoneInvalid, false)
assert.deepEqual(v.otherFields, ["CONTACT_MAILING_ADDRESS", "CONTACT_BUSINESS_ADDRESS"])
assert.equal(v.issues.length, 1)

v = parseDbaValidation([{ type: "Error", view: "profile", code: "PROFILE:X" }])
assert.equal(v.hasDbaIssue, false)
assert.equal(dbaNeedsWork(true, v), false)
assert.equal(dbaNeedsWork(false, v), true)
assert.equal(dbaNeedsWork(true, null), false, "validation unavailable: fall back to icon")
assert.equal(parseDbaValidation("garbage").hasDbaIssue, false)
console.log("dbaContact tests passed")
