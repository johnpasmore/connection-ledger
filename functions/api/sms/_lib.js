// Shared helpers for SMS notes & reminders (Twilio).
// Files beginning with "_" are not served as routes by Cloudflare Pages.
// The cron Worker (worker/recap) imports this file too, so the parsing, storage
// and Twilio send logic lives in exactly one place.
//
// Flow:
//   • JP texts the Twilio number  → Twilio POSTs /api/sms/inbound
//   • inbound.js verifies the Twilio signature, maps the sender's number to a
//     user (SMS_USERS), and stores the text in sms_notes as a 'note' or, when he
//     asks to be reminded, a 'reminder' with a remind_at time
//   • the Worker's every-minute cron sends due reminders back by SMS
//
// Env (Pages project AND the Worker, where noted):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN      (both)  — auth token is a Secret
//   TWILIO_FROM_NUMBER  or TWILIO_MESSAGING_SERVICE_SID   (Worker; Pages for replies)
//   SMS_USERS   "+15551234567=john@latimer.ai,+1555…=…"  (Pages) — allowlist
//   SMS_TZ      IANA zone for "tomorrow 9am" (default America/New_York)
//   SMS_WEBHOOK_URL  optional exact public URL Twilio calls (signature check)
//   ANTHROPIC_API_KEY  optional — lets Hal read free-form times ("next Tues after lunch")

export const DEFAULT_TZ = "America/New_York";

// ---- schema -----------------------------------------------------------------
// Created on first use; remembered per D1 binding so later calls are free.
const schemaReady = new WeakSet();
export async function ensureSmsSchema(env) {
  if (schemaReady.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS sms_notes (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT NOT NULL, phone TEXT NOT NULL, " +
        "body TEXT NOT NULL, kind TEXT NOT NULL, remind_text TEXT, remind_at TEXT, " +
        "status TEXT NOT NULL, attempts INTEGER DEFAULT 0, detail TEXT, created_at TEXT NOT NULL, sent_at TEXT)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_sms_due ON sms_notes(status, remind_at)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_sms_user ON sms_notes(user_email, created_at DESC)"),
  ]);
  schemaReady.add(env.DB);
}

// ---- who may text in ----------------------------------------------------------
// Normalise to E.164-ish: keep digits and a leading +; assume US for 10 digits.
export function normalizePhone(p) {
  const s = String(p || "").trim();
  const digits = s.replace(/\D/g, "");
  if (!digits) return "";
  if (s.startsWith("+")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits[0] === "1") return "+" + digits;
  return "+" + digits;
}

// SMS_USERS = "+15551234567=john@latimer.ai, +15557654321=barika@latimer.ai"
export function parseUsers(raw) {
  const map = {};
  String(raw || "")
    .split(/[,\n;]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const i = pair.indexOf("=");
      if (i < 0) return;
      const phone = normalizePhone(pair.slice(0, i));
      const email = pair.slice(i + 1).trim().toLowerCase();
      if (phone && email) map[phone] = email;
    });
  return map;
}

export function userForPhone(env, phone) {
  return parseUsers(env && env.SMS_USERS)[normalizePhone(phone)] || null;
}

// ---- Twilio signature (X-Twilio-Signature) -------------------------------------
// base64(HMAC-SHA1(authToken, url + each POST param name+value, sorted by name)).
export async function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  let bin = "";
  for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]);
  return btoa(bin);
}

export async function validTwilioRequest(authToken, url, params, header) {
  if (!authToken || !header) return false;
  const expected = await twilioSignature(authToken, url, params);
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

// ---- time zones -----------------------------------------------------------------
// Wall-clock parts of `date` in `tz`.
export function zonedParts(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  });
  const p = {};
  fmt.formatToParts(date).forEach((x) => { p[x.type] = x.value; });
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second, weekday: wd[p.weekday] };
}

// UTC Date for a wall-clock time in `tz` (DST-safe: corrects the offset twice).
export function zonedToUtc(y, m, d, h, min, tz) {
  const wall = Date.UTC(y, m - 1, d, h, min);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), tz);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    guess += wall - seen;
  }
  return new Date(guess);
}

export function formatLocal(date, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(date);
}

