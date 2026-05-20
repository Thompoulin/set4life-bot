/**
 * Seed appointment-requests for the 3 active agents with NO carriers:
 * Holton Buggs, Terrence Gray, Brandon Sims.
 * Calls the bot's /create-appointment-requests endpoint for each.
 */
const targets = [
  { producerId: "11096584", name: "Holton Buggs" },
  { producerId: "11168051", name: "Terrence Gray" },
  { producerId: "11474775", name: "Brandon Sims" },
]

for (const t of targets) {
  console.log(`\n=== ${t.name} (${t.producerId}) ===`)
  const r = await fetch("https://s4l-surelc-bot.set4lifeagency.com/create-appointment-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer 49e7c51a01946d0fc89b4bdc07c913c3208919be58b18d85270a79c9e5f2bfa0" },
    body: JSON.stringify({
      producerId: t.producerId,
      templateProducerId: "11482453", // Sydney
      adminCreds: { email: "admin+bot@set4lifeagency.com", password: "pvG7Dkp5eiyf8LT!" },
    }),
    signal: AbortSignal.timeout(180_000),
  })
  const data = await r.json().catch(() => ({}))
  console.log(`  HTTP ${r.status} — ${JSON.stringify(data).slice(0, 400)}`)
}
