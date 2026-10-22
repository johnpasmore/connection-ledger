// Cloudflare Pages Function — serves /api/state
// Stores one JSON blob per user (keyed by their Cloudflare Access email).
// Requires a D1 binding named `DB` and the app_state table (see schema.sql).
//
// Recovery note (Oct 2026): before Cloudflare Access was turned on, every request
// landed in the "default" bucket. Once Access went live, JP's requests started
// carrying his Google identity (johnpasmore@gmail.com), which pointed at a fresh,
// empty bucket — and a sparse device state then auto-saved over it. His full
// snapshot (18–20 priorities) still lives in a sibling JP-owned bucket. So on GET,
// if the caller is JP and his own bucket is thinner (fewer priority stars) than
// another JP-owned bucket, we serve the RICHEST JP snapshot instead. This read is
// non-destructive — it never writes — so "Load from cloud" restores the good copy
// and the next explicit save migrates it into his Access bucket cleanly. Other
// users (e.g. barika@latimer.ai) are unaffected: they only ever see their own bucket.

// JP's known identities — the only buckets the recovery fallback reads across.
const JP_BUCKETS = ["default", "johnpasmore@gmail.com", "john@latimer.ai"];

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.DB) {
    return json({ error: "D1 binding 'DB' not found" }, 500);
  }

  // Cloudflare Access injects the signed-in user's email. Before Access is set
  // up, this header is absent, so we fall back to a single shared key.
  const email =
    request.headers.get("Cf-Access-Authenticated-User-Email") || "default";

  try {
    if (request.method === "GET") {
      const ownRow = await readRow(env, email);
      const best = await bestSnapshotFor(env, email, ownRow);
      const chosen = best.row || ownRow;
      return json({
        data: chosen ? JSON.parse(chosen.data) : null,
        updated_at: chosen ? chosen.updated_at : null,
        // Transparency: tells the client when a sibling bucket was served.
        recoveredFrom: best.recoveredFrom || null,
      });
    }

    if (request.method === "PUT") {
      const body = await request.json();
      const data = JSON.stringify(body.data || {});
      const now = new Date().toISOString();
      await env.DB
        .prepare(
          "INSERT INTO app_state (user_email, data, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(user_email) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
        )
        .bind(email, data, now)
        .run();
      return json({ ok: true, updated_at: now });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) }, 500);
  }
}

async function readRow(env, email) {
  return env.DB
    .prepare("SELECT data, updated_at FROM app_state WHERE user_email = ?")
    .bind(email)
    .first();
}

// For a JP identity, pick the JP-owned bucket with the most priority stars
// (tie-break: most contacts, then most recent). Returns {row, recoveredFrom}.
// For anyone else, returns {row: ownRow} unchanged.
async function bestSnapshotFor(env, email, ownRow) {
  if (JP_BUCKETS.indexOf((email || "").toLowerCase()) < 0 &&
      JP_BUCKETS.indexOf(email) < 0) {
    return { row: ownRow };
  }
  const ownStats = await snapshotStats(ownRow);
  let bestRow = ownRow, bestStats = ownStats, bestEmail = email;
  for (const b of JP_BUCKETS) {
    if (b === email) continue;
    const r = await readRow(env, b);
    if (!r) continue;
    const st = await snapshotStats(r);
    if (richer(st, bestStats)) { bestRow = r; bestStats = st; bestEmail = b; }
  }
  // Only override when a sibling is STRICTLY richer in priorities (or own is empty).
  if (bestRow !== ownRow && (bestStats.priorities > ownStats.priorities || ownStats.contacts === 0)) {
    return { row: bestRow, recoveredFrom: bestEmail };
  }
  return { row: ownRow };
}

function richer(a, b) {
  if (a.priorities !== b.priorities) return a.priorities > b.priorities;
  if (a.contacts !== b.contacts) return a.contacts > b.contacts;
  return (a.updated || "") > (b.updated || "");
}

// Decode a stored row far enough to count contacts and priority stars.
// Stored shape: data column is JSON.stringify(<base64 gzip of payload JSON>)
// (older rows may be JSON.stringify(<payload object>) directly). Best-effort.
async function snapshotStats(row) {
  const empty = { contacts: 0, priorities: 0, updated: row ? row.updated_at : "" };
  if (!row || !row.data) return empty;
  try {
    let d = JSON.parse(row.data);
    if (typeof d === "string") d = JSON.parse(await gunzipB64(d)); // gzip blob
    const ledger = (d && (d.ledger || d.contacts)) || [];
    const contacts = Array.isArray(ledger) ? ledger.length : 0;
    const priorities = Array.isArray(ledger) ? ledger.filter((c) => c && c.priority).length : 0;
    return { contacts, priorities, updated: row.updated_at };
  } catch (e) {
    return empty;
  }
}

async function gunzipB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ds = new DecompressionStream("gzip");
  return new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
