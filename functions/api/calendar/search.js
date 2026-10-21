// GET /api/calendar/search?q=<term>&back=150&ahead=60
// Server-side read of JP's Google Calendar for events related to an account, using
// the offline recap token — so Hal's briefs know about meetings that already
// happened (e.g. a campus visit) and stop suggesting them. Best-effort: if the
// stored Google grant doesn't include Calendar yet, returns 403 and callers simply
// skip calendar (JP re-grants by reconnecting Google on the Recap tab).
// Returns { ok, events:[{date, summary, attendees[], past, status}] }.

import { decryptToken, missingConfig, recapUserEmail } from "../recap/_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const need = missingConfig(env);
  if (need.length) return json({ ok: false, error: "backend not configured: " + need.join(", ") }, 500);

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ ok: false, error: "missing q" }, 400);
  const back = Math.min(400, Math.max(1, parseInt(url.searchParams.get("back") || "150", 10) || 150));
  const ahead = Math.min(180, Math.max(0, parseInt(url.searchParams.get("ahead") || "60", 10) || 60));

  let row;
  try {
    row = await env.DB.prepare("SELECT enc_refresh, scope FROM recap_auth WHERE user_email = ?").bind(recapUserEmail(env)).first();
    if (!row) row = await env.DB.prepare("SELECT enc_refresh, scope FROM recap_auth ORDER BY updated_at DESC LIMIT 1").first();
  } catch (e) { return json({ ok: false, error: "db: " + msg(e) }, 500); }
  if (!row) return json({ ok: false, error: "not connected — visit /api/recap/connect once" }, 409);
  if (!/calendar/.test(row.scope || "")) {
    return json({ ok: false, error: "no-calendar-scope — reconnect Google on the Recap tab to grant Calendar" }, 403);
  }

  let accessToken;
  try {
    const refresh = await decryptToken(env.RECAP_ENC_KEY, row.enc_refresh);
    accessToken = await refreshAccessToken(env, refresh);
  } catch (e) { return json({ ok: false, error: "token refresh failed: " + msg(e) }, 502); }

  const now = Date.now();
  const timeMin = new Date(now - back * 86400000).toISOString();
  const timeMax = new Date(now + ahead * 86400000).toISOString();
  let data;
  try {
    data = await gFetch(accessToken,
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=15" +
      "&timeMin=" + encodeURIComponent(timeMin) + "&timeMax=" + encodeURIComponent(timeMax) + "&q=" + encodeURIComponent(q));
  } catch (e) { return json({ ok: false, error: "calendar: " + msg(e) }, 502); }

  const events = ((data.items) || []).map((ev) => {
    const start = (ev.start && (ev.start.dateTime || ev.start.date)) || "";
    const d = start ? new Date(start) : null;
    return {
      date: d && !isNaN(d) ? d.toISOString().slice(0, 10) : "",
      summary: ev.summary || "(no title)",
      attendees: ((ev.attendees || []).map((a) => a.email).filter(Boolean)).slice(0, 8),
      past: d ? d.getTime() < now : false,
      status: ev.status || "",
    };
  }).filter((e) => e.date && e.status !== "cancelled");
  return json({ ok: true, events });
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
