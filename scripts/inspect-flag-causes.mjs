// Per-producer dive: pull full producer detail + training + signature + eno
// state for each of the 6 legitimate-but-flagged producers so we can see
// exactly why SureLC is complaining.
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"

const TARGETS = [
  { id: 11474830, name: "Josue Trigueros" },
  { id: 9726292, name: "Jhovanny Jimenez" },
  { id: 11729150, name: "Doriz Lopez" },
  { id: 356887, name: "Maria Lugo" },
  { id: 2157902, name: "Julissa Chacon" },
  { id: 14881, name: "Sean Way" },
]

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext()).newPage()
let bearer = ""
page.on("request", (r) => {
  const a = r.headers()["authorization"]
  if (a?.startsWith("Bearer ") && r.url().includes("/surecrm/")) bearer = a.replace("Bearer ", "")
})
const logger = pino({ level: "warn" })
await loginAdmin(page, { email: process.env.SURELC_ADMIN_EMAIL, password: process.env.SURELC_ADMIN_PASSWORD }, logger)
await gotoBga(page, "https://surelc.surancebay.com/bga/producers", logger)
await page.waitForTimeout(3000)
if (!bearer) { console.error("no bearer"); process.exit(1) }

const auth = { Authorization: `Bearer ${bearer}` }

const results = []
for (const t of TARGETS) {
  const r = { id: t.id, name: t.name, flags: {}, eno: null, training: null, signature: null, attachments: null }
  try {
    const valRes = await fetch(`https://surelc.surancebay.com/surecrm/validation/list`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify([t.id]),
    })
    r.flags = (await valRes.json()).map((w) => w.code)
  } catch (e) { r.flagsErr = e.message }
  try {
    const eRes = await fetch(`https://surelc.surancebay.com/surecrm/eno/${t.id}`, { headers: auth })
    r.eno = eRes.ok ? await eRes.json() : { httpStatus: eRes.status }
  } catch (e) { r.eno = { err: e.message } }
  try {
    const tRes = await fetch(`https://surelc.surancebay.com/surecrm/training/${t.id}`, { headers: auth })
    r.training = tRes.ok ? await tRes.json() : { httpStatus: tRes.status }
  } catch (e) { r.training = { err: e.message } }
  try {
    const sRes = await fetch(`https://surelc.surancebay.com/surecrm/signature/${t.id}`, { headers: auth })
    r.signature = sRes.ok ? await sRes.json() : { httpStatus: sRes.status }
  } catch (e) { r.signature = { err: e.message } }
  try {
    const aRes = await fetch(`https://surelc.surancebay.com/surecrm/attachments/${t.id}`, { headers: auth })
    r.attachments = aRes.ok ? await aRes.json() : { httpStatus: aRes.status }
  } catch (e) { r.attachments = { err: e.message } }
  results.push(r)
}

console.log(JSON.stringify(results, null, 2))
await browser.close()
