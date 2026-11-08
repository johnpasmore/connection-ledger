# Notes & reminders by text (Twilio) — setup (one time, ~15 min)

Text your Twilio number and it lands in the console's **Notes** tab. Ask for a
reminder and Hal texts you back at that time — browser closed or not.

| You text | What happens |
|---|---|
| `Howard wants a pilot in Jan` | Saved as a note → "📝 Saved note #14." |
| `remind me tomorrow 9am to call Scott` | Reminder → "⏰ Got it — I'll text you Thu, Nov 12, 9:00 AM: call Scott (#15…)" and at 9:00 ET: "⏰ Reminder: call Scott" |
| `remind me in 20 min to send the deck` | Same, 20 minutes from now |
| `list` | Pending reminders + latest notes |
| `cancel 15` | Cancels reminder #15 |
| `help` | The commands above |

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
signature (made with your Auth Token), and ignores numbers not in `SMS_USERS`.
`/api/sms/notes` (what the Notes tab reads) stays behind Access.

## C. Pages project variables

**Workers & Pages → connection-ledger → Settings → Variables and Secrets:**

| Name | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | from A |
| `TWILIO_AUTH_TOKEN` | from A — type **Secret** |
| `SMS_USERS` | `+1YOURCELL=john@latimer.ai` (comma-separate more people) |
| `SMS_TZ` | optional, default `America/New_York` |
| `SMS_WEBHOOK_URL` | optional — only if the signature check fails because Twilio calls a different URL than the app sees |

Redeploy (push to `main`).

## D. The Worker (sends reminders)

`worker/recap/wrangler.toml` already has the extra `* * * * *` cron. From `worker/recap/`:

```bash
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM_NUMBER   # your Twilio number, +1…
npx wrangler deploy
```

(`TWILIO_MESSAGING_SERVICE_SID` works instead of `TWILIO_FROM_NUMBER`.)

## Test it

1. Text `help` to the number — you should get the command list back.
2. Text `remind me in 2 min to test Hal`. Within ~3 minutes you get the reminder.
3. To send due reminders immediately:
   `https://connection-ledger-recap.<subdomain>.workers.dev/reminders?key=<RECAP_RUN_KEY>`

No reply at all? Check, in order: the Access bypass (B), `SMS_USERS` has your
number in `+1…` form, and Twilio's Monitor → Messaging logs (a 403 there means
the signature check failed → set `SMS_WEBHOOK_URL`).

A reminder whose send fails is retried each minute, up to 3 times, then shown as
**error** with Twilio's message on the Notes tab.

## Turn it off

Clear the webhook URL on the Twilio number, and/or remove the `* * * * *` cron
from `wrangler.toml` and redeploy the Worker.
