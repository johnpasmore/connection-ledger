// Automatic weekly recap — Cloudflare Worker (cron).
//
// Cloudflare Pages Functions can't run on a schedule, so this small Worker owns
// the Monday-7am job. It shares the same D1 database as the connection-ledger
// Pages app (binding `DB`) and reuses everything the app already stores:
//   • accounts + domains live in app_state (gzipped JSON blob) — same as the app,
//   • the Google offline refresh token lives in recap_auth (encrypted),
//   • sends are recorded in recap_log so we never double-send in a week.
//
// It mirrors the app's on-demand recap (index.html → renderRecap): same Gmail
// queries, the same {scott}/{barika} tagging, and the same 3-section prompt.
//
// Triggers:
//   • scheduled()  — cron "0 11,12 * * 1" fires 11:00 & 12:00 UTC Monday; we only
//     proceed when it is actually 07:00 in America/New_York (handles EST/EDT).
//   • fetch()      — GET /run?key=RECAP_RUN_KEY[&force=1] for a manual test send.
//
// Secrets / vars (wrangler.toml + `wrangler secret put`):
//   DB (D1)              RECAP_USER_EMAIL   RECAP_ENC_KEY
//   GOOGLE_CLIENT_ID     GOOGLE_CLIENT_SECRET
//   ANTHROPIC_API_KEY  (or)  LATIMER_API_KEY [+ LATIMER_MODEL]
//   RECAP_RUN_KEY        RECAP_RECIPIENT (default john@latimer.ai)
//   HAL_COMPANY_CONTEXT (optional, mirrors "Hal's context")

const SCOTT = "scott@latimer.ai";
const BARIKA = "barika@latimer.ai";
const TZ = "America/New_York";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, { source: "cron", force: false }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      if (!env.RECAP_RUN_KEY || url.searchParams.get("key") !== env.RECAP_RUN_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
      const force = url.searchParams.get("force") === "1";
      const result = await run(env, { source: "manual", force });
      return new Response(JSON.stringify(result, null, 2), {
        status: result.ok === false ? 500 : 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/health") return new Response("ok");
    return new Response("Not found", { status: 404 });
  },
};

// ---- main -----------------------------------------------------------------
async function run(env, { source, force }) {
  const recipient = env.RECAP_RECIPIENT || "john@latimer.ai";
  const userEmail = env.RECAP_USER_EMAIL || "john@latimer.ai";
  const now = new Date();
  const parts = etParts(now);
  const weekKey = isoWeekKey(now); // 'YYYY-Www' (ET)

  // Cron gate: only actually send at 7am ET Monday (unless forced / manual).
  if (source === "cron" && !force) {
    if (parts.weekday !== 1 || parts.hour !== 7) {
      return { ok: true, skipped: "not-7am-ET-monday", et: parts };
    }
  }

  // Weekly dedupe (skip for a forced/manual run).
  if (!force) {
    try {
      const prior = await env.DB.prepare("SELECT status FROM recap_log WHERE week_key = ?").bind(weekKey).first();
      if (prior && prior.status === "sent") return { ok: true, skipped: "already-sent", weekKey };
    } catch (e) {}
  }

  try {
    // 1) Load accounts from the shared app_state blob.
    const accounts = await loadAccounts(env, userEmail);
    const withDomains = accounts.filter((a) => Array.isArray(a.domains) && a.domains.length);
    if (!withDomains.length) {
      await logRun(env, weekKey, userEmail, "error", "no accounts with domains in app_state");
      return { ok: false, error: "no accounts with domains", userEmail };
    }

    // 2) Fresh Google access token from the stored refresh token.
    const auth = await loadAuth(env, userEmail);
    if (!auth) {
      await logRun(env, weekKey, userEmail, "error", "not connected (no recap_auth row)");
      return { ok: false, error: "Google not connected — visit /api/recap/connect once" };
    }
    const accessToken = await refreshAccessToken(env, auth.refreshToken);

    // 3) Gather Gmail activity (last 7 days) — mirrors the app's gather().
    const data = await gather(accessToken, withDomains, 7);
    if (!data.length) {
      await logRun(env, weekKey, userEmail, "skipped-no-activity", "no prospect email in the last week");
      return { ok: true, skipped: "no-activity", weekKey };
    }

    // 4) Have the model write the 3-section recap.
    const body = await writeRecap(env, data);

    // 5) Send it.
    const subject = "Latimer prospect recap — the last week";
    await gmailSend(accessToken, auth.googleEmail || recipient, recipient, subject, body);

    await logRun(env, weekKey, userEmail, "sent", "to " + recipient + " (" + data.length + " accounts)");
    return { ok: true, sent: true, weekKey, recipient, accounts: data.length };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    await logRun(env, weekKey, userEmail, "error", msg);
    return { ok: false, error: msg };
  }
}

// ---- accounts from app_state (gzip base64 blob) ---------------------------
async function loadAccounts(env, userEmail) {
  let row = await env.DB.prepare("SELECT data FROM app_state WHERE user_email = ?").bind(userEmail).first();
  if (!row) row = await env.DB.prepare("SELECT data FROM app_state WHERE user_email = 'default'").first();
  if (!row || !row.data) return [];
  let packed;
  try { packed = JSON.parse(row.data); } catch (e) { packed = row.data; }
  let jsonStr;
  if (typeof packed === "string") {
    // Could be gzip-base64 (the app's normal path) or plain JSON.
    try { jsonStr = await gunzipB64(packed); }
    catch (e) { jsonStr = packed; }
  } else {
    jsonStr = JSON.stringify(packed);
  }
  let obj;
  try { obj = JSON.parse(jsonStr); } catch (e) { return []; }
  const accts = obj && obj.accounts;
  return Array.isArray(accts) ? accts : [];
}

async function gunzipB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ds = new DecompressionStream("gzip");
  return await new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
}

