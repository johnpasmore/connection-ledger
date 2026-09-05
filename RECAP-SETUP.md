# Automatic weekly recap — setup (one time, ~15 min)

This wires up the **Monday 7:00am ET** recap email to `john@latimer.ai` that
Hal sends **even when your browser is closed**. It reuses your existing D1
database and mirrors the on-demand recap on the **Recap** tab (same accounts,
same Gmail queries, same three sections: all activity · Scott · Barika).

**How it works.** Cloudflare Pages Functions can't run on a schedule, so a tiny
companion **Worker** owns the cron. You consent to Google once (offline read +
send); the refresh token is stored **encrypted** in D1. Every Monday the Worker
wakes up, reads your Gmail, has the model write the recap, and sends it.

You'll do three things: **(A)** set up the Google OAuth client, **(B)** add
secrets to the Pages project and run the schema, **(C)** deploy the cron Worker.

---

## A. Google OAuth client (Google Cloud Console)

latimer.ai is on Google Workspace, so this is quick.

1. **Google Cloud Console → APIs & Services → Enabled APIs** → enable **Gmail API**.
2. **OAuth consent screen** → make sure it's set up (Internal is fine for a
   Workspace domain). Under **Data access / Scopes**, add:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/userinfo.email`
3. **Credentials → Create credentials → OAuth client ID → Web application**
   (or reuse your existing Web client). Under **Authorized redirect URIs** add
   **exactly**:
   ```
   https://connection-ledger.pages.dev/api/recap/callback
   ```
   (Use your real Pages domain if it differs.)
4. Copy the **Client ID** and **Client secret** — you'll paste them in step B.

> This is a different grant type than the in-browser "Follow-ups" login: that one
> is read-only and in-memory; this one is offline (a stored refresh token) and
> adds send. That's why it needs a one-time re-consent.

---

## B. Pages project secrets + schema

**Cloudflare dashboard → Workers & Pages → connection-ledger → Settings →
Variables and Secrets.** Add (type **Secret** for the sensitive ones):

| Name | Value |
|------|-------|
| `GOOGLE_CLIENT_ID` | from step A |
| `GOOGLE_CLIENT_SECRET` | from step A |
| `RECAP_ENC_KEY` | any long random string (e.g. `openssl rand -base64 32`) |
| `RECAP_USER_EMAIL` | `john@latimer.ai` (the account whose data the recap is built from) |

Then run the new tables against your D1 database
(**Storage & Databases → D1 → ledger → Console**), or just paste the two
`CREATE TABLE` blocks at the bottom of `schema.sql` (`recap_auth`, `recap_log`).

**Redeploy** the Pages project (push to `main`, or "Retry deployment") so the new
`/api/recap/*` functions go live.

### Connect Google (once)

Open the app → **Conversations → Recap email**. The **Automatic weekly email**
card should now say *not connected*. Click **Connect Google for weekly send**,
approve read + send, and you'll land on a "✓ Weekly recap connected" page. The
card flips to **on ✓**.

---

## C. Deploy the cron Worker

The Worker lives in `worker/recap/`. It shares the D1 database and needs the same
secrets plus a model key.

1. Edit `worker/recap/wrangler.toml` → set `database_id` to your **ledger** D1 id
   (D1 → ledger → *Database ID*).
2. From `worker/recap/`:
   ```bash
   npx wrangler d1 list                       # confirm you can see "ledger"
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put RECAP_ENC_KEY      # SAME value as the Pages project
   npx wrangler secret put ANTHROPIC_API_KEY  # model key (or LATIMER_API_KEY)
   npx wrangler secret put RECAP_RUN_KEY      # any random string, for manual test
   npx wrangler deploy
   ```
   (`RECAP_USER_EMAIL` / `RECAP_RECIPIENT` are already in `wrangler.toml`.)

The cron `0 11,12 * * 1` fires 11:00 **and** 12:00 UTC each Monday; the Worker
checks the real America/New_York clock and only sends at 07:00, so it's correct
in both EST and EDT and never double-sends (a `recap_log` row guards each week).

### Test it now (don't wait for Monday)

```
https://connection-ledger-recap.<your-subdomain>.workers.dev/run?key=<RECAP_RUN_KEY>&force=1
```
`force=1` bypasses the day/hour gate and the weekly-dedupe, gathers the last 7
days, and sends immediately. The JSON response tells you what happened
(`sent`, `skipped: no-activity`, or an `error` with details). Drop `force=1` to
also test the "already sent this week" guard.

---

## What's stored / privacy

- Only an **encrypted** Google refresh token lives in D1 (`recap_auth`); AES-GCM,
  key derived from `RECAP_ENC_KEY`. Nothing readable without that secret.
- The Worker reads Gmail **metadata + snippets** to build the recap, exactly like
  the on-demand version — **no raw bodies are stored**. `recap_log` keeps only
  status + a short detail line per week.
- Hal's scope guardrails still apply (the send is to you only; sections 2/3 are
  the Scott/Barika threads you already see on the Recap tab).

## Turn it off

Remove access at <https://myaccount.google.com/permissions>, and/or delete the
Worker (`npx wrangler delete`) or its cron trigger. Deleting the `recap_auth`
row also stops it.
