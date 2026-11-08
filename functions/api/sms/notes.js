// /api/sms/notes — the Notes & reminders tab (Access-gated, same as the rest of /api).
// GET                     → { notes: [...], configured: {...} } for the signed-in user
// POST {action:'cancel', id} → cancel a pending reminder
// POST {action:'delete', id} → delete a note or reminder

import { ensureSmsSchema, parseUsers } from "./_lib.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) return json({ error: "D1 binding 'DB' not found" }, 500);
  const email = (request.headers.get("Cf-Access-Authenticated-User-Email") || "default").toLowerCase();
  // Before Access was on, JP's data lived under "default"; his texts are stored
  // under the email in SMS_USERS, so let either identity see his own rows.
  const owners = ownersFor(env, email);

  try {
    await ensureSmsSchema(env);
    if (request.method === "GET") {
      const marks = owners.map(() => "?").join(",");
      const rows = await env.DB
        .prepare(
          "SELECT id, body, kind, remind_text, remind_at, status, detail, created_at, sent_at FROM sms_notes " +
            "WHERE user_email IN (" + marks + ") ORDER BY created_at DESC LIMIT 200"
        )
        .bind(...owners)
        .all();
      return json({
        notes: rows.results || [],
        configured: {
          twilio: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
          phones: Object.keys(parseUsers(env.SMS_USERS)).filter((p) => owners.includes(parseUsers(env.SMS_USERS)[p])).map(mask),
        },
      });
    }
    if (request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const id = parseInt(b.id, 10);
      if (!id) return json({ error: "id required" }, 400);
      const marks = owners.map(() => "?").join(",");
      let stmt;
      if (b.action === "cancel") {
        stmt = "UPDATE sms_notes SET status = 'cancelled' WHERE id = ? AND status = 'pending' AND user_email IN (" + marks + ")";
      } else if (b.action === "delete") {
        stmt = "DELETE FROM sms_notes WHERE id = ? AND user_email IN (" + marks + ")";
      } else return json({ error: "unknown action" }, 400);
      const r = await env.DB.prepare(stmt).bind(id, ...owners).run();
      return json({ ok: !!(r.meta && r.meta.changes) });
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) }, 500);
  }
}

// The signed-in email, plus JP's known identities when the caller is JP.
const JP = ["default", "johnpasmore@gmail.com", "john@latimer.ai"];
function ownersFor(env, email) {
  return JP.includes(email) ? JP.slice() : [email];
}

function mask(p) {
  return p.length > 4 ? p.slice(0, -4).replace(/\d/g, "•") + p.slice(-4) : p;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
