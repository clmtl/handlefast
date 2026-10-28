import { env } from "../_generated/server";

const encoder = new TextEncoder();
export async function sha256(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function equalSignature(a: string, b: string) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
async function key() {
  const raw = env.COMMERCE_ENCRYPTION_KEY;
  if (!raw) throw new Error("CommerceEncryptionNotConfigured");
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("InvalidCommerceEncryptionKey");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(value: string, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
      await key(),
      encoder.encode(value),
    ),
  );
  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...bytes))}`;
}
export async function decrypt(value: string, context: string) {
  const [iv, data] = value.split(".");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(atob(iv), (c) => c.charCodeAt(0)),
        additionalData: encoder.encode(context),
      },
      await key(),
      Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
    ),
  );
}
export async function verifyShopify(body: string, signature: string | null, secret: string) {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return equalSignature(btoa(String.fromCharCode(...bytes)), signature);
}
