# Connections — Latimer.AI Sales Console (a.k.a. "Pipeline Workspace")

A single-file, browser-based sales console with an AI sales partner named **Hal**.
It turns a passive contact ledger into an active workspace: it tracks your
institutional accounts, reads your email to keep them current, briefs you on each
one, and lets you talk things through and co-draft the next email — by text or
voice.

This document is a **template guide**: enough to understand the design and stand
up your own version.

---

## What it does

- **Hal** — an AI sales partner. He reads the recent email thread for each key
  account, writes a short brief (where it stands, who owes a reply, the best next
  move), remembers what he's already read, and chats with you about the pipeline
  and co-drafts emails. Text or hands-free voice.
- **Connections** — a permanent ledger of everyone you've reached out to
  (imported from LinkedIn archives), plus decks you share.
- **Conversations** — inbound-email triage (Lead Router), meeting follow-ups from
  your calendar, and a starred priority list.
- **Analytics** — rolling volume + success-rate dashboard.

## Architecture

Deliberately simple and cheap to run:

- **Frontend:** one `index.html` with an inline `<script>` (no build step). Tabs
  are grouped into four menus (Hal / Connections / Conversations / Analytics),
  each showing/hiding a `.panel` section.
- **Hosting:** Cloudflare Pages (static file + Functions). Deploys on every push
  to `main`.
- **Backend:** Cloudflare Pages Functions in `functions/api/`:
  - `state.js` — whole-workspace JSON blob (gzipped) for cloud sync.
  - `contacts.js` — one row per contact in D1; paginated list/filter/counts + bulk upsert.
  - `dashboard.js` — monthly invite/connection aggregates (SQL GROUP BY).
  - `latimer.js` — same-origin proxy to the Latimer completion API (avoids browser CORS).
- **Database:** Cloudflare D1 (SQLite), binding `DB`. Tables in `schema.sql`
  (`app_state` blob + `contacts` rows). Schema auto-creates on first use.
- **Storage model:** localStorage-first, with cloud sync to D1 every ~20s and a
  boot reconciliation (falls back to local-only if offline). Large blobs are
  gzip-compressed (`CompressionStream`) to stay under the ~5 MB quota.

## Hal, in detail

- **Briefs (the "index").** For each account (matched to Gmail by its email
  domains), Hal fetches the recent thread, summarizes it into a compact brief,
  and stores the newest message id (`lastMsgId`) as a watermark. A refresh only
  re-summarizes accounts whose latest email actually changed — so it's cheap.
  **Only summaries/signals are stored — never raw email bodies.**
- **Corrections.** Per account you can record ground-truth facts ("budget is NOT
  confirmed yet"). These override the email in every future brief and chat, and
  survive re-reads.
- **Chat + co-drafting.** Hal reasons from the briefs on file (not by re-reading
  email). When he drafts an email he formats it so the UI shows a card with
  "Open in email" (prefills your mail app) and "Copy".
- **Voice.** Dictate with the mic; toggle "Speak" to have Hal read replies aloud
  (Web Speech API — no external service). A full conversation mode is on the
  roadmap.
- **Auto-sync.** While the app is open, Hal refreshes last-touch + briefs on a
  cadence (default 8h) so the pipeline stays current without manual clicks.

### Swappable model engine

Every Hal model call routes through a single `window.halLLM(system, messages,
maxTokens)` adapter, so the engine is swappable without touching briefs or chat:

- **Claude (Anthropic):** `POST https://api.anthropic.com/v1/messages`,
  browser-direct with the user's own key.
- **Latimer:** `POST https://api.latimer.ai/v2/api/completion` via the
  `functions/api/latimer.js` proxy. System prompt → `additionalInstructions`,
  current turn → `message`, history → `additionalMessages`. Model is one of
  Latimer's supported GPT models.

Switching engines never loses anything Hal remembers — briefs, corrections, and
chat live in your data, not the model.

## Integrations

- **Google (read-only):** in-browser OAuth (Google Identity Services). Scopes:
  `calendar.readonly calendar.events gmail.readonly userinfo.email`. The token is
  in-memory only; email/calendar are read client-side and never sent to any model
  except the summaries you ask Hal to make.
- **Model API key:** stored only in the browser (localStorage), sent straight to
  the provider.

## Data (localStorage keys)

`ledger:contacts`, `ledger:accounts`, `ledger:msgstats`, `router:records`,
`router:apikey` / `router:model`, `hal:provider` / `hal:latimerkey` /
`hal:latimermodel`, `hal:chat`, `hal:speak`, `accounts:lastscan`, `fu:clientid` /
`fu:email`.

## Run your own

1. Fork the repo and create a **Cloudflare Pages** project pointing at it
   (build command: none; output dir: root).
2. Create a **D1** database, bind it as `DB` to the Pages project. Schema
   auto-creates, or run `schema.sql`.
3. Create a **Google OAuth Client ID** (Web) and add your Pages domain to the
   authorized origins; enter it on the Follow-ups tab.
4. On the **Lead Router** tab, add your model key (Anthropic) or choose Latimer
   and add that key + model. This powers Hal's briefs and chat.
5. Import your LinkedIn data export on the **Connection Ledger** tab; add your key
   accounts on **Accounts**.

## Privacy

- Raw email bodies are read into memory only to build a brief and are **never
  stored** — accounts keep summaries/signals alone.
- Google access is read-only and client-side.
- Model/API keys live only in your browser (the Latimer key transits the
  same-origin proxy solely to sign the upstream call; it is not stored or logged).

## Roadmap

- Hands-free conversation mode with an amplitude-reactive Latimer orb.
- Weekly recap email (all activity + per-collaborator slices).
- True background scheduling (server-side cron + email) for recaps.

---

_This is a working template. Adapt the account list, cadence rules, and Hal's
prompts to your own sales motion._
