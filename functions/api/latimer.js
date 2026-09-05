// Cloudflare Pages Function — /api/latimer
// Same-origin proxy to the Latimer completion API. Hal calls this from the
// browser (same origin → no CORS); the function forwards to Latimer server-side,
// where CORS doesn't apply. The key comes from the request body (the user's key,
// entered in the app) or, if absent, from a LATIMER_API_KEY environment secret.
// The key is used to sign the upstream call and is never stored or logged.

const LATIMER_URL = "https://api.latimer.ai/v2/api/completion";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Bad JSON body" }, 400); }

  const key = (body && body.key) || (env && env.LATIMER_API_KEY) || "";
  if (!key) return json({ error: "No Latimer API key provided" }, 401);

  const version = (body && body.latimerVersion) || "2026-01-02";
  const payload = {
    message: (body && body.message) || "",
    model: (body && body.model) || undefined,
    additionalInstructions: (body && body.additionalInstructions) || undefined,
    additionalMessages: (body && Array.isArray(body.additionalMessages)) ? body.additionalMessages : undefined,
    modelTemperature: (body && typeof body.modelTemperature === "number") ? body.modelTemperature : undefined,
  };
  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

  let r;
  try {
    r = await fetch(LATIMER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key, "Latimer-Version": version },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json({ error: "Could not reach Latimer: " + (e && e.message ? e.message : String(e)) }, 502);
  }

  // Pass Latimer's status + body straight back to the browser.
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { "Content-Type": r.headers.get("content-type") || "application/json" },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
