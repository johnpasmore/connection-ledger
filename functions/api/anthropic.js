// Cloudflare Pages Function — /api/anthropic
// Same-origin proxy to the Anthropic Messages API so any signed-in device (e.g. an
// iPhone) can use Hal WITHOUT entering an API key in the browser. The key comes from
// the ANTHROPIC_API_KEY Cloudflare secret (or a body.key if the browser has one).
// Access-gated same-origin, so only signed-in @latimer.ai users reach it. The key is
// used to sign the upstream call and is never stored or logged.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Bad JSON body" }, 400); }

  const key = (body && body.key) || (env && env.ANTHROPIC_API_KEY) || "";
  if (!key) return json({ error: "no-server-key" }, 401); // client maps 401 → "add a key"

  const payload = {
    model: (body && body.model) || "claude-sonnet-4-5",
    max_tokens: (body && body.max_tokens) || 1000,
    system: (body && body.system) || undefined,
    messages: (body && Array.isArray(body.messages)) ? body.messages : [],
  };
  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

  let r;
  try {
    r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json({ error: "Could not reach Anthropic: " + (e && e.message ? e.message : String(e)) }, 502);
  }

  // Pass Anthropic's status + body straight back to the browser.
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { "Content-Type": r.headers.get("content-type") || "application/json", "Cache-Control": "no-store" },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
