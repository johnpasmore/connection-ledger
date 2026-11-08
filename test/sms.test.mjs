// Tests for SMS notes & reminders. Run: node --test test/
// D1 is stood in for by node:sqlite (same SQLite dialect), wrapped in the small
// slice of the D1 API the code uses: prepare().bind().run()/all()/first(), batch().

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";

import {
  normalizePhone, parseUsers, twilioSignature, validTwilioRequest, zonedToUtc, zonedParts,
  classify, parseWhen, reminderText, sendDueReminders,
} from "../functions/api/sms/_lib.js";
import { handle, onRequestPost } from "../functions/api/sms/inbound.js";

const TZ = "America/New_York";

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() {
      const r = db.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async first() { return db.prepare(sql).get(...args) || null; },
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    async batch(list) { for (const s of list) await s.run(); },
  };
}

// 10:00am ET on Wednesday 11 Nov 2026 (EST, UTC-5).
const NOW = new Date("2026-11-11T15:00:00Z");
const et = (d) => { const p = zonedParts(d, TZ); return [p.y, p.m, p.d, p.h, p.min]; };

test("normalizePhone and parseUsers", () => {
  assert.equal(normalizePhone("(555) 123-4567"), "+15551234567");
  assert.equal(normalizePhone("+1 555 123 4567"), "+15551234567");
  const m = parseUsers("+15551234567=John@Latimer.ai, 555-765-4321 = barika@latimer.ai");
  assert.deepEqual(m, { "+15551234567": "john@latimer.ai", "+15557654321": "barika@latimer.ai" });
});

test("Twilio signature matches a reference HMAC-SHA1 of url + sorted params", async () => {
  // Spec: https://www.twilio.com/docs/usage/security#validating-requests
  const url = "https://example.com/myapp.php?foo=1&bar=2";
  const params = { To: "+18005551212", CallSid: "CA1234567890ABCDE", Digits: "1234", From: "+12349013030", Caller: "+12349013030" };
  const data = url + "CallSidCA1234567890ABCDE" + "Caller+12349013030" + "Digits1234" + "From+12349013030" + "To+18005551212";
  const expected = createHmac("sha1", "12345").update(data).digest("base64");
  assert.equal(await twilioSignature("12345", url, params), expected);
  assert.equal(await validTwilioRequest("12345", url, params, expected), true);
  assert.equal(await validTwilioRequest("wrong", url, params, expected), false);
  assert.equal(await validTwilioRequest("12345", url, params, "bad"), false);
  assert.equal(await validTwilioRequest("12345", url, params, null), false);
});

test("zonedToUtc handles EST and EDT", () => {
  assert.equal(zonedToUtc(2026, 11, 12, 9, 0, TZ).toISOString(), "2026-11-12T14:00:00.000Z");
  assert.equal(zonedToUtc(2026, 7, 1, 9, 0, TZ).toISOString(), "2026-07-01T13:00:00.000Z");
});

test("classify", () => {
  assert.equal(classify("list").command, "list");
  assert.equal(classify("cancel 12").id, 12);
  assert.equal(classify("Remind me tomorrow at 9am to call Scott").kind, "reminder");
  assert.equal(classify("reminder: send the deck friday").kind, "reminder");
  assert.equal(classify("Howard U wants a pilot in Jan").kind, "note");
});

test("parseWhen reads common shapes in ET", () => {
  assert.equal(parseWhen("remind me in 20 minutes", NOW, TZ).toISOString(), "2026-11-11T15:20:00.000Z");
  assert.deepEqual(et(parseWhen("remind me in 2 hours", NOW, TZ)), [2026, 11, 11, 12, 0]);
  assert.deepEqual(et(parseWhen("remind me tomorrow at 9am to call Scott", NOW, TZ)), [2026, 11, 12, 9, 0]);
  assert.deepEqual(et(parseWhen("remind me tomorrow to call Scott", NOW, TZ)), [2026, 11, 12, 9, 0]);
  assert.deepEqual(et(parseWhen("remind me at 3pm", NOW, TZ)), [2026, 11, 11, 15, 0]);
  assert.deepEqual(et(parseWhen("remind me at 3", NOW, TZ)), [2026, 11, 11, 15, 0]);
  assert.deepEqual(et(parseWhen("remind me at 9am", NOW, TZ)), [2026, 11, 12, 9, 0], "passed today → tomorrow");
  assert.deepEqual(et(parseWhen("remind me tonight", NOW, TZ)), [2026, 11, 11, 20, 0]);
  assert.deepEqual(et(parseWhen("remind me friday 2:30pm", NOW, TZ)), [2026, 11, 13, 14, 30]);
  assert.deepEqual(et(parseWhen("remind me wednesday", NOW, TZ)), [2026, 11, 18, 9, 0], "same weekday → next week");
  assert.deepEqual(et(parseWhen("remind me 12/1 at 10am", NOW, TZ)), [2026, 12, 1, 10, 0]);
  assert.equal(parseWhen("remind me to call Scott", NOW, TZ), null);
});

