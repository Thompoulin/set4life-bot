# s4l-surelc-bot

Standalone Dokku app that runs the Playwright bot completing SureLC
producer-activation forms.

## Why a separate app

The main `s4l-staging` / `s4l-production` app image is ~500MB and
optimized for Node-only. Adding Playwright + Chromium pulls in ~400MB
of extra system deps that would double image size + deploy time on
every unrelated change. Isolating the bot also means a misbehaving bot
run can't take down lead dispatch.

## Runtime

- **HTTP**: Express, all endpoints bearer-auth via `BOT_SHARED_SECRET`:
  - `POST /run-activation` — full Phase A/B/C producer-activation flow
  - `POST /get-bga-tokens` — BGA-portal OAuth login → harvest access + refresh
    JWTs from the SPA's localStorage. Powers the agency LOA carrier sync. See
    `src/bgaTokenCapture.ts`.
  - `POST /producer-appointments` — admin login + Bearer harvest + GET
    `/surecrm/appointments-requests` for a producer. Fallback for
    `syncLocalContracts` when the public x-api-key endpoint hides
    Carrier-stage records.
  - `POST /resend-rep-emails` — list a producer's Producer-stage
    appointments + POST `/surecrm/appointments-requests/{id}/email` each
    to re-trigger SureLC's rep-review email dispatch. NOTE: SureLC's
    resend API returns 204 but isn't always reliable — useful as a
    best-effort fallback; original-email-via-7-day-window usually wins.
  - `POST /create-appointment-requests` — Fastlane fallback. Copies a
    template producer's (e.g. Sydney 11482453) Carrier-stage
    appointments and POSTs new ones for the target rep at their
    resident state. Bypasses the Fastlane wizard entirely when broken
    (e.g. Sandi Kruise training-cert upstream down — Demetrius
    2026-05-10 case).
  - `POST /patch-appointments-to-resident-state` — Phase B wizard-reject
    fallback. PUTs each given `appointmentRequestId.states = resident
    state` only. Strips state-specific wizard steps (FL Counties etc.)
    so the bot's blind-Next can advance.
- **Browser**: Playwright headless Chromium from
  `mcr.microsoft.com/playwright:v1.45.0-jammy` (preinstalled, no download
  on deploy)
- **State**: stateless — evidence screenshots go to
  `/tmp/surelc-evidence/<jobId>/*.png` during a run; the main app
  captures them via the response payload and uploads to S3

## Local dev

```bash
cd surelc-bot
npm install
BOT_SHARED_SECRET=dev-secret npm run dev
```

Smoke test (run-activation):

```bash
curl -X POST http://localhost:3000/run-activation \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "t1",
    "agentOpenId": "pending-dev",
    "activationUrl": "https://example.com",
    "password": "supersecret",
    "agent": { "firstName": "Test", "lastName": "User", "email": "test@example.com" },
    "files": {}
  }'
```

Smoke test (get-bga-tokens):

```bash
curl -X POST http://localhost:3000/get-bga-tokens \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin+bot@set4lifeagency.com","password":"<portal pass>"}'
# → { ok: true, accessToken: "<951-char JWT>", refreshToken: "<999-char>",
#     expiresAt: 1777394797000, finalUrl: ".../bga/oauth?code=...", ... }
# On failure, also returns storageDump + visibleText for diagnostics.
```

## First-time Dokku setup on 45.63.79.64

These steps are one-time infra. NOT run automatically. Paste to the
dokku host SSH session:

```bash
APP=s4l-surelc-bot
dokku apps:create "$APP"
dokku config:set "$APP" BOT_SHARED_SECRET="$(openssl rand -hex 32)"
dokku config:set "$APP" NODE_ENV=production
# Internal-only — don't expose publicly.
dokku proxy:ports-remove "$APP" http:80:3000 || true
# Dokku gives the main app access via the docker bridge network.

# First deploy: push a git subtree of the surelc-bot/ directory as its
# own repo. From the mac:
cd /Users/jeedee/Tresorit/Eugeniuses/Clients/Set4Life/set4life-backoffice
git subtree push --prefix surelc-bot dokku@45.63.79.64:s4l-surelc-bot main
```

The main app reaches it at `http://s4l-surelc-bot.web:3000/run-activation`
(Dokku internal DNS) or via the docker bridge IP — whatever is simpler to
wire up in the main app's env (`SURELC_BOT_URL`).

## Current state of the bot itself

- **`/run-activation` (`src/botRunner.ts`)**: Reconnaissance mode only — follows
  the activation URL, tries to set the password, returns evidence screenshots.
  Form-fill logic (EFT / E&O / AML / Articles uploads) is deliberately **not**
  implemented until we have captured screenshots of the real activation flow.
