// /api/sms/settings — the "Texting (Twilio)" card on the Settings tab.
// Access-gated like the rest of /api (every signed-in @latimer.ai user may edit).
//
// GET → {
//   twilio: { accountSid, hasAuthToken, fromNumber, fallbackUrl, fromEnv, tokenError, canStoreToken },
//   me:     { code, phone } | null,        ← the signed-in user's own code
//   apps:   [{ code, label, forward_url }], ← other apps sharing the number
//   taken:  ["jp7", …]                     ← every code in use (so the UI can warn)
// }
// The auth token is write-only: it is never returned, only whether one is saved.
//
// PUT { twilio?: {accountSid, authToken?, fromNumber, fallbackUrl},
//       me?: {code, phone},
//       apps?: [{code, label, forward_url}] }   ← replaces the whole app list

import { ensureSmsSchema, twilioConfig, saveTwilioSettings, normCode, codeProblem, normalizePhone } from "./_lib.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) return json({ error: "D1 binding 'DB' not found" }, 500);
  const email = (request.headers.get("Cf-Access-Authenticated-User-Email") || "default").toLowerCase();

  try {
    await ensureSmsSchema(env);
    if (request.method === "GET") return json(await read(env, email));
    if (request.method === "PUT") {
      const b = await request.json().catch(() => ({}));
      const problem = await write(env, email, b);
      if (problem) return json({ error: problem }, 400);
      return json(await read(env, email));
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) }, 500);
  }
}

async function read(env, email) {
  const cfg = await twilioConfig(env);
  const rows = ((await env.DB.prepare("SELECT code, user_email, phone, forward_url, label FROM sms_routes ORDER BY code").all()).results) || [];
  const me = rows.find((r) => r.user_email === email);
  return {
    twilio: {
      accountSid: cfg.accountSid,
      hasAuthToken: !!cfg.authToken,
      fromNumber: cfg.fromNumber,
      fallbackUrl: cfg.fallbackUrl,
      fromEnv: cfg.fromEnv,
      tokenError: cfg.tokenError,
      canStoreToken: !!env.RECAP_ENC_KEY,
    },
    me: me ? { code: me.code, phone: me.phone || "" } : null,
    apps: rows.filter((r) => r.forward_url).map((r) => ({ code: r.code, label: r.label || "", forward_url: r.forward_url })),
    taken: rows.map((r) => r.code),
  };
}

// Returns an error string for bad input, or "" when saved.
async function write(env, email, b) {
  const now = new Date().toISOString();
  const rows = ((await env.DB.prepare("SELECT code, user_email, forward_url FROM sms_routes").all()).results) || [];

  // Validate everything before writing anything.
  let me = null;
  if (b.me) {
    const code = normCode(b.me.code);
    const phone = b.me.phone ? normalizePhone(b.me.phone) : "";
    if (code) {
      const p = codeProblem(code);
      if (p) return p;
      const owner = rows.find((r) => r.code === code);
      if (owner && owner.user_email !== email) return "\"" + code + "\" is already in use — pick another code.";
    }
    if (phone && !/^\+\d{8,15}$/.test(phone)) return "That phone number doesn't look right.";
    me = { code, phone };
  }

  let apps = null;
  if (Array.isArray(b.apps)) {
    apps = [];
    const seen = new Set();
    for (const a of b.apps) {
      const code = normCode(a.code);
      const url = String(a.forward_url || "").trim();
      if (!code && !url) continue;
      const p = codeProblem(code);
      if (p) return p;
      if (!/^https:\/\//.test(url)) return "The webhook for \"" + code + "\" must be an https:// URL.";
      if (seen.has(code)) return "\"" + code + "\" is listed twice.";
      const owner = rows.find((r) => r.code === code && r.user_email);
      if (owner) return "\"" + code + "\" is already someone's personal code.";
      if (me && me.code === code) return "\"" + code + "\" can't be both your code and an app's.";
      seen.add(code);
      apps.push({ code, url, label: String(a.label || "").slice(0, 60) });
    }
  }

  let twilio = null;
  if (b.twilio) {
    const t = b.twilio;
    const sid = t.accountSid !== undefined ? String(t.accountSid).trim() : undefined;
    if (sid && !/^AC[0-9a-fA-F]{32}$/.test(sid)) return "The Account SID starts with AC and is 34 characters.";
    const from = t.fromNumber !== undefined ? (t.fromNumber ? normalizePhone(t.fromNumber) : "") : undefined;
    if (from && !/^\+\d{8,15}$/.test(from)) return "That Twilio number doesn't look right.";
    const fb = t.fallbackUrl !== undefined ? String(t.fallbackUrl).trim() : undefined;
    if (fb && !/^https:\/\//.test(fb)) return "The no-code webhook must be an https:// URL.";
    const token = t.authToken ? String(t.authToken).trim() : "";
    if (token && !/^[0-9a-fA-F]{32}$/.test(token)) return "The Auth Token is 32 hex characters.";
    if (token && !env.RECAP_ENC_KEY) return "Set the RECAP_ENC_KEY secret on the Pages project first — the token is stored encrypted with it.";
    twilio = { accountSid: sid, authToken: token, fromNumber: from, fallbackUrl: fb };
  }

  if (twilio) await saveTwilioSettings(env, twilio, email);
  if (me) {
    await env.DB.prepare("DELETE FROM sms_routes WHERE user_email = ?").bind(email).run();
    if (me.code) {
      await env.DB
        .prepare("INSERT INTO sms_routes (code, user_email, phone, updated_at) VALUES (?, ?, ?, ?)")
        .bind(me.code, email, me.phone || null, now)
        .run();
    }
  }
  if (apps) {
    await env.DB.prepare("DELETE FROM sms_routes WHERE forward_url IS NOT NULL AND user_email IS NULL").run();
    for (const a of apps) {
      await env.DB
        .prepare("INSERT INTO sms_routes (code, forward_url, label, updated_at) VALUES (?, ?, ?, ?)")
        .bind(a.code, a.url, a.label, now)
        .run();
    }
  }
  return "";
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
