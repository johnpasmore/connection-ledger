// POST /api/sms/inbound — Twilio "A message comes in" webhook.
//
// This route must BYPASS Cloudflare Access (Twilio can't sign in), so it guards
// itself instead: every request must carry a valid X-Twilio-Signature made with
// TWILIO_AUTH_TOKEN, and the sender's number must be listed in SMS_USERS.
// Anything else gets an empty TwiML response — no reply, nothing stored.
//
// Replies go back inline as TwiML, so confirming a note costs no extra API call.

import {
  ensureSmsSchema, userForPhone, normalizePhone, validTwilioRequest, classify, parseWhen,
  reminderText, interpretWithModel, formatLocal, twiml, HELP_TEXT, DEFAULT_TZ,
} from "./_lib.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return new Response("D1 binding 'DB' not found", { status: 500 });

  const form = await request.formData();
  const params = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const url = env.SMS_WEBHOOK_URL || request.url;
  const ok = await validTwilioRequest(env.TWILIO_AUTH_TOKEN, url, params, request.headers.get("X-Twilio-Signature"));
  if (!ok) return new Response("Invalid signature", { status: 403 });

  const phone = normalizePhone(params.From);
  const user = userForPhone(env, phone);
  if (!user) return twiml(""); // unknown sender: say nothing

  const body = (params.Body || "").trim();
  if (!body) return twiml("Empty text — nothing saved. " + HELP_TEXT);

  try {
    await ensureSmsSchema(env);
    const reply = await handle(env, user, phone, body, new Date());
    return twiml(reply);
  } catch (e) {
    return twiml("Sorry — couldn't save that (" + String(e && e.message ? e.message : e).slice(0, 80) + "). Try again?");
  }
}

// Exported for tests: decide what to do with one text and return the reply.
export async function handle(env, user, phone, body, now) {
  const tz = env.SMS_TZ || DEFAULT_TZ;
  const c = classify(body);

  if (c.kind === "command" && c.command === "help") return HELP_TEXT;
  if (c.kind === "command" && c.command === "list") return listReply(env, user, tz);
  if (c.kind === "command" && c.command === "cancel") {
    const r = await env.DB
      .prepare("UPDATE sms_notes SET status = 'cancelled' WHERE id = ? AND user_email = ? AND kind = 'reminder' AND status = 'pending'")
      .bind(c.id, user)
      .run();
    return r.meta && r.meta.changes ? "Cancelled reminder #" + c.id + "." : "No pending reminder #" + c.id + ".";
  }

  if (c.kind === "reminder") {
    // The model reads free-form times best; the rule parser is the safety net.
    let text = reminderText(body);
    let at = parseWhen(body, now, tz);
    const m = await interpretWithModel(env, body, now, tz);
    if (m) { text = m.text || text; if (m.at) at = m.at; }

    if (!at || at <= now) {
      const id = await insert(env, { user, phone, body, kind: "note", now });
      return "Saved as note #" + id + ", but I couldn't tell when to remind you. " +
        "Try e.g. \"remind me tomorrow 9am to " + text + "\".";
    }
    const id = await insert(env, { user, phone, body, kind: "reminder", text, at, now });
    return "⏰ Got it — I'll text you " + formatLocal(at, tz) + ": " + text + " (#" + id + ", reply \"cancel " + id + "\" to stop)";
  }

  const id = await insert(env, { user, phone, body, kind: "note", now });
  return "📝 Saved note #" + id + ".";
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
  const lines = [];
  const pr = pending.results || [], nr = notes.results || [];
  if (pr.length) {
    lines.push("Reminders:");
    pr.forEach((r) => lines.push("#" + r.id + " " + formatLocal(new Date(r.remind_at), tz) + " — " + r.remind_text));
  } else lines.push("No pending reminders.");
  if (nr.length) {
    lines.push("Latest notes:");
    nr.forEach((n) => lines.push("#" + n.id + " " + (n.body.length > 60 ? n.body.slice(0, 57) + "…" : n.body)));
  }
  return lines.join("\n");
}
