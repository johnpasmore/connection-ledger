// GET /api/hal/engine
// Reports which server-side model keys are configured, so the app knows it can run
// KEYLESS on any signed-in device (no per-device API-key entry). Returns booleans
// only — never the keys themselves. Access-gated same-origin (@latimer.ai only).

export async function onRequestGet(context) {
  const { env } = context;
  return new Response(
    JSON.stringify({
      engines: {
        anthropic: !!(env && env.ANTHROPIC_API_KEY),
        latimer: !!(env && env.LATIMER_API_KEY),
      },
    }),
    { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
  );
}
