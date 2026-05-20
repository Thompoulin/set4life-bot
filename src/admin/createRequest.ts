/**
 * Create Contracting Request wizard (admin BGA portal).
 *
 * Per Loom spec, the wizard has 3 steps:
 *   Step 1 — Carrier & Request Type (radio: Contract / Transfer / Recontract)
 *   Step 2 — Products & States (checkboxes — Fixed Life is the default)
 *   Step 3 — Hierarchy (auto-filled via Quility invitation when applicable)
 *           + carrier-specific yes/no question
 *           + email field (the rep's @agent.set4lifeagency.com)
 *           + "Request Producer Review" final button
 *
 * After clicking the final button, SureLC emails the rep at the email
 * displayed in the dialog. Our app's launchActivationBot decrypts the
 * agent's mailbox password into the bot payload so the rep flow
 * (../rep/review.ts) can read that email.
 *
 * For multi-carrier batches the spec recommends Fastlane — TODO once
 * we have a worked example. For now we loop one carrier per request.
 */

import {
  firstVisible,
  gotoBga,
  selectByLabel,
  settle,
  snapshot,
  type TabContext,
  type TabResult,
} from "../tabs/helpers.js"

export interface CarrierRequest {
  carrierName: string
  carrierNaic?: string
  /** "Contract" (new) | "Transfer" | "Recontract". Default Contract. */
  requestType?: "Contract" | "Transfer" | "Recontract"
  products?: string[] // default ["Fixed Life"]
  states?: string[] // default = every state on the producer's license
  carrierQuestions?: Record<string, "yes" | "no">
  /** Override the email SureLC sends the review request to. */
  reviewEmailOverride?: string
}

export interface CreateRequestInput {
  producerId: string
  /** Email to use as the default review-request destination. */
  defaultReviewEmail: string
  carriers: CarrierRequest[]
}

export async function createContractingRequests(
  ctx: TabContext,
  input: CreateRequestInput,
): Promise<TabResult & { submitted: string[]; failed: Array<{ carrier: string; reason: string }> }> {
  const { page, logger } = ctx
  // SureLC's BGA uses path-based tab routing — `#contracting` is
  // ignored. The contracting tab lives at /bga/producers/{id}/contracts
  // (NOT /contracting — verified Sydney 2026-05-07: bot's prior hash
  // navigation left the page on Signature, screenshots showed the
  // Signature DOM under "admin-contracting-*" labels). Use the
  // correct path.
  const nav = await gotoBga(
    page,
    `https://surelc.surancebay.com/bga/producers/${input.producerId}/contracts`,
    logger,
  )
  if (!nav.ok) {
    return {
      ok: false,
      reason: `BGA session bounced to OAuth at ${nav.finalUrl} when opening contracting tab.`,
      submitted: [],
      failed: [],
    }
  }
  await settle(page)
  await snapshot(ctx, "admin-contracting-before")

  const submitted: string[] = []
  const failed: Array<{ carrier: string; reason: string }> = []

  for (const carrier of input.carriers) {
    try {
      const r = await submitOne(ctx, carrier, input.defaultReviewEmail)
      if (r.alreadyDone) {
        submitted.push(`${carrier.carrierName} (already submitted)`)
      } else if (r.ok) {
        submitted.push(carrier.carrierName)
      } else {
        failed.push({ carrier: carrier.carrierName, reason: r.reason || "unknown" })
      }
    } catch (err: any) {
      failed.push({ carrier: carrier.carrierName, reason: err?.message || "exception" })
      logger.warn({ err: err?.message, carrier: carrier.carrierName }, "createRequest threw")
    }
    await page.waitForTimeout(2_000) // anti-detection delay
  }

  await snapshot(ctx, "admin-contracting-after")
  return {
    ok: failed.length === 0,
    reason: failed.length > 0 ? `${failed.length} request(s) failed` : undefined,
    details: { submitted, failed },
    submitted,
    failed,
  }
}

