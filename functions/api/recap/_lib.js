// Shared helpers for the automatic weekly recap OAuth flow (Pages side).
// Files beginning with "_" are not served as routes by Cloudflare Pages.

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

// The app_state key whose accounts this recap is built from. Mirrors state.js:
// once Cloudflare Access is on, that key is JP's email; before Access it's "default".
export function recapUserEmail(env) {
  return (env && env.RECAP_USER_EMAIL) || "john@latimer.ai";
}

// Exact redirect URI — must be registered verbatim in the Google OAuth client.
export function redirectUri(request) {
  return new URL("/api/recap/callback", request.url).toString();
}

// ---- AES-GCM encryption of the refresh token -------------------------------
// The key is derived by SHA-256 of the RECAP_ENC_KEY secret, so any random
// string works as the secret. Output/format: base64(iv[12] || ciphertext).
async function aesKey(secret) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
export async function encryptToken(secret, plaintext) {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64encode(out);
}
export async function decryptToken(secret, packed) {
  const bytes = b64decode(packed);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const key = await aesKey(secret);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

export function b64encode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
export function b64decode(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function missingConfig(env) {
  const need = [];
  if (!env.DB) need.push("D1 binding 'DB'");
  if (!env.GOOGLE_CLIENT_ID) need.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) need.push("GOOGLE_CLIENT_SECRET");
  if (!env.RECAP_ENC_KEY) need.push("RECAP_ENC_KEY");
  return need;
}
