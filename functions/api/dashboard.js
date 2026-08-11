// Cloudflare Pages Function — /api/dashboard
// Monthly invite + connection aggregates, computed in SQL (GROUP BY month).
// Message volume/reply-rate still come from the client-side msgstats rollup.
// Requires a D1 binding named `DB` and the `contacts` table (see schema.sql).

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) return json({ error: "D1 binding 'DB' not found" }, 500);
  const email = request.headers.get("Cf-Access-Authenticated-User-Email") || "default";
  try {
    const invStmt = env.DB.prepare(
      "SELECT substr(invited_date,1,7) AS ym, COUNT(*) AS sent, SUM(connected) AS accepted " +
      "FROM contacts WHERE user_email=? AND invited_date<>'' GROUP BY ym"
    ).bind(email);
    const connStmt = env.DB.prepare(
      "SELECT substr(connected_on,1,7) AS ym, COUNT(*) AS won " +
      "FROM contacts WHERE user_email=? AND connected_on<>'' GROUP BY ym"
    ).bind(email);
    const [invRes, connRes] = await env.DB.batch([invStmt, connStmt]);
    const invites = {}, connections = {};
    for (const r of invRes.results) if (r.ym) invites[r.ym] = { sent: r.sent || 0, accepted: r.accepted || 0 };
    for (const r of connRes.results) if (r.ym) connections[r.ym] = r.won || 0;
    return json({ invites, connections });
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) }, 500);
  }
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
