// GET /api/recap/callback?code=...&state=...
// Google redirects here after JP consents. We verify the state cookie, exchange
// the code for tokens, capture the refresh token, encrypt it, and store it in D1
// so the cron Worker can send the weekly recap while the browser is closed.

import { redirectUri, encryptToken, missingConfig, recapUserEmail } from "./_lib.js";

function page(title, body) {
  return new Response(
    "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
      "<title>" + title + "</title>" +
      "<div style=\"font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:12vh auto;padding:0 20px;color:#111\">" +
      body +
      "</div>",
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");

  if (err) return page("Recap — not connected", "<h2>Google consent was cancelled</h2><p>" + escapeHtml(err) + "</p><p><a href='/#recap'>Back to the app</a></p>");

  const need = missingConfig(env);
  if (need.length) return page("Recap — misconfigured", "<h2>Backend not configured</h2><p>Missing: " + escapeHtml(need.join(", ")) + "</p>");
  if (!code) return page("Recap — error", "<h2>No authorization code returned</h2><p><a href='/api/recap/connect'>Try again</a></p>");

  // CSRF check against the cookie set in connect.js.
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)recap_oauth_state=([^;]+)/);
  if (!m || m[1] !== state) return page("Recap — error", "<h2>State mismatch</h2><p>Please <a href='/api/recap/connect'>start again</a>.</p>");

  // Exchange the code for tokens.
  let tok;
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(request),
        grant_type: "authorization_code",
      }),
    });
    tok = await r.json();
    if (!r.ok) return page("Recap — error", "<h2>Token exchange failed</h2><pre>" + escapeHtml(JSON.stringify(tok, null, 2)) + "</pre>");
  } catch (e) {
    return page("Recap — error", "<h2>Could not reach Google</h2><p>" + escapeHtml(String(e && e.message ? e.message : e)) + "</p>");
  }

  if (!tok.refresh_token) {
    // Google only returns a refresh token on first consent unless prompt=consent.
    return page(
      "Recap — no refresh token",
      "<h2>Google didn't return a refresh token</h2>" +
        "<p>This usually means access was granted before. Remove Latimer.AI from your " +
        "<a href='https://myaccount.google.com/permissions'>Google account permissions</a>, then " +
        "<a href='/api/recap/connect'>connect again</a>.</p>"
    );
  }

  // Identify which Google account granted access.
  let googleEmail = "";
  try {
    const ur = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: "Bearer " + tok.access_token },
    });
    if (ur.ok) googleEmail = (await ur.json()).email || "";
  } catch (e) {}

  // Encrypt + store.
  try {
    const enc = await encryptToken(env.RECAP_ENC_KEY, tok.refresh_token);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO recap_auth (user_email, google_email, enc_refresh, scope, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(user_email) DO UPDATE SET google_email=excluded.google_email, enc_refresh=excluded.enc_refresh, scope=excluded.scope, updated_at=excluded.updated_at"
    )
      .bind(recapUserEmail(env), googleEmail, enc, tok.scope || "", now)
      .run();
  } catch (e) {
    return page("Recap — storage error", "<h2>Couldn't save the token</h2><p>" + escapeHtml(String(e && e.message ? e.message : e)) + "</p><p>Make sure the <code>recap_auth</code> table exists (run schema.sql).</p>");
  }

  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", "recap_oauth_state=; Path=/api/recap; Max-Age=0");
  return new Response(
    "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
      "<title>Recap connected</title>" +
      "<div style=\"font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:12vh auto;padding:0 20px;color:#111\">" +
      "<h2>✓ Weekly recap connected</h2>" +
      "<p>Connected as <b>" + escapeHtml(googleEmail || "your Google account") + "</b>. Hal will email your prospect recap to <b>john@latimer.ai</b> every Monday at 7am (America/New_York), even with the browser closed.</p>" +
      "<p><a href='/#recap'>← Back to the app</a></p>" +
      "</div>",
    { status: 200, headers }
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
