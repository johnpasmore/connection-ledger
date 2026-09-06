// GET /api/gmail/search?q=<gmail query>&limit=25
// Server-side Gmail full-text search for Hal, using the offline token JP already
// granted for the weekly recap (recap_auth). This is reliable regardless of the
// in-browser Google connection (which expires ~hourly and clears on reload).
// Returns { ok, messages:[{date, from, to, subject, snippet}] } or { ok:false, error }.
// Access-gated same-origin, so only signed-in @latimer.ai users reach it.

import { decryptToken, missingConfig, recapUserEmail } from "../recap/_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const need = missingConfig(env);
  if (need.length) return json({ ok: false, error: "backend not configured: " + need.join(", ") }, 500);

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ ok: false, error: "missing q" }, 400);
  const limit = Math.min(25, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20));

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

  // List matching message ids, then pull metadata + snippet for the top N.
  let list;
  try {
    list = await gFetch(accessToken, "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=" + limit + "&q=" + encodeURIComponent(q));
  } catch (e) { return json({ ok: false, error: "gmail list: " + msg(e) }, 502); }

  const ids = (list.messages || []).slice(0, limit);
  const messages = [];
  for (const it of ids) {
    try {
      const full = await gFetch(
        accessToken,
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + it.id +
          "?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date"
      );
      const H = {};
      ((full.payload && full.payload.headers) || []).forEach((h) => { H[(h.name || "").toLowerCase()] = h.value; });
      let when = H.date ? new Date(H.date) : (full.internalDate ? new Date(+full.internalDate) : null);
      messages.push({
        date: when && !isNaN(when) ? when.toISOString().slice(0, 10) : "",
        from: H.from || "",
        to: H.to || "",
        subject: H.subject || "(no subject)",
        snippet: (full.snippet || "").slice(0, 240),
      });
    } catch (e) {}
  }
  return json({ ok: true, count: messages.length, messages });
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