// ---- offline auth ----------------------------------------------------------
async function loadAuth(env, userEmail) {
  const row = await env.DB
    .prepare("SELECT google_email, enc_refresh, scope FROM recap_auth WHERE user_email = ?")
    .bind(userEmail)
    .first();
  if (!row) return null;
  const refreshToken = await decryptToken(env.RECAP_ENC_KEY, row.enc_refresh);
  return { googleEmail: row.google_email || "", refreshToken, scope: row.scope || "" };
}

async function refreshAccessToken(env, refreshToken) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const t = await r.json();
  if (!r.ok || !t.access_token) throw new Error("token refresh failed: " + JSON.stringify(t).slice(0, 200));
  return t.access_token;
}

// ---- Gmail gather (mirrors index.html renderRecap.gather) ------------------
async function gather(accessToken, accounts, days) {
  const afterStr = ymd(new Date(Date.now() - days * 86400000));
  const out = [];
  for (const a of accounts) {
    const terms = a.domains.map((d) => "from:" + d + " OR to:" + d).join(" OR ");
    const q = "after:" + afterStr + " (" + terms + ")";
    let list;
    try {
      list = await gFetch(accessToken, "https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=" + encodeURIComponent(q));
    } catch (e) { continue; }
    const ids = (list.messages || []).slice(0, 12);
    const msgs = [];
    for (const it of ids) {
      try {
        const full = await gFetch(
          accessToken,
          "https://www.googleapis.com/gmail/v1/users/me/messages/" + it.id +
            "?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date"
        );
        const H = {};
        ((full.payload && full.payload.headers) || []).forEach((h) => { H[(h.name || "").toLowerCase()] = h.value; });
        const people = ((H.from || "") + " " + (H.to || "") + " " + (H.cc || "")).toLowerCase();
        let when = H.date ? new Date(H.date) : (full.internalDate ? new Date(+full.internalDate) : null);
        msgs.push({
          date: when && !isNaN(when) ? when.toISOString().slice(0, 10) : "",
          from: H.from || "",
          subject: H.subject || "(no subject)",
          snippet: (full.snippet || "").slice(0, 240),
          scott: people.indexOf(SCOTT) >= 0,
          barika: people.indexOf(BARIKA) >= 0,
        });
      } catch (e) {}
    }
    if (msgs.length) out.push({ name: a.name, stage: a.stage, tier: a.tier, messages: msgs });
  }
  return out;
}

async function gFetch(accessToken, url) {
  const r = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
  if (!r.ok) throw new Error("gmail " + r.status);
  return r.json();
}

