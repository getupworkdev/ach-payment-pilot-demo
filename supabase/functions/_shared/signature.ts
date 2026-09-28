// HMAC-SHA256 over the raw request body, hex encoded. Same shape as most
// processors' webhook signing; the header name is our own.

export const SIGNATURE_HEADER = "x-provider-signature";

const encoder = new TextEncoder();

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function sign(secret: string, body: string): Promise<string> {
  return hmacHex(secret, body);
}

export async function verify(secret: string, body: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const expected = await hmacHex(secret, body);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
