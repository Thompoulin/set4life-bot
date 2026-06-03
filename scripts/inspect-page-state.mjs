// Just see what's on a producer's signature tab.
import { chromium } from "playwright"
import pino from "pino"
import { loginAdmin } from "../dist/admin/login.js"
import { gotoBga } from "../dist/tabs/helpers.js"

const producerId = process.argv[2] || "3351482"
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
const logger = pino({ level: "info" })
await loginAdmin(page, { email: process.env.SURELC_ADMIN_EMAIL, password: process.env.SURELC_ADMIN_PASSWORD }, logger)
const nav = await gotoBga(page, `https://surelc.surancebay.com/bga/producers/${producerId}/signature`, logger)
console.error("gotoBga:", nav)
await page.waitForTimeout(6000)
console.error("URL:", page.url())
const text = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || "")
console.error("--- BODY TEXT ---")
console.error(text)
console.error("--- BUTTONS ---")
const btns = await page.$$eval("button", (els) => els.map((e) => e.textContent?.trim()).filter(Boolean))
console.error(btns)
console.error("--- INPUTS ---")
const inputs = await page.$$eval("input", (els) => els.map((e) => ({ type: e.type, name: e.name, visible: e.offsetWidth > 0 })))
console.error(inputs)
await browser.close()
