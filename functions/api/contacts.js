// Cloudflare Pages Function — /api/contacts
// GET  → paginated list + stat counts, filtered/sorted/searched server-side.
// POST → bulk upsert (used by import and the one-time migration).
// Requires a D1 binding named `DB` and the `contacts` table (see schema.sql).

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) return json({ error: "D1 binding 'DB' not found" }, 500);
  const email =
    request.headers.get("Cf-Access-Authenticated-User-Email") || "default";
  try {
    if (request.method === "GET") return await list(env, email, new URL(request.url).searchParams);
    if (request.method === "POST") return await bulkUpsert(env, email, await request.json());
    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) }, 500);
  }
}

// ---- shared SQL fragments -------------------------------------------------
// LinkedIn signal = any LinkedIn footprint on the contact.
const LI = "(invited_date<>'' OR connected=1 OR messaged=1 OR replied=1)";
// status expression, parameterised by an integer staleness threshold (days).
function statusExpr(t) {
  return (
    "CASE WHEN connected=1 OR manual_status='connected' THEN 'connected' " +
    "WHEN manual_status='no_response' THEN 'no_response' " +
    "WHEN action_day<>'' AND (julianday('now') - julianday(action_day)) > " + t + " THEN 'no_response' " +
    "ELSE 'pending' END"
  );
}

function buildWhere(email, p) {
  const where = ["user_email = ?"], args = [email];
  const status = (p.get("status") || "all"), chan = (p.get("channel") || "all");
  const q = (p.get("q") || "").trim(), state = (p.get("state") || "").trim();
  const t = clampInt(p.get("threshold"), 21, 1, 3650);
  if (status !== "all") { where.push(statusExpr(t) + " = ?"); args.push(status); }
  if (chan === "email") where.push("has_email=1");
  else if (chan === "li_only") where.push(LI + " AND has_email=0");
  else if (chan === "email_only") where.push("has_email=1 AND NOT " + LI);
  else if (chan === "both") where.push("has_email=1 AND " + LI);
  else if (chan === "msg_noreply") where.push("messaged=1 AND replied=0 AND connected=0");
  if (q) { const like = "%" + q.toLowerCase() + "%"; where.push("(lower(name) LIKE ? OR lower(company) LIKE ? OR lower(position) LIKE ? OR lower(institution) LIKE ?)"); args.push(like, like, like, like); }
  if (state) { where.push("lower(state) LIKE ?"); args.push("%" + state.toLowerCase() + "%"); }
  return { clause: where.join(" AND "), args, t };
}

async function list(env, email, p) {
  const { clause, args, t } = buildWhere(email, p);
  const page = clampInt(p.get("page"), 0, 0, 1e9);
  const size = clampInt(p.get("size"), 50, 1, 200);
  const sort = p.get("sort") || "status";
  let order = "action_day DESC, name COLLATE NOCASE ASC";
  if (sort === "date_asc") order = "action_day ASC, name COLLATE NOCASE ASC";
  else if (sort === "status") order = "CASE " + statusExpr(t) + " WHEN 'no_response' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END ASC, action_day DESC";

  const rowsStmt = env.DB.prepare(
    "SELECT data FROM contacts WHERE " + clause + " ORDER BY " + order + " LIMIT ? OFFSET ?"
  ).bind(...args, size, page * size);
  const totalStmt = env.DB.prepare("SELECT COUNT(*) AS n FROM contacts WHERE " + clause).bind(...args);
  const countsStmt = env.DB.prepare(
    "SELECT " +
      "COUNT(*) AS tracked, " +
      "SUM(CASE WHEN " + statusExpr(t) + "='connected' THEN 1 ELSE 0 END) AS connected, " +
      "SUM(CASE WHEN " + statusExpr(t) + "='no_response' THEN 1 ELSE 0 END) AS no_response, " +
      "SUM(CASE WHEN " + statusExpr(t) + "='pending' THEN 1 ELSE 0 END) AS pending " +
    "FROM contacts WHERE user_email = ?"
  ).bind(email);

  const [rowsRes, totalRes, countsRes] = await env.DB.batch([rowsStmt, totalStmt, countsStmt]);
  const rows = rowsRes.results.map(r => safeParse(r.data)).filter(Boolean);
  const c = countsRes.results[0] || {};
  return json({
    rows, page, size,
    total: (totalRes.results[0] || {}).n || 0,
    counts: { tracked: c.tracked || 0, connected: c.connected || 0, no_response: c.no_response || 0, pending: c.pending || 0 },
  });
}

