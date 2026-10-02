const signatureHeaderPrefix = "sha256=";
const maxClockSkewMs = 5 * 60 * 1000;

export async function signWebhookBody(secret: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );

  return `${signatureHeaderPrefix}${bufferToHex(signature)}`;
}

export async function verifyWebhookSignature(
  headers: Headers,
  body: string,
  secret: string | undefined,
) {
  if (!secret) {
    return { ok: false as const, reason: "WebhookSecretMissing" };
  }

  const timestamp = headers.get("x-handlefast-timestamp");
  const signature = headers.get("x-handlefast-signature");

  if (!timestamp || !signature) {
    return { ok: false as const, reason: "WebhookSignatureMissing" };
  }

  const timestampMs = Number(timestamp);

  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > maxClockSkewMs) {
    return { ok: false as const, reason: "WebhookTimestampInvalid" };
  }

  const expectedSignature = await signWebhookBody(secret, timestamp, body);

  if (!timingSafeEqual(signature, expectedSignature)) {
    return { ok: false as const, reason: "WebhookSignatureInvalid" };
  }

  return { ok: true as const };
}

function timingSafeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

function bufferToHex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
