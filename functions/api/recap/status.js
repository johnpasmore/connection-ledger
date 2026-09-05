// GET /api/recap/status
// Tells the Recap tab whether the automatic weekly email is wired up: is the
// backend configured, is Google connected (offline), and when did it last send.

import { json, missingConfig, recapUserEmail } from "./_lib.js";

export async function onRequestGet(context) {
  const { env } = context;
  const need = missingConfig(env);
  const configured = need.length === 0;

  let connected = false, googleEmail = "", updatedAt = null, hasSend = false, lastRun = null;
  if (env.DB) {
    try {
      const row = await env.DB
        .prepare("SELECT google_email, scope, updated_at FROM recap_auth WHERE user_email = ?")
        .bind(recapUserEmail(env))
        .first();
      if (row) {
        connected = true;
        googleEmail = row.google_email || "";
        updatedAt = row.updated_at || null;
        hasSend = /gmail\.send/.test(row.scope || "");
      }
    } catch (e) {}
    try {
      lastRun = await env.DB
        .prepare("SELECT week_key, status, detail, sent_at FROM recap_log ORDER BY sent_at DESC LIMIT 1")
        .first();
    } catch (e) {}
  }

  return json({
    configured,
    missing: need,
    connected,
    googleEmail,
    hasSend,
    updatedAt,
    lastRun,
    recipient: "john@latimer.ai",
    schedule: "Mondays 7:00am America/New_York",
  });
}