async function bulkUpsert(env, email, body) {
  const items = (body && Array.isArray(body.contacts)) ? body.contacts : [];
  if (body && body.replace) await env.DB.prepare("DELETE FROM contacts WHERE user_email = ?").bind(email).run();
  if (!items.length) return json({ upserted: 0 });
  const now = new Date(0).toISOString(); // caller may pass real time via item; deterministic default
  const stmts = items.map(c => {
    const r = normalize(c);
    return env.DB.prepare(
      "INSERT INTO contacts (user_email,id,name,profile_url,email,company,position,institution,action_day,connected,connected_on,invited_date,messaged,replied,has_email,manual_status,stage,category,priority,state,notes,data,updated_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(user_email,id) DO UPDATE SET name=excluded.name,profile_url=excluded.profile_url,email=excluded.email,company=excluded.company,position=excluded.position,institution=excluded.institution,action_day=excluded.action_day,connected=excluded.connected,connected_on=excluded.connected_on,invited_date=excluded.invited_date,messaged=excluded.messaged,replied=excluded.replied,has_email=excluded.has_email,manual_status=excluded.manual_status,stage=excluded.stage,category=excluded.category,priority=excluded.priority,state=excluded.state,notes=excluded.notes,data=excluded.data,updated_at=excluded.updated_at"
    ).bind(
      email, r.id, r.name, r.profile_url, r.email, r.company, r.position, r.institution, r.action_day,
      r.connected, r.connected_on, r.invited_date, r.messaged, r.replied, r.has_email, r.manual_status,
      r.stage, r.category, r.priority, r.state, r.notes, r.data, r.updated_at || now
    );
  });
  // D1 caps statements per batch; chunk to stay well under it.
  let upserted = 0;
  for (let i = 0; i < stmts.length; i += 50) { await env.DB.batch(stmts.slice(i, i + 50)); upserted += Math.min(50, stmts.length - i); }
  return json({ upserted });
}

// ---- helpers --------------------------------------------------------------
function day(s) { return s ? String(s).slice(0, 10) : ""; }
function normalize(c) {
  c = c || {};
  const action = c.actionDate || c.connectedOn || c.lastInvitedDate || c.invitedDate || c.firstAdded || "";
  return {
    id: c.id || ("c_" + Math.abs(hash(JSON.stringify(c))).toString(36)),
    name: c.name || "", profile_url: c.profileUrl || "", email: c.email || "",
    company: c.company || "", position: c.position || "", institution: c.institution || "",
    action_day: day(action), connected: c.connected ? 1 : 0, connected_on: day(c.connectedOn),
    invited_date: day(c.invitedDate || c.lastInvitedDate), messaged: c.messaged ? 1 : 0,
    replied: c.replied ? 1 : 0, has_email: c.hasEmail ? 1 : 0, manual_status: c.manualStatus || "",
    stage: c.stage || "", category: c.category || "", priority: c.priority ? 1 : 0,
    state: c.state || "", notes: c.notes || "", data: JSON.stringify(c), updated_at: c.updated_at || "",
  };
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return h; }
function clampInt(v, def, lo, hi) { const n = parseInt(v, 10); if (isNaN(n)) return def; return Math.max(lo, Math.min(hi, n)); }
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