- **`/get-bga-tokens` (`src/bgaTokenCapture.ts`)**: Active. Drives the agency
  LOA carrier sync. Logs into `https://surelc.surancebay.com/bga/...` with the
  service account, fills the Material email/password form, clicks LOGIN, waits
  for tokens to land in `localStorage.sb:id_token` + `localStorage.sb:refresh_token`,
  returns them. Refresh tokens stay valid for weeks while the account is unused
  interactively.

## Env

| Var | Purpose |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `BOT_SHARED_SECRET` | Bearer token shared with the main app |

## Webhook Integration (Back Office receives SureLC push events)

The main back office app now exposes a webhook endpoint that SureLC
can push status updates to in real time:

```
POST https://app.set4lifeagency.com/api/webhooks/surelc
Header: x-api-key: <SURELC_API_TOKEN>
Content-Type: application/json
```

### Supported Event Types

| Event | Description | Action Taken |
|---|---|---|
| `appointment.completed` | Agent approved by carrier | DB updated to `approved`, SMS sent to agent |
| `appointment.declined` | Carrier rejected agent | DB updated to `rejected`, admin notified, support ticket created |
| `appointment.followup` | Carrier needs follow-up | DB updated to `follow_up_needed`, SMS sent to agent, daily reminders start |
| `appointment.submitted` | Request submitted to carrier | DB updated to `pending_carrier` |
| `appointment.released` | Released from BGA to carrier | DB updated to `pending_carrier` |
| `requirement.pending` | New requirement added | DB updated to `documents_requested`, missing docs tracked |
| `requirement.completed` | Requirement fulfilled | Event logged |

### Webhook Payload Schema

```json
{
  "eventType": "appointment.completed",
  "producerId": 12345,
  "appointmentRequestId": 67890,
  "carrierName": "Mutual of Omaha",
  "carrierNaic": "71412",
  "status": "Completed",
  "agentNumber": "AG123456",
  "npn": "12345678",
  "firstName": "John",
  "lastName": "Doe",
  "rejectReason": null,
  "requirements": [
    { "name": "E&O Certificate", "status": "completed", "description": "..." }
  ],
  "timestamp": "2026-04-28T12:00:00Z"
}
```

### SMS Daily Follow-Up Logic

When a contracting process is in `documents_requested` or `follow_up_needed`
status, the orchestrator (runs every 30 min) sends daily SMS reminders:

1. **Day 1**: Friendly reminder with list of missing documents
2. **Day 2**: Firmer reminder emphasizing urgency
3. **Day 3+**: URGENT message + admin notification + support ticket created

After 3 days without agent response:
- `notifyOwner()` is called (admin gets notification)
- A support ticket is created with priority `high`
- `needsHumanReview` is set to `true` (stops further automated escalation)

The agent can reset the counter by replying to any SMS (sets `agentRespondedAt`).

### Schema Changes (agent_carrier_contracting)

New columns added:
- `sureLcRequestId` (int): Links to SureLC appointment request ID
- `smsReminderCount` (int, default 0): Number of daily SMS reminders sent
- `lastSmsReminderAt` (bigint): Timestamp of last SMS reminder
- `agentRespondedAt` (bigint): Timestamp of last agent SMS reply

New enum value:
- `follow_up_needed`: Added to `contractingStatus` enum

### Bot Payload (POST /run-activation)

The main app sends this payload to the bot:

```json
{
  "jobId": "<agentOpenId>-<timestamp>",
  "agentOpenId": "<openId>",
  "loginUrl": "https://surelc.surancebay.com/producer/",
  "email": "agent@set4lifeagency.com",
  "password": "<decrypted portal password>",
  "agent": {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@set4lifeagency.com",
    "phone": "+15551234567",
    "npn": "12345678",
    "isCorporate": false,
    "signatureName": "John Doe"
  },
  "eft": {
    "routing": "021000021",
    "account": "123456789",
    "accountType": "checking"
  },
  "aml": {
    "completionDate": "2026-01-15"
  },
  "files": {
    "voidedCheck": "https://s3.../voided-check.pdf",
    "eoCertificate": "https://s3.../eo-cert.pdf",
    "amlCertificate": "https://s3.../aml-cert.pdf",
    "articlesOfIncorporation": "https://s3.../articles.pdf",
    "signedLoa": "https://s3.../loa.pdf"
  },
  "carrierSelections": [
    {
      "carrierId": 1,
      "carrierName": "Mutual of Omaha",
      "sureLcCarrierId": "MOO-001",
      "carrierCode": "MOO",
      "isTransfer": false,
      "releaseFormUrl": null
    }
  ],
  "carrierMisc": {
    "militaryStatus": "none",
    "residentCounty": "Miami-Dade"
  }
}
```

### Expected Bot Response

```json
{
  "success": true,
  "stage": "validation_green",
  "needsHumanReason": null,
  "screenshotPath": "/tmp/surelc-evidence/job123/final.png"
}
```