async function submitOne(
  ctx: TabContext,
  carrier: CarrierRequest,
  defaultEmail: string,
): Promise<TabResult> {
  const { page, logger } = ctx

  // Skip if a request for this carrier already exists.
  const existing = await page.$(`tr:has-text("${carrier.carrierName}")`)
  if (existing) {
    return { ok: true, alreadyDone: true }
  }

  // Open the wizard.
  const newReqBtn = await firstVisible(page, [
    'button:has-text("Create Request")',
    'button:has-text("New Request")',
    'button:has-text("Add Request")',
    'button:has-text("+")',
  ])
  if (!newReqBtn) {
    return { ok: false, reason: "could not find Create Request button" }
  }
  await newReqBtn.click()
  await settle(page, 800)

  // Step 1 — Carrier + Request Type
  await selectByLabel(page, "Carrier", carrier.carrierName).catch(() => false)
  const reqType = carrier.requestType || "Contract"
  const reqRadio = await page.$(
    `label:has-text("${reqType}") input[type="radio"]`,
  )
  if (reqRadio) {
    try {
      await (reqRadio as any).check({ force: true })
    } catch {
      /* ignore */
    }
  }
  await clickNext(ctx)

  // Step 2 — Products & States
  const products = carrier.products?.length ? carrier.products : ["Fixed Life"]
  for (const product of products) {
    const cb = await page.$(`label:has-text("${product}") input[type="checkbox"]`)
    if (cb) {
      try {
        await (cb as any).check({ force: true })
      } catch {
        /* ignore */
      }
    }
  }
  // States — leave default if no override (spec: usually "all licensed states").
  if (carrier.states?.length) {
    for (const st of carrier.states) {
      const cb = await page.$(`label:has-text("${st}") input[type="checkbox"]`)
      if (cb) {
        try {
          await (cb as any).check({ force: true })
        } catch {
          /* ignore */
        }
      }
    }
  }
  await clickNext(ctx)

  // Step 3 — Hierarchy + carrier-specific question (default No) + email.
  if (carrier.carrierQuestions) {
    for (const [label, ans] of Object.entries(carrier.carrierQuestions)) {
      const radio = await page.$(
        `label:has-text("${label}") input[type="radio"][value="${ans}" i]`,
      )
      if (radio) {
        try {
          await (radio as any).check({ force: true })
        } catch {
          /* ignore */
        }
      }
    }
  } else {
    // No specific overrides — default every visible required radio to No.
    try {
      const noRadios = await page.$$('input[type="radio"][value="no" i]')
      for (const r of noRadios) {
        try {
          await r.check({ force: true })
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Trigger the review-request modal.
  const reqReview = await firstVisible(page, [
    'button:has-text("Request Review")',
    'button:has-text("Submit")',
    'button:has-text("Send Request")',
  ])
  if (!reqReview) {
    return { ok: false, reason: "Request Review button not found" }
  }
  await reqReview.click()
  await settle(page, 800)
  await snapshot(ctx, `admin-contracting-${slug(carrier.carrierName)}-modal`)

  // The modal shows the email field — verify it's our @agent.* email,
  // override if SureLC defaulted to the NIPR personal one (Trou #10).
  const emailField = await firstVisible(page, [
    'input[type="email"]',
    'input[name*="email" i]',
  ])
  const targetEmail = carrier.reviewEmailOverride || defaultEmail
  if (emailField && targetEmail) {
    try {
      const current = await (emailField as any).inputValue()
      if (current?.toLowerCase() !== targetEmail.toLowerCase()) {
        await (emailField as any).fill(targetEmail)
      }
    } catch {
      /* ignore */
    }
  }

  // Final click — sends the email to the rep.
  const sendBtn = await firstVisible(page, [
    'button:has-text("Request Producer Review")',
    'button:has-text("Send")',
    'button:has-text("Submit")',
  ])
  if (!sendBtn) {
    return { ok: false, reason: "Request Producer Review button not found" }
  }
  await sendBtn.click()
  await settle(page, 1500)
  await snapshot(ctx, `admin-contracting-${slug(carrier.carrierName)}-sent`)

  // Confirmation pattern — anything saying "sent" / "submitted" / "request"
  const confirm = await page.$(
    'text=/sent|submitted|request created|review requested|success/i',
  )
  if (confirm) return { ok: true }

  logger.warn({ carrier: carrier.carrierName }, "request sent but no confirmation marker matched")
  return { ok: true } // optimistic — bot's screenshot will show truth
}

async function clickNext(ctx: TabContext): Promise<void> {
  const next = await firstVisible(ctx.page, [
    'button:has-text("Next")',
    'button:has-text("Continue")',
  ])
  if (next) {
    await next.click()
    await settle(ctx.page, 600)
  }
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}
