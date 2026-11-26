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
  // The shared receiving worker selects the deployment before reading the email.
  const production = message.to.toLowerCase().startsWith("hf_prod_");
  const site = production ? env.PRODUCTION_CONVEX_SITE_URL : env.CONVEX_SITE_URL;
  const secret = production
    ? env.PRODUCTION_EMAIL_WEBHOOK_SECRET
    : env.CLOUDFLARE_EMAIL_WEBHOOK_SECRET;
  if (!site || !secret)
    throw new Error("Cloudflare email routing is missing Convex webhook configuration.");
  const raw = await new Response(message.raw).arrayBuffer();
  if (raw.byteLength > MAX_EMAIL_BYTES) {
    message.setReject("Email exceeds the 25 MiB limit, including attachments.");
    return;
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const sha256 = btoa(String.fromCharCode(...hash));
  const reserved = await signedRequest(site, secret, "reserve", {
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
  const completed = await signedRequest(site, secret, "complete", {
    receiptId: reserved.receiptId,
    storageId: result.storageId,
  });
  if (completed.status !== "accepted") throw new Error("Email upload was not committed");
}

async function signedRequest(
  site: string,
  secret: string,
  operation: "reserve" | "complete",
  payload: unknown,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ operation, ...(payload as Record<string, unknown>) });
  const timestamp = String(Date.now());
  const response = await fetch(new URL("/webhooks/cloudflare/email-routing", site), {
    method: "POST",
    body,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Content-Type": "application/json",
      "x-handlefast-timestamp": timestamp,
      "x-handlefast-signature": await signEmailWebhookBody(secret, timestamp, body),
    },
  });
  if (!response.ok) throw new Error(`Convex email ingestion failed: ${response.status}`);
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("status" in result))
    throw new Error("Invalid Convex email ingestion response");
  return result as Record<string, unknown>;
}
