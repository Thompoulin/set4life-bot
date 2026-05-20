/**
 * Run from inside s4l-production via the bot or just over the network
 * to the Stalwart JMAP. List the most recent emails in Keyon's mailbox
 * and Josue's mailbox so we can confirm if the resent rep-review
 * emails actually landed.
 */
const accounts = [
  { name: "Keyon", email: "keyon.edwards@agent.set4lifeagency.com", password: "giyJYKJRlDvnS23Y-U1uD3-h" },
]
// Note: this runs on the dev machine; JMAP listens internally on 8580.
// Going through Caddy on https://mail.set4lifeagency.com:8580 — accept self-signed.
import http from "node:http"

async function jmapCall(email, pass, methodCalls) {
  const body = JSON.stringify({
    using: ["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],
    methodCalls,
  })
  const auth = Buffer.from(`${email}:${pass}`).toString("base64")
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "mail.set4lifeagency.com",
      port: 8580,
      path: "/jmap",
      method: "POST",
      rejectUnauthorized: false,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        Authorization: `Basic ${auth}`,
      },
    }, (res) => {
      let data = ""
      res.on("data", c => data += c)
      res.on("end", () => {
        try { resolve(JSON.parse(data)) } catch { resolve(data) }
      })
    })
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

for (const acct of accounts) {
  console.log(`\n=== ${acct.name} (${acct.email}) ===`)
  // Email/query: 5 most recent
  const r = await jmapCall(acct.email, acct.password, [
    ["Email/query", { sort: [{ property: "receivedAt", isAscending: false }], limit: 5 }, "q"],
  ])
  const ids = r?.methodResponses?.[0]?.[1]?.ids || []
  console.log(`  ids: ${ids.length}`, ids.slice(0,3))
  if (!ids.length) continue
  const g = await jmapCall(acct.email, acct.password, [
    ["Email/get", { ids, properties: ["from","subject","receivedAt"] }, "g"],
  ])
  const list = g?.methodResponses?.[0]?.[1]?.list || []
  for (const e of list) {
    console.log(`  ${e.receivedAt}  from=${e.from?.[0]?.email}  ${(e.subject||"").slice(0,80)}`)
  }
}
