// Cloudflare Pages Function — serves /api/state
// Stores one JSON blob per user (keyed by their Cloudflare Access email).
// Requires a D1 binding named `DB` and the app_state table (see schema.sql).

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
      const row = await env.DB
        .prepare("SELECT data, updated_at FROM app_state WHERE user_email = ?")
        .bind(email)
        .first();
      return json({
        data: row ? JSON.parse(row.data) : null,
        updated_at: row ? row.updated_at : null,
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
