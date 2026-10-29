import { ConvexError } from "convex/values";
import { equalSignature } from "./commerceSecrets";

export function parseOAuthCallback(raw: string) {
  if (raw.length > 8192) throw new ConvexError("ShopifyInvalidCallback");
  const params = new URLSearchParams(raw),
    seen = new Set<string>();
  for (const [key] of params) {
    if (seen.has(key)) throw new ConvexError("ShopifyInvalidCallback");
    seen.add(key);
  }
  const state = params.get("state") ?? "",
    code = params.get("code") ?? "",
    shop = params.get("shop") ?? "",
    hmac = params.get("hmac") ?? "",
    timestamp = params.get("timestamp") ?? "";
  if (
    !/^[a-f0-9]{64}$/.test(state) ||
    !code ||
    code.length > 1024 ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ||
    !/^[a-f0-9]{64}$/i.test(hmac) ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
  )
    throw new ConvexError("ShopifyInvalidCallback");
  return { state, code, shop, hmac, timestamp };
}
export async function verifyOAuthCallback(raw: string, secret: string) {
  const { hmac } = parseOAuthCallback(raw),
    params = new URLSearchParams(raw);
  params.delete("hmac");
  params.delete("signature");
  const message = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const encoder = new TextEncoder(),
    key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return equalSignature(
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
    hmac.toLowerCase(),
  );
}
