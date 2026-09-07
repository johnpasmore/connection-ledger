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
  const qq = /["]/.test(q) ? q : '"' + q + '"';
  const queries = [
    { reason: "address", q: "(from:" + q + " OR to:" + q + " OR cc:" + q + ")" },
    { reason: "subject", q: "subject:" + qq },
    { reason: "body", q: qq },
  ];

  // Collect ids per reason (address/subject first so they win the per-thread cap).
  const reasonsById = new Map();
  const order = [];
  try {
    for (const { reason, q: gq } of queries) {
      const list = await gFetch(accessToken, "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=" + encodeURIComponent(gq));
      for (const it of (list.messages || [])) {
        if (!reasonsById.has(it.id)) { reasonsById.set(it.id, new Set()); order.push(it.id); }
        reasonsById.get(it.id).add(reason);
      }
    }
  } catch (e) { return json({ ok: false, error: "gmail list: " + msg(e) }, 502); }

  // Fetch metadata + snippet for the union (bounded), then rank.
  const ids = order.slice(0, 40);
  const messages = [];
  const rx = safeRegex(q);
  for (const id of ids) {
    try {
      const full = await gFetch(
        accessToken,
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + id +
          "?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date"
      );
      const H = {};
      ((full.payload && full.payload.headers) || []).forEach((h) => { H[(h.name || "").toLowerCase()] = h.value; });
      const from = H.from || "", to = H.to || "", cc = H.cc || "", subject = H.subject || "(no subject)", snippet = (full.snippet || "").slice(0, 240);
      // Re-derive reasons from the actual headers/snippet so a thread that only
      // matched "body" because the term sat deep in a quoted footer (not in the
      // subject, addresses, or the visible snippet) is dropped as noise.
      const reasons = [];
      if (rx.test(from) || rx.test(to) || rx.test(cc)) reasons.push("address");
      if (rx.test(subject)) reasons.push("subject");
      if (rx.test(snippet)) reasons.push("body");
      if (!reasons.length) continue; // term only in deep quoted body — skip
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

function safeRegex(term) {
  const esc = String(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try { return new RegExp(esc, "i"); } catch (e) { return /$a^/; }
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
