// GET /api/recap/connect
// Starts Google's offline-consent flow. JP visits this once (from the Recap tab).
// It redirects to Google; Google sends the user back to /api/recap/callback with a
// code we exchange for a long-lived refresh token (stored encrypted in D1).

import { GOOGLE_SCOPES, redirectUri, missingConfig, recapUserEmail } from "./_lib.js";

export async function onRequestGet(context) {
  const { request, env } = context;

  const need = missingConfig(env);
  if (need.length) {
    return new Response(
      "Weekly-recap backend not configured yet. Missing: " + need.join(", ") +
        ".\nAdd these in Cloudflare Pages → Settings → Variables & Secrets, then try again.",
      { status: 500, headers: { "Content-Type": "text/plain" } }
    );
  }

  // Random state for CSRF; echoed back and checked in the callback via cookie.
  const state = crypto.randomUUID();

  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(request),
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent", // force a refresh_token even on re-consent
    state,
    login_hint: recapUserEmail(env),
  });

  const headers = new Headers({ Location: "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString() });
  headers.append(
    "Set-Cookie",
    "recap_oauth_state=" + state + "; Path=/api/recap; HttpOnly; Secure; SameSite=Lax; Max-Age=600"
  );
  return new Response(null, { status: 302, headers });
}
