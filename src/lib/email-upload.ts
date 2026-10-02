import { MAX_EMAIL_BYTES, RAW_EMAIL_CONTENT_TYPE } from "../../convex/lib/emailPolicy";
import { signEmailWebhookBody } from "./email-webhook-signature";

export async function uploadIncomingEmail(
  message: {
    from: string;
    to: string;
    raw: ReadableStream<Uint8Array>;
    rawSize: number;
    setReject: (reason: string) => void;
  },
  env: Env,
) {
  if (message.rawSize > MAX_EMAIL_BYTES) {
    message.setReject("Email exceeds the 25 MiB limit, including attachments.");
    return;
  }
  if (!env.CONVEX_SITE_URL || !env.CLOUDFLARE_EMAIL_WEBHOOK_SECRET)
    throw new Error("Cloudflare email routing is missing Convex webhook configuration.");
  const raw = await new Response(message.raw).arrayBuffer();
  if (raw.byteLength > MAX_EMAIL_BYTES) {
    message.setReject("Email exceeds the 25 MiB limit, including attachments.");
    return;
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const sha256 = btoa(String.fromCharCode(...hash));
  const reserved = await signedRequest(env, "reserve", {
    envelopeFrom: message.from,
    envelopeTo: message.to,
    rawSize: raw.byteLength,
    sha256,
  });
  if (reserved.status === "rejected") {
    message.setReject("This HandleFast address is not accepting email.");
    return;
  }
  if (reserved.status === "accepted") return;
  if (
    reserved.status !== "upload" ||
    typeof reserved.uploadUrl !== "string" ||
    typeof reserved.receiptId !== "string"
  )
    throw new Error("Invalid email upload reservation");
  const upload = await fetch(reserved.uploadUrl, {
    method: "POST",
    headers: { "Content-Type": RAW_EMAIL_CONTENT_TYPE },
    body: raw,
    signal: AbortSignal.timeout(110_000),
  });
  if (!upload.ok) throw new Error(`Email upload failed: ${upload.status}`);
  const result: unknown = await upload.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("storageId" in result) ||
    typeof result.storageId !== "string"
  )
    throw new Error("Invalid email upload result");
  const completed = await signedRequest(env, "complete", {
    receiptId: reserved.receiptId,
    storageId: result.storageId,
  });
  if (completed.status !== "accepted") throw new Error("Email upload was not committed");
}

async function signedRequest(
  env: Env,
  operation: "reserve" | "complete",
  payload: unknown,
): Promise<Record<string, unknown>> {
  if (!env.CONVEX_SITE_URL || !env.CLOUDFLARE_EMAIL_WEBHOOK_SECRET)
    throw new Error("Missing email configuration");
  const body = JSON.stringify({ operation, ...(payload as Record<string, unknown>) });
  const timestamp = String(Date.now());
  const response = await fetch(new URL("/webhooks/cloudflare/email-routing", env.CONVEX_SITE_URL), {
    method: "POST",
    body,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Content-Type": "application/json",
      "x-handlefast-timestamp": timestamp,
      "x-handlefast-signature": await signEmailWebhookBody(
        env.CLOUDFLARE_EMAIL_WEBHOOK_SECRET,
        timestamp,
        body,
      ),
    },
  });
  if (!response.ok) throw new Error(`Convex email ingestion failed: ${response.status}`);
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("status" in result))
    throw new Error("Invalid Convex email ingestion response");
  return result as Record<string, unknown>;
}
