// Uses the Web Crypto API (globalThis.crypto.subtle) instead of Node's
// "crypto" module on purpose: this file is imported from src/middleware.ts,
// which runs on the Next.js Edge Runtime and doesn't support Node built-ins.
// Web Crypto works the same way in both the Edge Runtime and Node 20+.

export const SESSION_COOKIE = "dailyspoon_session";

function secret(): string {
  // Falls back to ADMIN_PASSWORD itself if no dedicated secret is set —
  // fine for a single-admin personal deployment.
  return process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || "dailyspoon-dev-secret";
}

async function hmacHex(message: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sessionTokenForPassword(password: string): Promise<string> {
  return hmacHex(password, secret());
}

export function isCorrectPassword(password: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    console.warn("[auth] ADMIN_PASSWORD is not set — admin area is effectively unlocked.");
    return true;
  }
  return password === expected;
}

export async function isValidSessionToken(token: string | undefined): Promise<boolean> {
  if (!process.env.ADMIN_PASSWORD) return true; // no password configured -> open (dev convenience)
  if (!token) return false;
  const expected = await sessionTokenForPassword(process.env.ADMIN_PASSWORD);
  return token === expected;
}
