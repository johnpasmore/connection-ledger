// GET /api/gmail/thread?gq=<gmail query>&max=6&full=0|1
// Server-side read of an account's recent email using the offline recap token —
// the SAME mailbox Hal's chat search uses (john@latimer.ai). This makes the
// Accounts tab (last-touch, who-owes-a-reply, Hal's brief) see exactly the email
// the chat sees, regardless of which Google account is connected in the browser,
// and without triggering in-browser sign-in popups. Messages are newest-first.
// Returns { ok, latestId, myEmail, messages:[{id,dateISO,from,to,subject,body,fromMe}] }.

import { decryptToken, missingConfig, recapUserEmail } from "../recap/_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const need = missingConfig(env);
  if (need.length) return json({ ok: false, error: "backend not configured: " + need.join(", ") }, 500);

  const url = new URL(request.url);
  const gq = (url.searchParams.get("gq") || "").trim();
  if (!gq) return json({ ok: false, error: "missing gq" }, 400);
  const max = Math.min(12, Math.max(1, parseInt(url.searchParams.get("max") || "6", 10) || 6));
  const full = url.searchParams.get("full") === "1";

  let row;
  try {
    row = await env.DB.prepare("SELECT enc_refresh, scope FROM recap_auth WHERE user_email = ?").bind(recapUserEmail(env)).first();
    if (!row) row = await env.DB.prepare("SELECT enc_refresh, scope FROM recap_auth ORDER BY updated_at DESC LIMIT 1").first();
  } catch (e) { return json({ ok: false, error: "db: " + msg(e) }, 500); }
  if (!row) return json({ ok: false, error: "not connected — visit /api/recap/connect once" }, 409);

  const myEmail = recapUserEmail(env) || "";
  let accessToken;
  try {
    const refresh = await decryptToken(env.RECAP_ENC_KEY, row.enc_refresh);
    accessToken = await refreshAccessToken(env, refresh);
  } catch (e) { return json({ ok: false, error: "token refresh failed: " + msg(e) }, 502); }

  let list;
  try {
    list = await gFetch(accessToken, "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=" + max + "&q=" + encodeURIComponent(gq));
  } catch (e) { return json({ ok: false, error: "gmail list: " + msg(e) }, 502); }

  const ids = (list.messages || []).slice(0, max);
  const messages = [];
  for (const it of ids) {
    try {
      const q = full
        ? "?format=full"
        : "?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date";
      const m = await gFetch(accessToken, "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + it.id + q);
      const H = {};
      ((m.payload && m.payload.headers) || []).forEach((h) => { H[(h.name || "").toLowerCase()] = h.value; });
      const from = H.from || "", to = H.to || "", subject = H.subject || "(no subject)";
      const when = H.date ? new Date(H.date) : (m.internalDate ? new Date(+m.internalDate) : null);
      const fromMe = /@latimer\.ai|@futuresum/i.test(from) || !!(myEmail && from.toLowerCase().indexOf(myEmail.toLowerCase()) >= 0);
      messages.push({
        id: it.id,
        dateISO: when && !isNaN(when) ? when.toISOString() : "",
        from, to, subject,
        body: full ? extractBody(m.payload).slice(0, 4000) : "",
        fromMe,
      });
    } catch (e) {}
  }
  return json({ ok: true, latestId: (ids[0] && ids[0].id) || "", myEmail, messages });
}

function extractBody(payload) {
  function walk(p) {
    if (!p) return "";
    if (p.mimeType === "text/plain" && p.body && p.body.data) return b64d(p.body.data);
    if (p.parts) { for (const c of p.parts) { const t = walk(c); if (t) return t; } }
    if (p.mimeType === "text/html" && p.body && p.body.data) return b64d(p.body.data).replace(/<[^>]+>/g, " ");
    return "";
  }
  let t = walk(payload);
  const cut = t.search(/\nOn .{6,140}wrote:/); // drop quoted history
  if (cut > 0) t = t.slice(0, cut);
  return t.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
function b64d(d) {
  try { const s = atob(String(d).replace(/-/g, "+").replace(/_/g, "/")); try { return decodeURIComponent(escape(s)); } catch (e) { return s; } } catch (e) { return ""; }
}
async function refreshAccessToken(env, refreshToken) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
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
