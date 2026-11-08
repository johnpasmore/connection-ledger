# Notes & reminders by text (Twilio) — setup (one time, ~15 min)

Text the Twilio number — **+1 (339) 300-5973** — starting with your code, and it
lands in the console's **Notes** tab. Ask for a reminder and Hal texts you back at
that time — browser closed or not.

| You text (code `jp7`) | What happens |
|---|---|
| `jp7 Howard wants a pilot in Jan` | Saved as a note → "📝 Saved note #14." |
| `jp7 remind me tomorrow 9am to call Scott` | Reminder → "⏰ Got it — I'll text you Thu, Nov 12, 9:00 AM: call Scott (#15…)" and at 9:00 ET: "⏰ Hal reminder: call Scott" |
| `jp7 remind me in 20 min to send the deck` | Same, 20 minutes from now |
| `jp7 list` | Pending reminders + latest notes |
| `jp7 cancel 15` | Cancels reminder #15 |
| `jp7` | The commands above |

**Sharing one number.** Each person picks a code on **Settings → Texting**; the
code says whose text it is. Lock it to your cell and it only works from that
phone. Other apps can share the number too: give each a code and its webhook URL
under *Other apps on this number*, and texts starting with that code are passed
to it (code removed, re-signed with the Twilio token so the app's own signature
check passes) and its reply goes back to the sender. Texts with no code go to the
optional *no code* webhook, or are ignored (a known phone gets a "use your code"
nudge).

Times understood without a model key: *in 20 min / 2 hours / 3 days*, *today*,
*tonight*, *tomorrow*, a weekday (*friday*), a date (*12/1*), *at 3pm*, *at 15:30*,
*noon*. With `ANTHROPIC_API_KEY` set, Hal also reads free-form times
("next Tuesday after lunch"). Times are Eastern unless `SMS_TZ` says otherwise.

**How it works.** Twilio posts each text to `/api/sms/inbound` (a Pages
Function), which stores it in D1 (`sms_notes`, auto-created) and replies inline.
The existing `connection-ledger-recap` Worker gains an every-minute cron that
texts any reminder that has come due.

---

## A. Twilio

1. Buy (or reuse) an SMS-capable number in the Twilio console.
   US numbers need **A2P 10DLC** registration (or use a **toll-free** number and
   complete toll-free verification) before carriers will deliver your texts.
2. Note your **Account SID** and **Auth Token** (Console → Account info).
3. Phone Numbers → your number → **Messaging configuration** →
   *A message comes in*: **Webhook**, **HTTP POST**,
   ```
   https://connection-ledger.pages.dev/api/sms/inbound
   ```
   (your real Pages domain if it differs).

## B. Cloudflare Access — let Twilio through to ONE path

Access protects the whole app, and Twilio can't sign in. Add a bypass for just
the webhook: **Zero Trust → Access → Applications → Add → Self-hosted**, domain
`connection-ledger.pages.dev`, path `api/sms/inbound`, policy action **Bypass**,
include **Everyone**.

That route protects itself: it rejects any request without a valid Twilio
signature (made with your Auth Token), and only acts on texts that start with a known code.
`/api/sms/notes` (what the Notes tab reads) stays behind Access.

## C. Settings → Texting (in the app)

1. Make sure the Pages project has the `RECAP_ENC_KEY` secret (the weekly recap
   setup adds it; otherwise add any long random string). The Twilio Auth Token
   is stored encrypted with it and is never shown again.
2. Open the app → **Settings → Texting (Twilio)**. The number is pre-filled;
   paste the **Account SID** and **Auth Token**, pick **your code**, add your
   **cell**, and **Save**. The card shows the exact webhook URL for step A.3.

Optional Pages variables: `SMS_TZ` (default `America/New_York`) and
`SMS_WEBHOOK_URL` (only if the signature check fails because Twilio calls a
different URL than the app sees). `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` /
`TWILIO_FROM_NUMBER` as Cloudflare variables also work and override Settings.

## D. The Worker (sends reminders)

`worker/recap/wrangler.toml` already has the extra `* * * * *` cron. The Worker
reads the Twilio details you saved in Settings, so it only needs `RECAP_ENC_KEY`
(the same value as Pages — already set if the weekly recap is). Redeploy it from
`worker/recap/`:

```bash
npx wrangler deploy
```

## Test it

1. Text just your code (`jp7`) — you should get the command list back.
2. Text `jp7 remind me in 2 min to test Hal`. Within ~3 minutes you get the reminder.
3. To send due reminders immediately:
   `https://connection-ledger-recap.<subdomain>.workers.dev/reminders?key=<RECAP_RUN_KEY>`

No reply at all? Check, in order: the Access bypass (B), that you started with
your code from the cell saved with it, and Twilio's Monitor → Messaging logs
(a 403 there means the signature check failed → set `SMS_WEBHOOK_URL`; a 503
means the Auth Token isn't saved).

A reminder whose send fails is retried each minute, up to 3 times, then shown as
**error** with Twilio's message on the Notes tab.

## Turn it off

Clear the webhook URL on the Twilio number, and/or remove the `* * * * *` cron
from `wrangler.toml` and redeploy the Worker.
