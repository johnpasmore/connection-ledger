# Connections — Latimer.AI Sales Console ("Pipeline Workspace")

A single-file, browser-based sales console with an AI sales partner named **Hal**.
It turns a passive contact ledger into an active workspace: it tracks your
institutional accounts, reads your email to keep them current, briefs you on each
one, and lets you talk things through and co-draft the next email — by text or
by voice (including a cloned voice).

This is a **template guide**: enough to understand the design and stand up your
own version.

Live app: `connection-ledger.pages.dev` · Repo: `johnpasmore/connection-ledger`

---

## What it does

- **Hal** — an AI sales partner. Reads each key account's recent email, writes a
  short brief (where it stands, who owes a reply, best next move), remembers what
  he's read, chats about the pipeline, co-drafts emails, and can talk out loud.
- **Connections** — a permanent ledger of everyone you've reached out to
  (imported from LinkedIn archives), plus decks.
- **Conversations** — inbound-email triage (Lead Router), calendar follow-ups,
  a starred priority list, and a **recap email** generator.
- **Analytics** — rolling volume + success-rate dashboard.

## Navigation

Four grouped menus:
- **Hal** ▾ — Chat with Hal · Accounts
- **Connections** ▾ — Connection Ledger · Decks
- **Conversations** ▾ — Lead Router · Follow-ups · Priority · Recap email
- **Analytics** — Dashboard

## Architecture

Deliberately simple and cheap to run:

- **Frontend:** one `index.html` with an inline `<script>` (no build step).
- **Hosting:** Cloudflare Pages (static file + Functions); deploys on push to `main`.
- **Backend:** Cloudflare Pages Functions in `functions/api/`:
  - `state.js` — whole-workspace JSON blob (gzipped) for cloud sync.
  - `contacts.js` — one row per contact in D1; paginated list/filter/counts + bulk upsert.
  - `dashboard.js` — monthly invite/connection aggregates (SQL GROUP BY).
  - `latimer.js` — same-origin proxy to the Latimer completion API (avoids CORS).
  - `tts.js` — same-origin proxy to ElevenLabs text-to-speech (avoids CORS; also verifies a voice via `GET /v1/voices/{id}`).
- **Database:** Cloudflare D1 (SQLite), binding `DB`. Tables in `schema.sql`
  (`app_state` blob + `contacts` rows); schema auto-creates on first use.
- **Storage model:** localStorage-first, cloud sync to D1 every ~20s with a boot
  reconciliation (falls back to local-only if offline). Large blobs are
  gzip-compressed (`CompressionStream`) to stay under the ~5 MB quota.

## Hal, in detail

- **Briefs (the "index").** Per account (matched to Gmail by email domains), Hal
  summarizes the recent thread into a compact brief and stores the newest message
  id (`lastMsgId`) as a watermark, so a refresh only re-summarizes accounts whose
  latest email changed. **Only summaries/signals are stored — never raw bodies.**
- **Auto-sync.** While the app is open, Hal refreshes last-touch + briefs on a
  cadence (default 8h) so the pipeline stays current without manual clicks.
- **Corrections.** Per account you can record ground-truth facts that override the
  email in every future brief and chat, and survive re-reads.
- **Chat + co-drafting.** Hal reasons from the briefs on file. Email drafts render
  as a card with "Open in email" (prefills your mail app) and "Copy". A floating
  "Ask Hal" widget is available on every tab; "Clear chat" wipes the conversation.
- **Voice.** A voice selector next to the chat lists your browser voices and, when
  configured, **🎙 My ElevenLabs voice** (a custom/cloned voice). 🔊 Speak reads
  replies aloud; **🎙 Talk** is a hands-free conversation mode with an
  amplitude-reactive orb (the Latimer star). With ElevenLabs the orb modulates to
  Hal's real voice; captions type out as he speaks.

### Swappable model engine

Every Hal model call routes through a single `window.halLLM(system, messages,
maxTokens)` adapter, so the engine is swappable without touching briefs or chat:

- **Claude (Anthropic):** `POST https://api.anthropic.com/v1/messages`, browser-direct with the user's key.
- **Latimer:** `POST https://api.latimer.ai/v2/api/completion` via the `latimer.js`
  proxy. System → `additionalInstructions`, current turn → `message`, history →
  `additionalMessages`. Model is one of Latimer's supported GPT models.

Switching engines never loses anything Hal remembers — briefs, corrections, and
chat live in your data, not the model.

## Recap email (Conversations → Recap email)

On-demand recap of email activity with prospect accounts over a period
(1 week / 1 month / 1 year), with three sections:
1. **All activity** across the prospects,
2. **Threads involving scott@latimer.ai**,
3. **Threads involving barika@latimer.ai**,

so sections 2 and 3 can be copied to those people. It scans Gmail per account by
domain, detects who's on each thread (From/To/Cc), has Hal write the sections, and
opens a prefilled email to john@latimer.ai (plus "Copy all").

**Automatic send (browser closed).** The same recap can go out on its own every
**Monday 7am (America/New_York)**. Because Cloudflare Pages Functions can't run on
a schedule, a small companion **Worker** (`worker/recap/`) owns the cron; it shares
the same D1 database and mirrors the on-demand recap exactly. A one-time Google
offline consent (read + send) stores an **encrypted** refresh token in D1
(`recap_auth`); the Worker refreshes it each week, reads Gmail, has the model write
the recap, and sends it, recording each run in `recap_log` (never double-sends per
ISO week). Wire-up is the **Automatic weekly email** card on the Recap tab plus the
steps in `RECAP-SETUP.md`. OAuth lives in `functions/api/recap/` (`connect`,
`callback`, `status`).

## Integrations

- **Google (read-only):** in-browser OAuth (Google Identity Services). Scopes:
  `calendar.readonly calendar.events gmail.readonly userinfo.email`. Token is
  in-memory only; email/calendar are read client-side.
- **Model + voice keys:** stored only in the browser. Model calls and TTS transit
  the same-origin proxies solely to sign the upstream request (not stored/logged);
  `LATIMER_API_KEY` / `ELEVENLABS_API_KEY` env vars are optional server-side fallbacks.

## Data (localStorage keys)

`ledger:contacts`, `ledger:accounts`, `ledger:msgstats`, `router:records`,
`router:apikey` / `router:model`, `hal:provider` / `hal:latimerkey` /
`hal:latimermodel`, `hal:voice`, `hal:elevenkey` / `hal:elevenvoice`, `hal:speak`,
`hal:chat`, `accounts:lastscan`, `fu:clientid` / `fu:email`.

## Run your own

1. Fork the repo; create a **Cloudflare Pages** project pointing at it (no build; output dir root).
2. Create a **D1** database, bind it as `DB`. Schema auto-creates, or run `schema.sql`.
3. Create a **Google OAuth Client ID** (Web); add your Pages domain to authorized origins; enter it on Follow-ups.
4. On **Lead Router → Edit API**: add your model key (Anthropic) or choose Latimer + key + model. Optionally add an ElevenLabs key (starts with `sk_`) + voice ID for a custom voice.
5. Import your LinkedIn export on **Connection Ledger**; add key accounts on **Accounts**.

## Privacy

- Raw email bodies are read into memory only to build a brief/recap and are
  **never stored** — accounts keep summaries/signals alone.
- Google access is read-only and client-side.
- API/voice keys live only in your browser (they pass through the same-origin
  proxies only to sign upstream calls; not stored or logged).

---

_This is a working template. Adapt the account list, cadence rules, and Hal's
prompts to your own sales motion._
