// GET /api/gmail/search?q=<term>&limit=25
// Relevance-aware Gmail search for Hal, using the offline token JP already granted
// for the weekly recap (recap_auth). Reliable regardless of the in-browser Google
// connection (which expires ~hourly and clears on reload).
//
// Instead of one broad full-text query (which surfaces threads where the term is
// merely buried in a quoted signature), we run three TARGETED searches and tag
// each thread with WHY it matched, so the app can rank and label them:
//   - "address": the term appears in from/to/cc (e.g. someone @harvard.edu)
//   - "subject": the term appears in the subject line
//   - "body":    the term appears anywhere else in the thread
// Returns { ok, count, messages:[{date, from, to, cc, subject, snippet, reasons[]}] }
// Access-gated same-origin, so only signed-in @latimer.ai users reach it.

import { decryptToken, missingConfig, recapUserEmail } from "../recap/_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const need = missingConfig(env);
  if (need.length) return json({ ok: false, error: "backend not configured: " + need.join(", ") }, 500);

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ ok: false, error: "missing q" }, 400);
  const limit = Math.min(30, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20));

  // Load the offline refresh token (prefer the configured user, else 'default', else any row).
  let row;
  try {
    row = await env.DB.prepare("SELECT enc_refresh, scope FROM recap_auth WHERE user_email = ?").bind(recapUserEmail(env)).first();
    if (!row) row = await env.DB.prepare("SELECT enc_refresh, scope FROM recap_auth ORDER BY updated_at DESC LIMIT 1").first();
  } catch (e) { return json({ ok: false, error: "db: " + msg(e) }, 500); }
  if (!row) return json({ ok: false, error: "not connected — visit /api/recap/connect once" }, 409);
  if (!/gmail\.readonly|gmail\.send|mail\.google/.test(row.scope || "")) {
    return json({ ok: false, error: "stored Google grant lacks Gmail read scope — reconnect at /api/recap/connect" }, 403);
  }

  let accessToken;
  try {
    const refresh = await decryptToken(env.RECAP_ENC_KEY, row.enc_refresh);
    accessToken = await refreshAccessToken(env, refresh);
  } catch (e) { return json({ ok: false, error: "token refresh failed: " + msg(e) }, 502); }

  // Gmail-quote the term for phrase matching in subject/body; use the bare term for
  // the address operators (from:/to:/cc: match names and addresses containing it).
  // For a MULTI-WORD term (usually a person's name) also run an UNQUOTED search:
  // Gmail ANDs the tokens, so it matches "Last, First" headers and
  // "First.Last@domain" addresses that an exact-phrase search misses — e.g.
  // "Stacey Stewart" finds From: "Stewart, Stacey <Stacey.Stewart@madd.org>".
  const qTokens = q.split(/\s+/).filter(Boolean);
  const multi = qTokens.length > 1;
  const grp = multi ? "(" + q + ")" : q; // from:(a b) requires both tokens in the field
  const qq = /["]/.test(q) ? q : '"' + q + '"';
  const queries = [
    { reason: "address", q: "(from:" + grp + " OR to:" + grp + " OR cc:" + grp + ")" },
    { reason: "subject", q: "subject:" + qq },
    { reason: "body", q: qq },
  ];
  if (multi) queries.push({ reason: "body", q: q }); // unquoted — tokens AND'd across the whole message

  // Collect ids per reason (address/subject first so they win the per-thread cap).
  const reasonsById = new Map();
  const order = [];
  let lists;
  try {
    // Run the three targeted searches in parallel instead of one after another.
    lists = await Promise.all(queries.map(({ q: gq }) =>
      gFetch(accessToken, "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=" + encodeURIComponent(gq))));
  } catch (e) { return json({ ok: false, error: "gmail list: " + msg(e) }, 502); }
  queries.forEach(({ reason }, i) => {
    for (const it of ((lists[i] || {}).messages || [])) {
      if (!reasonsById.has(it.id)) { reasonsById.set(it.id, new Set()); order.push(it.id); }
      reasonsById.get(it.id).add(reason);
    }
  });

  // Fetch metadata + snippet for the union (bounded), then rank.
  const ids = order.slice(0, 40);
  const messages = [];
  // Token-based match: the term matches a field when its exact text appears OR when
  // ALL of its significant tokens appear there (treating . , @ as separators). This
  // is what makes "Stacey Stewart" match "Stewart, Stacey" and
  // "stacey.stewart@madd.org" — the old exact-substring check dropped both.
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const rawLc = String(q).toLowerCase();
  const termTokens = norm(q).split(" ").filter((t) => t.length >= 2);
  const allIn = (text) => {
    const lc = String(text || "").toLowerCase();
    if (rawLc && lc.indexOf(rawLc) >= 0) return true; // exact substring (covers short terms like "3M")
    if (!termTokens.length) return false;
    const h = " " + norm(text) + " ";
    return termTokens.every((t) => h.indexOf(" " + t + " ") >= 0);
  };
  // Fetch message metadata in parallel batches (was one-at-a-time — the main latency source).
  const metas = await fetchInBatches(ids, 10, (id) => gFetch(
    accessToken,
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + id +
      "?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date"
  ).catch(() => null));
  for (const full of metas) {
    if (!full) continue;
    try {
      const H = {};
      ((full.payload && full.payload.headers) || []).forEach((h) => { H[(h.name || "").toLowerCase()] = h.value; });
      const from = H.from || "", to = H.to || "", cc = H.cc || "", subject = H.subject || "(no subject)", snippet = (full.snippet || "").slice(0, 240);
      if (isBlastSender(from)) continue; // automated/blast/role mail (info@, no-reply@, notifications@…) — not a real conversation
      // Re-derive reasons from the actual headers/snippet so a thread that only
      // matched "body" because the term sat deep in a quoted footer (not in the
      // subject, addresses, or the visible snippet) is dropped as noise.
      const reasons = [];
      if (allIn(from) || allIn(to) || allIn(cc)) reasons.push("address");
      if (allIn(subject)) reasons.push("subject");
      if (allIn(snippet)) reasons.push("body");
      if (!reasons.length) continue; // none of the term's tokens really appear — skip as noise
      let when = H.date ? new Date(H.date) : (full.internalDate ? new Date(+full.internalDate) : null);
      messages.push({
        date: when && !isNaN(when) ? when.toISOString().slice(0, 10) : "",
        from, to, cc, subject, snippet, reasons,
      });
    } catch (e) {}
  }

  // Rank: address > subject > body (by strongest reason), then newest first.
  const w = (m) => (m.reasons.includes("address") ? 3 : 0) + (m.reasons.includes("subject") ? 2 : 0) + (m.reasons.includes("body") ? 1 : 0);
  messages.sort((a, b) => (w(b) - w(a)) || (b.date < a.date ? -1 : b.date > a.date ? 1 : 0));
  const top = messages.slice(0, limit);
  return json({ ok: true, count: top.length, messages: top });
}

