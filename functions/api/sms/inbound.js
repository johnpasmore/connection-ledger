// POST /api/sms/inbound — Twilio "A message comes in" webhook.
//
// This route must BYPASS Cloudflare Access (Twilio can't sign in), so it guards
// itself instead: every request must carry a valid X-Twilio-Signature made with
// the Twilio auth token. Then, in order:
//   • starts with an app's code     → forwarded, re-signed, to that app's webhook
//   • starts with a person's code   → saved as that person's note / reminder
//   • sent from a registered phone  → saved as that person's note / reminder
//   • anything else                 → the "no code" webhook if set, else ignored
// Replies go back inline as TwiML, so confirming a note costs no extra API call.

import {
  ensureSmsSchema, normalizePhone, validTwilioRequest, classify, parseWhen, reminderText,
  interpretWithModel, formatLocal, twiml, helpText, BRAND, DEFAULT_TZ, twilioConfig, loadRoutes,
  splitCode, forwardToApp,
} from "./_lib.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return new Response("D1 binding 'DB' not found", { status: 500 });

  const form = await request.formData();
  const params = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  await ensureSmsSchema(env);
  const cfg = await twilioConfig(env);
  if (!cfg.authToken) return new Response("Twilio auth token not configured", { status: 503 });

  const url = env.SMS_WEBHOOK_URL || request.url;
  const ok = await validTwilioRequest(cfg.authToken, url, params, request.headers.get("X-Twilio-Signature"));
  if (!ok) return new Response("Invalid signature", { status: 403 });

  const phone = normalizePhone(params.From);
  const { byCode, byPhone } = await loadRoutes(env);
  const { code, rest } = splitCode(params.Body, new Set(byCode.keys()));
  const coded = code ? byCode.get(code) : null;

  if (coded && coded.forward_url) return forwardToApp(cfg, coded.forward_url, { ...params, Body: rest });

  // Whose text: a personal code wins (so it works from any phone), else the phone.
  const person = coded || byPhone.get(phone) || null;
  if (!person) {
    if (cfg.fallbackUrl) return forwardToApp(cfg, cfg.fallbackUrl, params);
    return twiml("");
  }
  const text = coded ? rest : String(params.Body || "").trim();
  if (!text) return twiml(helpText(coded ? code : "", env));

  try {
    return twiml(await handle(env, person.user_email, phone, text, new Date(), coded ? code : ""));
  } catch (e) {
    return twiml(BRAND + "Sorry, couldn't save that (" + String(e && e.message ? e.message : e).slice(0, 80) + "). Try again?");
  }
}

// Exported for tests: decide what to do with one text and return the reply.
export async function handle(env, user, phone, body, now, code = "") {
  const tz = env.SMS_TZ || DEFAULT_TZ;
  const c = classify(body);

  if (c.kind === "command" && c.command === "help") return helpText(code, env);
  if (c.kind === "command" && c.command === "list") return listReply(env, user, tz);
  if (c.kind === "command" && c.command === "cancel") {
    const r = await env.DB
      .prepare("UPDATE sms_notes SET status = 'cancelled' WHERE id = ? AND user_email = ? AND kind = 'reminder' AND status = 'pending'")
      .bind(c.id, user)
      .run();
    return BRAND + (r.meta && r.meta.changes ? "Cancelled reminder #" + c.id + "." : "No pending reminder #" + c.id + ".");
  }

  if (c.kind === "reminder") {
    // The model reads free-form times best; the rule parser is the safety net.
    let text = reminderText(body);
    let at = parseWhen(body, now, tz);
    const m = await interpretWithModel(env, body, now, tz);
    if (m) { text = m.text || text; if (m.at) at = m.at; }

    if (!at || at <= now) {
      const id = await insert(env, { user, phone, body, kind: "note", now });
      return BRAND + "Saved as note #" + id + ", but I couldn't tell when to remind you. " +
        "Try e.g. \"" + (code ? code + " " : "") + "remind me tomorrow 9am to " + text + "\".";
    }
    const id = await insert(env, { user, phone, body, kind: "reminder", text, at, now });
    return BRAND + "Got it, I'll text you " + formatLocal(at, tz) + ": " + text + " (#" + id + "). " +
      "Reply \"" + (code ? code + " " : "") + "cancel " + id + "\" to stop it, STOP to opt out.";
  }

  const id = await insert(env, { user, phone, body, kind: "note", now });
  return BRAND + "Saved note #" + id + ". Reply STOP to opt out.";
}

async function insert(env, { user, phone, body, kind, text, at, now }) {
  const r = await env.DB
    .prepare(
      "INSERT INTO sms_notes (user_email, phone, body, kind, remind_text, remind_at, status, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(user, phone, body, kind, text || null, at ? at.toISOString() : null, kind === "reminder" ? "pending" : "saved", now.toISOString())
    .run();
  return r.meta && r.meta.last_row_id;
}

async function listReply(env, user, tz) {
  const pending = await env.DB
    .prepare("SELECT id, remind_text, remind_at FROM sms_notes WHERE user_email = ? AND kind = 'reminder' AND status = 'pending' ORDER BY remind_at LIMIT 5")
    .bind(user)
    .all();
  const notes = await env.DB
    .prepare("SELECT id, body FROM sms_notes WHERE user_email = ? AND kind = 'note' ORDER BY created_at DESC LIMIT 3")
    .bind(user)
    .all();
  const pr = pending.results || [], nr = notes.results || [];
  let out = pr.length
    ? "Your reminders: " + pr.map((r) => "#" + r.id + " " + formatLocal(new Date(r.remind_at), tz) + " - " + r.remind_text).join("; ") + "."
    : "No pending reminders.";
  if (nr.length) {
    out += " Latest notes: " + nr.map((n) => "#" + n.id + " " + (n.body.length > 60 ? n.body.slice(0, 57) + "…" : n.body)).join("; ");
  }
  return BRAND + out;
}
