/**
 * Test whether the original Phase A rep-review emails (from 2026-05-09)
 * still have viable activation URLs. The 3 stuck Producer-stage
 * appointments all correspond to the "3 failed" carriers from Keyon's
 * Phase B run on 2026-05-09 09:29 — the bot's auth/click-flow may have
 * failed back then, but the underlying SureLC link is one-shot
 * "consumed only if successfully signed". If it errored out mid-flow,
 * the link should still be live.
 *
 * For each stuck appointment, pull the corresponding email body, extract
 * the activation URL, and hit it (no auth) — observe the response.
 *   - HTTP 200 + signing form HTML → live, just rerun bot's Phase B
 *   - HTTP 200 + "Already signed / Expired / Invalid" → dead
 *   - HTTP 401/403 → needs auth (last 6 SSN + DOB) — link still live
 */
import http from "node:http"
import https from "node:https"

const accounts = [
  { name: "Keyon", email: "keyon.edwards@agent.set4lifeagency.com", password: "giyJYKJRlDvnS23Y-U1uD3-h",
    stuckCarrier: "Foresters" },
]

async function jmapCall(email, pass, methodCalls) {
  const body = JSON.stringify({
    using: ["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],
    methodCalls,
  })
  const auth = Buffer.from(`${email}:${pass}`).toString("base64")
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "mail.set4lifeagency.com", port: 8580, path: "/jmap", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": body.length, Authorization: `Basic ${auth}` },
    }, (res) => {
      let data = ""; res.on("data", c => data += c)
      res.on("end", () => { try { resolve(JSON.parse(data)) } catch { resolve(data) } })
    })
    req.on("error", reject); req.write(body); req.end()
  })
}

function extractUrl(text, html) {
  const blob = (text || "") + "\n" + (html || "")
  // SureLC review URLs look like:
  //   https://surelc.surancebay.com/sbweb/login.jsp?appointmentId=XXX&sec=YYY
  const m = blob.match(/https:\/\/surelc\.surancebay\.com\/sbweb\/login\.jsp\?appointmentId=\d+&sec=\w+/)
  return m?.[0]
}

for (const acct of accounts) {
  console.log(`\n=== ${acct.name} stuck on ${acct.stuckCarrier} ===`)
  // Find the email matching the stuck carrier
  const r = await jmapCall(acct.email, acct.password, [
    ["Email/query", { sort: [{ property: "receivedAt", isAscending: false }], limit: 20 }, "q"],
  ])
  const ids = r?.methodResponses?.[0]?.[1]?.ids || []
  const g = await jmapCall(acct.email, acct.password, [
    ["Email/get", { ids, properties: ["from","subject","receivedAt","textBody","htmlBody","bodyValues"], fetchAllBodyValues: true }, "g"],
  ])
  const list = g?.methodResponses?.[0]?.[1]?.list || []
  const target = list.find((e) => new RegExp(acct.stuckCarrier, "i").test(e.subject || ""))
  if (!target) { console.log("  no email for this carrier in mailbox"); continue }
  console.log(`  found: ${target.subject}`)
  console.log(`  received: ${target.receivedAt}`)
  // Extract body
  const textPartId = target.textBody?.[0]?.partId
  const htmlPartId = target.htmlBody?.[0]?.partId
  const text = textPartId ? target.bodyValues?.[textPartId]?.value : ""
  const html = htmlPartId ? target.bodyValues?.[htmlPartId]?.value : ""
  const url = extractUrl(text, html)
  if (!url) { console.log("  could not extract activation URL"); continue }
  console.log(`  URL: ${url}`)
  // Hit it
  const u = new URL(url)
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 (S4L probe)" },
      // Don't follow redirects so we see the actual response
    }, (resp) => {
      let body = ""; resp.on("data", c => body += c)
      resp.on("end", () => resolve({ status: resp.statusCode, headers: resp.headers, body }))
    })
    req.on("error", reject); req.end()
  })
  console.log(`  GET → ${res.status}`)
  if (res.headers.location) console.log(`  Location: ${res.headers.location}`)
  // Follow redirect once
  if (res.status === 302 && res.headers.location) {
    const u2 = new URL(res.headers.location)
    const res2 = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: u2.hostname,
        path: u2.pathname + u2.search,
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (S4L probe)" },
      }, (resp) => {
        let body = ""; resp.on("data", c => body += c)
        resp.on("end", () => resolve({ status: resp.statusCode, headers: resp.headers, body }))
      })
      req.on("error", reject); req.end()
    })
    console.log(`  follow → ${res2.status}`)
    res.body = res2.body
  }
  // Look for tell-tale strings in the response
  const body = res.body || ""
  const indicators = [
    { pat: /already.*signed|already.*completed|already.*reviewed/i, label: "ALREADY SIGNED" },
    { pat: /expired|invalid|not\s*found/i, label: "EXPIRED/INVALID" },
    { pat: /enter.*last.*ssn|enter.*last 6|enter.*social|date.*of.*birth/i, label: "AUTH PROMPT (link viable)" },
    { pat: /sign.*here|review.*contract|signature.*pad|please\s+sign/i, label: "SIGN FORM (link viable)" },
    { pat: /<form/i, label: "HAS FORM" },
  ]
  for (const ind of indicators) {
    if (ind.pat.test(body)) console.log(`  signal: ${ind.label}`)
  }
  console.log(`  body[:300]: ${body.replace(/\s+/g, " ").slice(0, 300)}`)
}
