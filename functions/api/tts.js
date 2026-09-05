// Cloudflare Pages Function — /api/tts
// Same-origin proxy to ElevenLabs text-to-speech, so Hal can speak in a custom
// (cloned) voice from the browser without CORS and without exposing the key in
// page HTML. The browser POSTs { key, voiceId, model, text }; the function calls
// ElevenLabs server-side and streams the audio (audio/mpeg) straight back.
// The key is used only to sign the upstream call — not stored or logged. A
// ELEVENLABS_API_KEY environment secret is used as a fallback when no key is sent.

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return jerr("Method not allowed", 405);

  let body;
  try { body = await request.json(); } catch (e) { return jerr("Bad JSON body", 400); }

  const key = (body && body.key) || (env && env.ELEVENLABS_API_KEY) || "";
  if (!key) return jerr("No ElevenLabs API key provided", 401);
  const voiceId = (body && body.voiceId) || "";
  if (!voiceId) return jerr("No ElevenLabs voice id provided", 400);
  const model = (body && body.model) || "eleven_turbo_v2_5";
  const text = (body && body.text) || "";
  if (!text.trim()) return jerr("No text provided", 400);

  let r;
  try {
    r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voiceId), {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg" },
      body: JSON.stringify({
        text: text.slice(0, 4000),
        model_id: model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
  } catch (e) {
    return jerr("Could not reach ElevenLabs: " + (e && e.message ? e.message : String(e)), 502);
  }

  if (!r.ok) {
    let t = ""; try { t = await r.text(); } catch (e) {}
    return jerr("ElevenLabs " + r.status + " " + t.replace(/\s+/g, " ").slice(0, 220), r.status);
  }
  // Stream the audio straight back to the browser.
  return new Response(r.body, {
    status: 200,
    headers: { "Content-Type": r.headers.get("content-type") || "audio/mpeg", "Cache-Control": "no-store" },
  });
}

function jerr(m, s) {
  return new Response(JSON.stringify({ error: m }), { status: s || 500, headers: { "Content-Type": "application/json" } });
}