// ---- model: write the recap (Anthropic preferred, Latimer fallback) --------
async function writeRecap(env, data) {
  const company = env.HAL_COMPANY_CONTEXT ||
    "Latimer.AI sells to schools. The motion is a free trial converting to a paid account at $3 per student per month.";
  const sys =
    "You are Hal, sales partner at Latimer.AI. " + company +
    " Write a clear, skimmable recap EMAIL BODY (plain text, no markdown symbols like * or #) for JP covering the last week. " +
    "Use EXACTLY these three sections with these headers on their own lines:\n\n" +
    "1) ALL ACTIVITY\n2) THREADS INVOLVING SCOTT (scott@latimer.ai)\n3) THREADS INVOLVING BARIKA (barika@latimer.ai)\n\n" +
    "Section 1: for each account with activity, a couple of tight bullet lines on what happened and where it stands.\n" +
    "Section 2: list ONLY threads whose messages are tagged {scott}, grouped by account. IF AND ONLY IF there are zero such threads, write exactly this one line and nothing else in the section: \"No threads involved Scott in this period.\" If you list any threads, do NOT include that sentence.\n" +
    "Section 3: same rule for threads tagged {barika}, using \"No threads involved Barika in this period.\" only when there are none.\n" +
    "Never both list threads and say there were none. Keep sections 2 and 3 self-contained so JP can copy each to that person. Do not invent anything not in the data.";
  const user =
    "Here is the email activity with prospect accounts over the last week (metadata + snippets; {scott}/{barika} mark who was on the thread):\n\n" +
    fmtData(data);

  if (env.ANTHROPIC_API_KEY) return anthropic(env, sys, user);
  if (env.LATIMER_API_KEY) return latimer(env, sys, user);
  throw new Error("no model key: set ANTHROPIC_API_KEY or LATIMER_API_KEY");
}

function fmtData(data) {
  return data
    .map((acc) =>
      "ACCOUNT: " + acc.name + " (" + (acc.stage || "") + ")\n" +
      acc.messages
        .map((m) => "  [" + m.date + "] " + m.from + " — " + m.subject + (m.scott ? " {scott}" : "") + (m.barika ? " {barika}" : "") + "\n    " + m.snippet)
        .join("\n")
    )
    .join("\n\n");
}

async function anthropic(env, sys, user) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || "claude-opus-4-8",
      max_tokens: 3000,
      system: sys,
      messages: [{ role: "user", content: user }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("anthropic " + r.status + " " + JSON.stringify(j).slice(0, 200));
  return (j.content || []).map((c) => c.text || "").join("").trim();
}

async function latimer(env, sys, user) {
  const r = await fetch("https://api.latimer.ai/v2/api/completion", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.LATIMER_API_KEY,
      "Latimer-Version": env.LATIMER_VERSION || "2026-01-02",
    },
    body: JSON.stringify({
      message: user,
      model: env.LATIMER_MODEL || "gpt-5",
      additionalInstructions: sys,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("latimer " + r.status + " " + JSON.stringify(j).slice(0, 200));
  return (j.output || j.completion || j.message || "").toString().trim();
}

// ---- Gmail send ------------------------------------------------------------
async function gmailSend(accessToken, from, to, subject, body) {
  const mime =
    "From: " + from + "\r\n" +
    "To: " + to + "\r\n" +
    "Subject: " + encodeSubject(subject) + "\r\n" +
    "MIME-Version: 1.0\r\n" +
    'Content-Type: text/plain; charset="UTF-8"\r\n' +
    "Content-Transfer-Encoding: 8bit\r\n\r\n" +
    body;
  const raw = b64url(new TextEncoder().encode(mime));
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!r.ok) {
    let t = ""; try { t = await r.text(); } catch (e) {}
    throw new Error("gmail send " + r.status + " " + t.slice(0, 200));
  }
  return r.json();
}

function encodeSubject(s) {
  // RFC 2047 encoded-word only if non-ASCII is present.
  return /[^\x00-\x7F]/.test(s) ? "=?UTF-8?B?" + btoa(unescape(encodeURIComponent(s))) + "?=" : s;
}

// ---- crypto (matches functions/api/recap/_lib.js) --------------------------
async function decryptToken(secret, packed) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  const bin = atob(packed);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// ---- misc ------------------------------------------------------------------
async function logRun(env, weekKey, userEmail, status, detail) {
  try {
    await env.DB.prepare(
      "INSERT INTO recap_log (week_key, user_email, status, detail, sent_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(week_key) DO UPDATE SET status=excluded.status, detail=excluded.detail, sent_at=excluded.sent_at, user_email=excluded.user_email"
    )
      .bind(weekKey, userEmail, status, detail, new Date().toISOString())
      .run();
  } catch (e) {}
}

function ymd(d) { return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate(); }

function b64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Current wall-clock parts in America/New_York (handles EST/EDT automatically).
function etParts(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", hour: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const p = {};
  fmt.formatToParts(date).forEach((x) => { p[x.type] = x.value; });
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { weekday: wdMap[p.weekday], hour: parseInt(p.hour, 10) % 24, y: +p.year, m: +p.month, d: +p.day };
}

// ISO-week key in ET, e.g. "2026-W37" — used as the weekly dedupe key.
function isoWeekKey(date) {
  const p = etParts(date);
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const day = dt.getUTCDay() || 7; // Mon=1..Sun=7
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return dt.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}