test("reminderText strips the scaffolding", () => {
  assert.equal(reminderText("Remind me tomorrow at 9am to call Scott"), "call Scott");
  assert.equal(reminderText("remind me in 2 hours to send Barika the deck"), "send Barika the deck");
  assert.equal(reminderText("Reminder: follow up with Spelman friday"), "follow up with Spelman");
});

test("handle(): notes, reminders, list, cancel", async () => {
  const env = { DB: fakeD1() };
  const { ensureSmsSchema } = await import("../functions/api/sms/_lib.js");
  await ensureSmsSchema(env);
  const u = "john@latimer.ai", ph = "+15551234567";

  assert.match(await handle(env, u, ph, "Howard wants a pilot in Jan", NOW), /Saved note #1/);
  const r = await handle(env, u, ph, "remind me tomorrow at 9am to call Scott", NOW);
  assert.match(r, /I'll text you Thu, Nov 12, 9:00 AM: call Scott \(#2/);
  assert.match(await handle(env, u, ph, "remind me to call Scott", NOW), /couldn't tell when/);

  const list = await handle(env, u, ph, "list", NOW);
  assert.match(list, /#2 .* — call Scott/);
  assert.match(list, /#1 Howard wants a pilot/);

  assert.match(await handle(env, "other@latimer.ai", ph, "cancel 2", NOW), /No pending reminder #2/);
  assert.match(await handle(env, u, ph, "cancel 2", NOW), /Cancelled reminder #2/);
  assert.equal(env.DB.raw.prepare("SELECT status FROM sms_notes WHERE id = 2").get().status, "cancelled");
});

test("inbound webhook rejects bad signatures and ignores unknown senders", async () => {
  const env = { DB: fakeD1(), TWILIO_AUTH_TOKEN: "tok", SMS_USERS: "+15551234567=john@latimer.ai" };
  const url = "https://ledger.example/api/sms/inbound";
  const post = async (params, sig) => {
    const body = new URLSearchParams(params);
    const request = new Request(url, {
      method: "POST", body,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig ?? (await twilioSignature("tok", url, params)) },
    });
    return onRequestPost({ request, env });
  };

  assert.equal((await post({ From: "+15551234567", Body: "hi" }, "forged")).status, 403);

  const stranger = await post({ From: "+19998887777", Body: "hi" });
  assert.equal(stranger.status, 200);
  assert.doesNotMatch(await stranger.text(), /<Message>/);

  const ok = await post({ From: "+15551234567", Body: "note to self <b>&</b>" });
  const xml = await ok.text();
  assert.match(xml, /<Message>📝 Saved note #1\.<\/Message>/);
  assert.equal(env.DB.raw.prepare("SELECT body FROM sms_notes").get().body, "note to self <b>&</b>");
});

test("sendDueReminders sends once, retries failures, gives up after 3", async () => {
  const env = { DB: fakeD1(), TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM_NUMBER: "+18005550000" };
  const { ensureSmsSchema } = await import("../functions/api/sms/_lib.js");
  await ensureSmsSchema(env);
  const ins = env.DB.raw.prepare(
    "INSERT INTO sms_notes (user_email, phone, body, kind, remind_text, remind_at, status, created_at) VALUES (?,?,?,?,?,?,?,?)"
  );
  ins.run("j", "+15551234567", "b1", "reminder", "call Scott", "2026-11-11T14:59:00.000Z", "pending", NOW.toISOString());
  ins.run("j", "+15551234567", "b2", "reminder", "later", "2026-11-11T16:00:00.000Z", "pending", NOW.toISOString());

  const sent = [];
  let fail = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (fail) return new Response(JSON.stringify({ message: "nope" }), { status: 400 });
    sent.push(Object.fromEntries(new URLSearchParams(init.body)));
    return new Response(JSON.stringify({ sid: "SM1" }), { status: 201 });
  };
  try {
    assert.deepEqual(await sendDueReminders(env, NOW), [{ id: 1, sent: true }]);
    assert.deepEqual(sent, [{ To: "+15551234567", Body: "⏰ Reminder: call Scott", From: "+18005550000" }]);
    assert.deepEqual(await sendDueReminders(env, NOW), [], "already sent → not resent");

    fail = true;
    const later = new Date("2026-11-11T16:01:00Z");
    for (let i = 0; i < 3; i++) await sendDueReminders(env, later);
    const row = env.DB.raw.prepare("SELECT status, attempts, detail FROM sms_notes WHERE id = 2").get();
    assert.equal(row.status, "error");
    assert.equal(row.attempts, 3);
    assert.match(row.detail, /twilio 400 nope/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