// ---- understanding a text ----------------------------------------------------------
// Returns one of:
//   { kind: 'command', command: 'list' | 'help' }
//   { kind: 'command', command: 'cancel', id }
//   { kind: 'note', text }
//   { kind: 'reminder', text, at: Date }
//   { kind: 'reminder', text, at: null }   ← asked for a reminder but no usable time
export function classify(body) {
  const t = String(body || "").trim();
  const low = t.toLowerCase();
  if (/^(list|notes|reminders|\?)$/.test(low)) return { kind: "command", command: "list" };
  if (/^(help|commands)$/.test(low)) return { kind: "command", command: "help" };
  const c = low.match(/^(cancel|delete|stop reminder)\s*#?(\d+)$/);
  if (c) return { kind: "command", command: "cancel", id: +c[2] };
  if (/\bremind(er)?\b|\bremember to\b.*\b(at|on|in|tomorrow|tonight)\b/.test(low)) return { kind: "reminder" };
  return { kind: "note", text: t };
}

// Rule-based time reader — works with no model key, and is the fallback if the
// model call fails. Understands the common shapes:
//   "in 20 min", "in 2 hours", "in 3 days", "tomorrow", "tomorrow at 9am",
//   "tonight", "at 3pm", "at 15:30", "monday 10am", "on friday", "11/14 at 2pm".
// Unqualified mornings default to 9:00; "tonight" to 20:00.
export function parseWhen(text, now, tz) {
  const low = " " + String(text || "").toLowerCase().replace(/\s+/g, " ") + " ";
  const p = zonedParts(now, tz);

  const rel = low.match(/\bin (an?|\d+(?:\.\d+)?) ?(min(?:ute)?s?|hrs?|hours?|days?|weeks?)\b/);
  if (rel) {
    const n = /^an?$/.test(rel[1]) ? 1 : parseFloat(rel[1]);
    const u = rel[2];
    const ms = u.startsWith("min") ? 60e3 : u.startsWith("h") ? 3600e3 : u.startsWith("d") ? 86400e3 : 7 * 86400e3;
    return new Date(now.getTime() + n * ms);
  }

  let hour = null, minute = 0;
  const clock = low.match(/\b(?:at |@ ?)?(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m\.|p\.m\.)(?=[\s.,!?])/) ||
                low.match(/\b(?:at|@) ?(\d{1,2}):(\d{2})\b/) ||
                low.match(/\bat (\d{1,2})\b(?!\/)/);
  if (clock) {
    hour = parseInt(clock[1], 10);
    minute = clock[2] ? parseInt(clock[2], 10) : 0;
    const ap = clock[3] ? clock[3][0] : "";
    if (ap === "p" && hour < 12) hour += 12;
    if (ap === "a" && hour === 12) hour = 0;
    // "at 3" with no am/pm: read 1–7 as afternoon (nobody means 3am).
    if (!ap && !clock[2] && hour >= 1 && hour <= 7) hour += 12;
    if (hour > 23 || minute > 59) hour = null;
  }
  if (/\bnoon\b/.test(low)) { hour = 12; minute = 0; }
  if (/\btonight\b/.test(low) && hour === null) { hour = 20; minute = 0; }
  if (/\bthis (evening)\b/.test(low) && hour === null) { hour = 18; minute = 0; }
  if (/\bthis afternoon\b/.test(low) && hour === null) { hour = 14; minute = 0; }

  // Which day?
  let dayOffset = null;
  let ymd = null;
  if (/\btoday\b|\btonight\b|\bthis (morning|afternoon|evening)\b/.test(low)) dayOffset = 0;
  if (/\btomorrow\b|\btmrw\b|\btmr\b/.test(low)) dayOffset = 1;
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dm = low.match(/\b(?:on |next |this )?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?\b/);
  if (dm && dayOffset === null) {
    const idx = days.findIndex((d) => d.startsWith(dm[1].slice(0, 3)));
    let diff = (idx - p.weekday + 7) % 7;
    if (diff === 0) diff = 7; // "monday" said on a Monday means next Monday
    dayOffset = diff;
  }
  const md = low.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (md) {
    let yy = md[3] ? parseInt(md[3], 10) : p.y;
    if (yy < 100) yy += 2000;
    ymd = { y: yy, m: parseInt(md[1], 10), d: parseInt(md[2], 10) };
  }

  if (hour === null && dayOffset === null && !ymd) return null;
  if (hour === null) { hour = 9; minute = 0; }

  let base;
  if (ymd) base = ymd;
  else {
    const anchor = new Date(Date.UTC(p.y, p.m - 1, p.d + (dayOffset || 0)));
    base = { y: anchor.getUTCFullYear(), m: anchor.getUTCMonth() + 1, d: anchor.getUTCDate() };
  }
  let at = zonedToUtc(base.y, base.m, base.d, hour, minute, tz);
  // A bare time that has already passed today means tomorrow ("at 9am" said at 10am).
  if (dayOffset === null && !ymd && at <= now) at = new Date(at.getTime() + 86400e3);
  // A bare date already past this year means next year.
  if (ymd && !md[3] && at <= now) at = zonedToUtc(base.y + 1, base.m, base.d, hour, minute, tz);
  return at;
}

// What to remind about: strip the "remind me … to" scaffolding and time words.
export function reminderText(body) {
  let t = String(body || "").trim();
  t = t.replace(/^(please\s+)?(set\s+a\s+)?remind(er)?(\s+me)?(\s*:)?\s*/i, "");
  const to = t.match(/\b(?:to|about|that)\s+(.+)$/i);
  if (to) t = to[1];
  t = t
    .replace(/\b(in (an?|\d+(\.\d+)?) ?(min(ute)?s?|hrs?|hours?|days?|weeks?))\b/gi, "")
    .replace(/\b(tomorrow|tmrw|tonight|today|this (morning|afternoon|evening))\b/gi, "")
    .replace(/\b(at|@) ?\d{1,2}(:\d{2})? ?(am|pm)?\b/gi, "")
    .replace(/\b\d{1,2}(:\d{2})? ?(am|pm)\b/gi, "")
    .replace(/\b(on |next )?(sun|mon|tues?|wed(nes)?|thu(rs?)?|fri|sat(ur)?)(day)?\b/gi, "")
    .replace(/\b(on )?\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "")
    .trim();
  return t || String(body || "").trim();
}

// Optional: let the model read a free-form reminder. Returns {text, at} or null.
// Bounded to a few seconds so Twilio (15s webhook timeout) always gets an answer.
export async function interpretWithModel(env, body, now, tz) {
  if (!env || !env.ANTHROPIC_API_KEY) return null;
  const p = zonedParts(now, tz);
  const pad = (n) => String(n).padStart(2, "0");
  const localNow = p.y + "-" + pad(p.m) + "-" + pad(p.d) + "T" + pad(p.h) + ":" + pad(p.min) +
    " (" + ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][p.weekday] + ")";
  const sys =
    "You turn a text message into a reminder. Current local time is " + localNow + " in " + tz + ". " +
    'Reply with ONLY a JSON object: {"text": "<what to remind about, short, imperative>", "local": "YYYY-MM-DDTHH:MM" or null}. ' +
    "local is the reminder time in that zone. Mornings without a time mean 09:00. If no time or day is given, local is null.";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: env.SMS_MODEL || "claude-haiku-5-5",
        max_tokens: 200,
        system: sys,
        messages: [{ role: "user", content: String(body) }],
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const raw = ((j.content || []).find((c) => c.type === "text") || {}).text || "";
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    let at = null;
    const lm = typeof o.local === "string" && o.local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (lm) at = zonedToUtc(+lm[1], +lm[2], +lm[3], +lm[4], +lm[5], tz);
    if (at && at <= now) at = null;
    return { text: String(o.text || "").trim() || reminderText(body), at };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- replies ------------------------------------------------------------------
export function twiml(message) {
  const x = message
    ? "<Response><Message>" + xmlEscape(message) + "</Message></Response>"
    : "<Response></Response>";
  return new Response('<?xml version="1.0" encoding="UTF-8"?>' + x, {
    headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function xmlEscape(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
}

export const HELP_TEXT =
  "Text anything to save it as a note. " +
  "\"Remind me tomorrow 9am to call Scott\" sets a reminder I'll text back. " +
  "\"list\" shows what's pending, \"cancel 12\" cancels reminder #12.";

// ---- outbound SMS (Twilio REST) ------------------------------------------------
export async function sendSms(env, to, body) {
  const sid = env.TWILIO_ACCOUNT_SID, token = env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set");
  const form = new URLSearchParams({ To: to, Body: body });
  if (env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", env.TWILIO_MESSAGING_SERVICE_SID);
  else if (env.TWILIO_FROM_NUMBER) form.set("From", env.TWILIO_FROM_NUMBER);
  else throw new Error("set TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID");
  const r = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + encodeURIComponent(sid) + "/Messages.json", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(sid + ":" + token),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("twilio " + r.status + " " + (j.message || JSON.stringify(j)).slice(0, 200));
  return j;
}

// ---- due reminders (called by the Worker's every-minute cron) -------------------
// Claims each due row (pending → sending) before sending, so two overlapping cron
// runs can never text the same reminder twice. A failed send goes back to pending
// and is retried on the next run, up to 3 attempts.
export async function sendDueReminders(env, now = new Date()) {
  await ensureSmsSchema(env);
  const due = await env.DB
    .prepare("SELECT id, phone, remind_text, body, attempts FROM sms_notes WHERE status = 'pending' AND kind = 'reminder' AND remind_at <= ? ORDER BY remind_at LIMIT 25")
    .bind(now.toISOString())
    .all();
  const results = [];
  for (const row of due.results || []) {
    const claim = await env.DB
      .prepare("UPDATE sms_notes SET status = 'sending' WHERE id = ? AND status = 'pending'")
      .bind(row.id)
      .run();
    if (!claim.meta || !claim.meta.changes) continue;
    try {
      await sendSms(env, row.phone, "⏰ Reminder: " + (row.remind_text || row.body));
      await env.DB
        .prepare("UPDATE sms_notes SET status = 'sent', sent_at = ?, attempts = attempts + 1, detail = NULL WHERE id = ?")
        .bind(new Date().toISOString(), row.id)
        .run();
      results.push({ id: row.id, sent: true });
    } catch (e) {
      const msg = String(e && e.message ? e.message : e).slice(0, 300);
      const next = (row.attempts || 0) + 1 >= 3 ? "error" : "pending";
      await env.DB
        .prepare("UPDATE sms_notes SET status = ?, attempts = attempts + 1, detail = ? WHERE id = ?")
        .bind(next, msg, row.id)
        .run();
      results.push({ id: row.id, sent: false, error: msg });
    }
  }
  return results;
}
