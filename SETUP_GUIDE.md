# Setup & Deployment Guide

Two parts: (A) build/test the agent on your machine, (B) get it live on the salon's phone number.

---

## A. Build & test locally

1. **Install Node.js** (v18+) if you don't have it.

2. **Install dependencies**
   ```bash
   cd massage-text-agent
   npm install
   ```

3. **Get an Anthropic API key** — console.anthropic.com → API Keys → create one.

4. **Set up environment file**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and add your `ANTHROPIC_API_KEY`.

5. **Customize the salon's info** in `config.json`:
   - Name, address, timezone, hours
   - Services, durations, prices
   - Policies (cancellation, late arrival, walk-ins)
   - FAQ entries
   - `handoff.owner_phone` — the owner's personal cell, for escalations
   - `handoff.escalation_keywords` — words that trigger human handoff

6. **Run a local test conversation** (no phone needed):
   ```bash
   npm run test:convo
   ```
   This sends a scripted conversation through the agent and prints replies.
   Check `data.sqlite` to confirm an appointment got created. Edit
   `src/test_conversation.js` to try other scenarios (FAQ questions, cancellations,
   escalation phrases like "I want to speak to a manager").

7. **Iterate** on `config.json` and `src/prompt.js` until the agent's tone and
   answers feel right.

---

## B. Get it live on the salon's number

### 1. Get a Twilio account + phone number
- Sign up at twilio.com.
- Buy an SMS-capable phone number ($1-2/mo, plus ~$0.0079/message).
- Add Twilio credentials to `.env` (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_PHONE_NUMBER`).

### 2. Decide on the salon's number
Most small salons want to **keep their existing number** — customers already have it saved.
Two options:

- **Forward their existing number to the Twilio number.** Their carrier (Verizon, AT&T,
  etc.) sets up call/text forwarding from the old number to the new Twilio number.
  Simplest, no porting required, but SMS forwarding support varies by carrier — check first.

- **Port the number into Twilio.** Twilio becomes the carrier for that number. More
  involved (porting paperwork, ~1-2 weeks), but the salon keeps texting/calling
  from the same number going forward, and you have full control. Recommended for
  a permanent setup.

Either way, give customers a heads up that texts may now be answered by an assistant.

### 3. Deploy the server
The agent needs to run somewhere reachable by Twilio (a public HTTPS URL). Cheapest options:

- **Render / Railway / Fly.io** — free or ~$5-7/mo tier, easiest for a small Node app.
  Push the repo, set environment variables (`ANTHROPIC_API_KEY`, Twilio creds) in their
  dashboard, deploy.
- Make sure `data.sqlite` is on a persistent disk/volume — on most free tiers the
  filesystem resets on redeploy, so check your host's docs for a persistent volume option
  (or move to a hosted Postgres later if this becomes permanent).

### 4. Connect Twilio to your server
- In Twilio console → Phone Numbers → your number → Messaging configuration.
- Set "A message comes in" webhook to: `https://<your-deployed-url>/sms`, method `POST`.
- Save.

### 5. Set the admin password and reminder cron
- Set `ADMIN_PASSWORD` in `.env` to something the owner will use.
- On the host, schedule `node src/reminders.js` to run every 15 min (cron, or your
  host's "scheduled jobs" feature) — see README for the cron line.

### 6. Test end-to-end
- Text the Twilio number (or the salon's forwarded number) from your phone.
- Confirm replies come back, FAQs are answered correctly, and a test booking
  appears in `data.sqlite`.
- Test an escalation phrase (e.g. "I want a refund") — confirm:
  - the agent stops replying to that number
  - the owner's phone receives an SMS about it
  - the conversation shows up as "PAUSED" at `/admin`, where you can reply and
    then click "Resume agent"
- Visit `/admin` and confirm the upcoming appointment shows up and can be cancelled.

### 7. Go live checklist
- [ ] Owner has the `/admin` URL, username (`admin`), and password saved
- [ ] Owner has done a practice run: reply to a paused conversation, then resume the agent
- [ ] Reminder cron job is running on the host (check `reminders.log`)
- [ ] Walk through `config.json` once more with the owner for accuracy
      (prices, hours, policies — the agent only knows what's in this file)
- [ ] Confirm Twilio account has auto-recharge or enough balance for SMS volume

---

## Ongoing costs (rough)
- Twilio number: ~$1-2/mo
- Twilio SMS: ~$0.0079 per message sent/received
- Anthropic API: usage-based, a few dollars/month for a low-volume salon
- Hosting: free–$7/mo depending on provider

## What to build next (if expanding to more salons)
1. Multi-tenant support (one deployment serving many salons, keyed by Twilio number)
2. Move from SQLite to hosted Postgres for durability across redeploys
3. Capacity/rooms support if a salon runs multiple simultaneous appointments