// Run fn over items with bounded concurrency (parallel batches), preserving order.
async function fetchInBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = await Promise.all(items.slice(i, i + size).map(fn));
    for (const v of batch) out.push(v);
  }
  return out;
}

// True when a From header is an automated / blast / generic role mailbox rather
// than a real person — so JP's "actual conversations" aren't buried under
// newsletters, notifications, and info@ auto-mail. Keyed on the sender's address
// local-part (and "X via Y" relay names). Deliberately conservative-ish; can be
// loosened per JP's preference.
function isBlastSender(from) {
  const s = String(from).toLowerCase();
  if (/\bvia\b/.test(s)) return true; // "Someone via LinkedIn / Google Groups"
  const addr = (s.match(/[a-z0-9._%+\-]+@/) || [""])[0].replace(/@$/, "");
  return /^(no-?reply|do-?not-?reply|donotreply|reply|notifications?|notify|mailer|mailer-daemon|postmaster|bounces?|newsletters?|digest|listserv|majordomo|mailing|marketing|promo|promotions?|unsubscribe|alerts?|info|hello|contact|updates?|news|team|admin|administrator|webmaster|events?|automated|auto|noreply|billing|receipts?|invoices?|orders?|store|shop|social|community|membership|donate|giving|support|help|hr|jobs|careers|recruiting|comms|communications)$/.test(addr);
}

async function refreshAccessToken(env, refreshToken) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const t = await r.json();
  if (!r.ok || !t.access_token) throw new Error(JSON.stringify(t).slice(0, 160));
  return t.access_token;
}

async function gFetch(accessToken, url) {
  const r = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
  if (!r.ok) { let t = ""; try { t = await r.text(); } catch (e) {} throw new Error(r.status + " " + t.slice(0, 160)); }
  return r.json();
}

function msg(e) { return String(e && e.message ? e.message : e); }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
