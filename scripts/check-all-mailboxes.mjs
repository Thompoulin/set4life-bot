/**
 * Peek the most recent emails in Sydney + Keyon + Josue mailboxes via JMAP.
 * Establishes whether SureLC's /email "resend" endpoint actually delivers
 * fresh emails or is a no-op.
 */
import http from "node:http"

const accounts = [
  { name: "Sydney", email: "sydney.desilva.1@agent.set4lifeagency.com", password: "LOz70KiLh7eCXWonUd58yoIS" },
  { name: "Keyon",  email: "keyon.edwards@agent.set4lifeagency.com",  password: "giyJYKJRlDvnS23Y-U1uD3-h" },
]

async function jmapCall(email, pass, methodCalls) {
  const body = JSON.stringify({
    using: ["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],
    methodCalls,
  })
  const auth = Buffer.from(`${email}:${pass}`).toString("base64")
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "mail.set4lifeagency.com",
      port: 8580, path: "/jmap", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": body.length, Authorization: `Basic ${auth}` },
    }, (res) => {
      let data = ""
      res.on("data", c => data += c)
      res.on("end", () => { try { resolve(JSON.parse(data)) } catch { resolve(data) } })
    })
    req.on("error", reject); req.write(body); req.end()
  })
}

for (const acct of accounts) {
  console.log(`\n=== ${acct.name} (${acct.email}) — most recent 8 emails ===`)
  const r = await jmapCall(acct.email, acct.password, [
    ["Email/query", { sort: [{ property: "receivedAt", isAscending: false }], limit: 8 }, "q"],
  ])
  const ids = r?.methodResponses?.[0]?.[1]?.ids || []
  if (!ids.length) { console.log("  (empty mailbox)"); continue }
  const g = await jmapCall(acct.email, acct.password, [
    ["Email/get", { ids, properties: ["from","subject","receivedAt"] }, "g"],
  ])
  const list = g?.methodResponses?.[0]?.[1]?.list || []
  for (const e of list) {
    console.log(`  ${e.receivedAt}  ${(e.from?.[0]?.email||"?").padEnd(35)}  ${(e.subject||"").slice(0,90)}`)
  }
}
