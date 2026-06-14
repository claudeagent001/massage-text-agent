# Massage Parlor Text Agent (prototype)

SMS agent that answers FAQs and books appointments for a single-location massage business.
No per-staff scheduling — just one shared calendar of appointments.

## Setup

```bash
npm install
cp .env.example .env
# edit .env with your ANTHROPIC_API_KEY (and Twilio creds when ready)
```

## Configure the business

Edit `config.json` — hours, services, prices, policies, FAQ, and the owner's phone number
for escalations. This file drives both the system prompt and the booking logic.

## Run a local test conversation (no Twilio needed)

```bash
npm run test:convo
```

This simulates a customer texting in, exercising availability lookup and booking.
Check `data.sqlite` afterwards to see the appointment was created.

## Run the SMS server

```bash
npm start
```

Then point your Twilio number's "A message comes in" webhook at
`https://<your-public-url>/sms` (use ngrok for local testing).

## How it works

- `src/prompt.js` — builds the system prompt from `config.json`
- `src/tools/index.js` — tool implementations: check_availability, create_appointment,
  cancel_appointment, list_my_appointments, notify_owner
- `src/availability.js` — computes open slots from business hours + existing bookings
- `src/agent.js` — the agent loop (Claude + tool use), per-customer conversation history
- `src/db.js` — SQLite schema (appointments, messages, conversation_state)
- `src/server.js` — Express webhook for Twilio SMS, mounts the admin dashboard
- `src/twilioClient.js` — sends SMS via Twilio (falls back to console logging if
  Twilio creds aren't set, so local dev works without an account)
- `src/reminders.js` — standalone script to send appointment reminders, run on a schedule
- `src/admin.js` — password-protected dashboard at `/admin`

## Escalation / human handoff

When `notify_owner` is called (refunds, complaints, injuries, explicit request for a human,
or anything off-script), the conversation is marked `agent_paused` in `conversation_state`,
the agent stops auto-replying to that customer, and the owner gets a real SMS (via
`src/twilioClient.js`) summarizing the situation.

The owner then goes to `/admin` (password-protected, see `ADMIN_PASSWORD` in `.env`) to:
- see the conversation history with that customer
- send a manual reply (sent as a real SMS, logged as `sent_by: owner`)
- click "Resume agent" once the issue is handled, so the agent starts replying again

## Admin dashboard

Visit `https://<your-url>/admin` (or `http://localhost:3000/admin` locally), log in with
username `admin` and the password from `ADMIN_PASSWORD` in `.env`. From there you can:
- view upcoming appointments and cancel any of them
- view all customer conversations, see paused ones, reply manually, and resume the agent

## Reminders

`src/reminders.js` scans for confirmed appointments starting within
`config.booking.reminder_hours_before` hours that haven't had a reminder sent, texts the
customer, and marks `reminder_sent = 1`. Run it on a schedule, e.g. with cron:

```cron
*/15 * * * * cd /path/to/massage-text-agent && node src/reminders.js >> reminders.log 2>&1
```

## Notes / next steps

- Multi-location/multi-tenant: this prototype is single-tenant (one `config.json`,
  one `data.sqlite`). To support multiple salons, key everything by a `salon_id`
  and load config per Twilio number.
- The agent currently has no awareness of staff/rooms — it only checks the shared
  calendar's total capacity (1 concurrent appointment). If the business has multiple
  rooms/therapists working simultaneously, add a `capacity` field to `config.json`
  and adjust the overlap check in `availability.js` accordingly.
- The admin dashboard uses simple HTTP Basic Auth — fine for a single owner, but
  put it behind HTTPS (most hosts provide this by default) since the password
  travels with each request.
