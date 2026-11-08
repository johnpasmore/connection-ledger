// Tests for SMS notes & reminders. Run: node --test test/
// D1 is stood in for by node:sqlite (same SQLite dialect), wrapped in the small
// slice of the D1 API the code uses: prepare().bind().run()/all()/first(), batch().

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";

import {
  normalizePhone, splitCode, codeProblem, twilioConfig, twilioSignature, validTwilioRequest, zonedToUtc, zonedParts,
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

test("normalizePhone", () => {
  assert.equal(normalizePhone("(555) 123-4567"), "+15551234567");
  assert.equal(normalizePhone("+1 555 123 4567"), "+15551234567");
  assert.equal(normalizePhone("(339) 300-5973"), "+13393005973");
});

test("splitCode reads a leading code only when it is registered", () => {
  const codes = new Set(["jp7", "ops"]);
  assert.deepEqual(splitCode("jp7 remind me at 3pm", codes), { code: "jp7", rest: "remind me at 3pm" });
  assert.deepEqual(splitCode("JP7: list", codes), { code: "jp7", rest: "list" });
  assert.deepEqual(splitCode("#jp7 note", codes), { code: "jp7", rest: "note" });
  assert.deepEqual(splitCode("jp7", codes), { code: "jp7", rest: "" });
  assert.deepEqual(splitCode("jp77 hello", codes), { code: null, rest: "jp77 hello" });
  assert.deepEqual(splitCode("remind me at 3pm", codes), { code: null, rest: "remind me at 3pm" });
});

test("codeProblem rejects bad and reserved codes", () => {
  assert.equal(codeProblem("jp7"), "");
  assert.match(codeProblem("j"), /2–12/);
  assert.match(codeProblem("jp-7"), /2–12/);
  assert.match(codeProblem("remind"), /command word/);
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

// Signed POST to /api/sms/inbound, as Twilio would send it.
const HOOK = "https://ledger.example/api/sms/inbound";
async function inbound(env, params, sig) {
  const request = new Request(HOOK, {
    method: "POST",
    body: new URLSearchParams(params),
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig ?? (await twilioSignature("tok", HOOK, params)) },
  });
  const res = await onRequestPost({ request, env });
  return { status: res.status, xml: await res.text() };
}
async function routedEnv(extra = {}) {
  const env = { DB: fakeD1(), TWILIO_AUTH_TOKEN: "tok", ...extra };
  const { ensureSmsSchema } = await import("../functions/api/sms/_lib.js");
  await ensureSmsSchema(env);
  const ins = env.DB.raw.prepare("INSERT INTO sms_routes (code, user_email, phone, forward_url, label) VALUES (?,?,?,?,?)");
  ins.run("jp7", "john@latimer.ai", "+15551234567", null, null);
  ins.run("bk", "barika@latimer.ai", null, null, null);
  ins.run("ops", null, null, "https://ops.example/sms", "Ops bot");
  return env;
}

test("inbound: people are known by phone; codes are optional", async () => {
  const env = await routedEnv();
  const JP = "+15551234567", STRANGER = "+19998887777";

  assert.equal((await inbound(env, { From: JP, Body: "hi" }, "forged")).status, 403);

  // JP's registered phone, no code → saved under JP.
  const ok = await inbound(env, { From: JP, Body: "note to self <b>&</b>" });
  assert.match(ok.xml, /<Message>📝 Saved note #1\.<\/Message>/);
  assert.deepEqual({ ...env.DB.raw.prepare("SELECT user_email, body FROM sms_notes WHERE id = 1").get() },
    { user_email: "john@latimer.ai", body: "note to self <b>&</b>" });

  // JP's phone with his code also works; the code is stripped.
  await inbound(env, { From: JP, Body: "jp7 remind me in 2 hours to call Scott" });
  assert.equal(env.DB.raw.prepare("SELECT remind_text FROM sms_notes WHERE id = 2").get().remind_text, "call Scott");

  // From another phone, the code is how JP is recognised; replies go to that phone.
  const away = await inbound(env, { From: STRANGER, Body: "jp7 remind me in 1 hour to pay invoice" });
  assert.match(away.xml, /jp7 cancel 3/);
  assert.deepEqual({ ...env.DB.raw.prepare("SELECT user_email, phone FROM sms_notes WHERE id = 3").get() },
    { user_email: "john@latimer.ai", phone: STRANGER });

  // Barika has a code but no phone → her code works from any phone.
  await inbound(env, { From: STRANGER, Body: "bk call Spelman" });
  assert.equal(env.DB.raw.prepare("SELECT user_email FROM sms_notes WHERE id = 4").get().user_email, "barika@latimer.ai");

  // Unregistered phone, no code → silence, nothing stored.
  assert.doesNotMatch((await inbound(env, { From: STRANGER, Body: "hello" })).xml, /<Message>/);

  // Empty text from JP's phone → help without a code prefix.
  assert.match((await inbound(env, { From: JP, Body: "" })).xml, /&quot;remind me tomorrow 9am/);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM sms_notes").get().n, 4);
});

test("inbound: another app's code is forwarded, re-signed, and its reply relayed", async () => {
  const env = await routedEnv();
  const realFetch = globalThis.fetch;
  let got = null;
  globalThis.fetch = async (url, init) => {
    got = { url, sig: init.headers["X-Twilio-Signature"], params: Object.fromEntries(new URLSearchParams(init.body)) };
    return new Response("<Response><Message>ops ok</Message></Response>", { headers: { "Content-Type": "text/xml" } });
  };
  try {
    const r = await inbound(env, { From: "+15551234567", Body: "ops status please", MessageSid: "SM1" });
    assert.equal(r.xml, "<Response><Message>ops ok</Message></Response>");
    assert.equal(got.url, "https://ops.example/sms");
    assert.equal(got.params.Body, "status please");
    assert.equal(got.sig, await twilioSignature("tok", "https://ops.example/sms", got.params), "re-signed for the target URL");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("inbound: texts from unregistered phones go to the fallback app when one is set", async () => {
  const env = await routedEnv();
  env.DB.raw.prepare("INSERT INTO sms_settings (id, fallback_url) VALUES (1, 'https://legacy.example/hook')").run();
  const realFetch = globalThis.fetch;
  let url = null, body = null;
  globalThis.fetch = async (u, init) => { url = u; body = Object.fromEntries(new URLSearchParams(init.body)).Body; return new Response("<Response/>"); };
  try {
    await inbound(env, { From: "+15551234567", Body: "mine" });
    assert.equal(url, null, "a registered phone is never sent to the fallback");
    await inbound(env, { From: "+19998887777", Body: "plain text" });
    assert.equal(url, "https://legacy.example/hook");
    assert.equal(body, "plain text");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("settings API: saves codes and an encrypted token, never returns the token", async () => {
  const { onRequest } = await import("../functions/api/sms/settings.js");
  const env = { DB: fakeD1(), RECAP_ENC_KEY: "k".repeat(40) };
  const call = async (method, body, who = "john@latimer.ai") => {
    const res = await onRequest({ env, request: new Request("https://ledger.example/api/sms/settings", {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { "Content-Type": "application/json", "Cf-Access-Authenticated-User-Email": who },
    }) });
    return { status: res.status, j: await res.json() };
  };
  const token = "0123456789abcdef0123456789abcdef";
  let r = await call("PUT", {
    twilio: { accountSid: "AC" + "a".repeat(32), authToken: token, fromNumber: "(339) 300-5973" },
    me: { code: "JP7", phone: "555 123 4567" },
    apps: [{ code: "ops", label: "Ops", forward_url: "https://ops.example/sms" }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.twilio.fromNumber, "+13393005973");
  assert.equal(r.j.twilio.hasAuthToken, true);
  assert.deepEqual(r.j.me, { code: "jp7", phone: "+15551234567" });
  assert.deepEqual(r.j.apps, [{ code: "ops", label: "Ops", forward_url: "https://ops.example/sms" }]);
  assert.ok(!JSON.stringify(r.j).includes(token), "token never echoed");
  const stored = env.DB.raw.prepare("SELECT enc_auth_token FROM sms_settings").get().enc_auth_token;
  assert.ok(stored && !stored.includes(token), "stored encrypted");
  assert.equal((await twilioConfig(env)).authToken, token, "decrypts for sending");

  // Saving again without a token keeps the saved one.
  await call("PUT", { twilio: { accountSid: "AC" + "a".repeat(32), fromNumber: "+13393005973" } });
  assert.equal((await twilioConfig(env)).authToken, token);

  // Someone else can't take JP's code or an app's code.
  assert.match((await call("PUT", { me: { code: "jp7" } }, "barika@latimer.ai")).j.error, /already in use/);
  assert.match((await call("PUT", { apps: [{ code: "jp7", forward_url: "https://x.example" }] }, "barika@latimer.ai")).j.error, /personal code/);
  assert.match((await call("PUT", { me: { code: "remind" } }, "barika@latimer.ai")).j.error, /command word/);
  assert.match((await call("PUT", { me: { phone: "(555) 123-4567" } }, "barika@latimer.ai")).j.error, /already registered/);

  // Phone only, no code, is a full registration.
  r = await call("PUT", { me: { phone: "+15557654321" } }, "barika@latimer.ai");
  assert.deepEqual(r.j.me, { code: "", phone: "+15557654321" });

  // Env vars win over Settings.
  env.TWILIO_AUTH_TOKEN = "f".repeat(32);
  assert.equal((await twilioConfig(env)).authToken, "f".repeat(32));
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
    assert.deepEqual(sent, [{ To: "+15551234567", Body: "⏰ John reminder: call Scott", From: "+18005550000" }]);
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
