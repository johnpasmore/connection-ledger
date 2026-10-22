// GET  /api/state/buckets  — list JP-owned snapshots with contact/priority counts.
// POST /api/state/buckets  {restoreFrom:"<email>"} — copy that snapshot into the
//      caller's own bucket (explicit, deliberate recovery).
//
// Both are JP-scoped: only a signed-in JP identity gets anything back, so this
// never exposes or crosses into another user's (e.g. Barika's) data. The GET is
// read-only — it's a safe way to SEE which bucket still holds the full priority
// list before deciding what to restore.

const JP_BUCKETS = ["default", "johnpasmore@gmail.com", "john@latimer.ai"];

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) return json({ error: "D1 binding 'DB' not found" }, 500);

  const email = request.headers.get("Cf-Access-Authenticated-User-Email") || "default";
  const isJP = JP_BUCKETS.indexOf((email || "").toLowerCase()) >= 0 || JP_BUCKETS.indexOf(email) >= 0;
  if (!isJP) return json({ error: "not available for this account" }, 403);

  try {
    if (request.method === "GET") {
      const buckets = [];
      for (const b of JP_BUCKETS) {
        const row = await readRow(env, b);
        if (!row) { buckets.push({ email: b, exists: false }); continue; }
        const st = await snapshotStats(row);
        buckets.push({
          email: b, exists: true, you: b === email,
          contacts: st.contacts, priorities: st.priorities,
          updated_at: row.updated_at, bytes: (row.data || "").length,
        });
      }
      return json({ ok: true, you: email, buckets });
    }

    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const from = String(body.restoreFrom || "");
      if (JP_BUCKETS.indexOf(from) < 0) return json({ error: "restoreFrom must be a JP bucket" }, 400);
      const src = await readRow(env, from);
      if (!src || !src.data) return json({ error: "source bucket is empty" }, 404);
      const now = new Date().toISOString();
      await env.DB
        .prepare(
          "INSERT INTO app_state (user_email, data, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(user_email) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
        )
        .bind(email, src.data, now)
        .run();
      const st = await snapshotStats(src);
      return json({ ok: true, restoredFrom: from, into: email, contacts: st.contacts, priorities: st.priorities });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) }, 500);
  }
}

async function readRow(env, email) {
  return env.DB.prepare("SELECT data, updated_at FROM app_state WHERE user_email = ?").bind(email).first();
}

async function snapshotStats(row) {
  const empty = { contacts: 0, priorities: 0 };
  if (!row || !row.data) return empty;
  try {
    let d = JSON.parse(row.data);
    if (typeof d === "string") d = JSON.parse(await gunzipB64(d));
    const ledger = (d && (d.ledger || d.contacts)) || [];
    const contacts = Array.isArray(ledger) ? ledger.length : 0;
    const priorities = Array.isArray(ledger) ? ledger.filter((c) => c && c.priority).length : 0;
    return { contacts, priorities };
  } catch (e) { return empty; }
}

async function gunzipB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ds = new DecompressionStream("gzip");
  return new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
