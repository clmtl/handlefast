import type { FunctionArgs } from "convex/server";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { env, httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { shopifyWebhook, trackingWebhook } from "./commerceHttp";
import { equalSignature, sha256 } from "./lib/commerceSecrets";
import { trackingPage, trackingResult } from "./lib/storefrontTrackingPage";
import { verifyWebhookSignature } from "./lib/webhookSignatures";
import { takeoutMessage } from "./takeoutHttp";

const http = httpRouter();
const maxWebhookBytes = 16_384;

authComponent.registerRoutes(http, createAuth);
http.route({ path: "/takeout/message", method: "POST", handler: takeoutMessage });
http.route({ path: "/webhooks/shopify", method: "POST", handler: shopifyWebhook });
http.route({ path: "/webhooks/17track", method: "POST", handler: trackingWebhook });

const storefrontTrackingPath = "/storefront/tracking-pilot";
http.route({
  path: storefrontTrackingPath,
  method: "GET",
  handler: httpAction(async () =>
    env.STOREFRONT_TRACKING_PILOT ? trackingPage() : new Response(null, { status: 404 }),
  ),
});
http.route({
  path: storefrontTrackingPath,
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const config = env.STOREFRONT_TRACKING_PILOT;
    if (!config) return new Response(null, { status: 404 });
    if (req.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded")
      return new Response(null, { status: 415 });

    const body = await readWebhookBody(req);
    if (body === null) return new Response(null, { status: 413 });
    const form = new URLSearchParams(body);
    const code = form.get("code")?.trim() ?? "";
    const [digest, ...pilotNumbers] = config.split(":");
    if (!code || code.length > 128 || !equalSignature(await sha256(code), digest))
      return trackingPage('<p class="message" role="alert">Code d’accès incorrect.</p>', 403);

    const number = form.get("tracking")?.trim().toUpperCase() ?? "";
    if (!/^[A-Z0-9-]{6,64}$/.test(number))
      return trackingPage('<p class="message" role="alert">Vérifie le numéro de suivi.</p>', 400);

    const shipment = pilotNumbers.includes(number)
      ? await ctx.runQuery(internal.storefrontTracking.lookup, { number })
      : null;
    return shipment
      ? trackingPage(trackingResult(shipment), 200, number)
      : trackingPage(
          '<p class="message" role="alert">Aucun suivi disponible pour ce numéro.</p>',
          404,
          number,
        );
  }),
});

http.route({
  path: "/webhooks/cloudflare/email-routing",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (Number(req.headers.get("content-length")) > maxWebhookBytes)
      return jsonResponse({ error: "PayloadTooLarge" }, 413);
    const body = await readWebhookBody(req);
    if (body === null) return jsonResponse({ error: "PayloadTooLarge" }, 413);
    const verification = await verifyWebhookSignature(
      req.headers,
      body,
      env.CLOUDFLARE_EMAIL_WEBHOOK_SECRET,
    );

    if (!verification.ok) {
      const status = verification.reason === "WebhookSecretMissing" ? 500 : 401;
      return jsonResponse({ error: verification.reason }, status);
    }

    let payload: unknown;

    try {
      payload = JSON.parse(body);
    } catch {
      return jsonResponse({ error: "InvalidJsonPayload" }, 400);
    }

    if (!payload || typeof payload !== "object" || !("operation" in payload))
      return jsonResponse({ error: "InvalidOperation" }, 400);
    const { operation, ...args } = payload as Record<string, unknown>;
    if (operation === "reserve") {
      if (!isReservation(args)) return jsonResponse({ error: "InvalidReservation" }, 400);
      const result = await ctx.runMutation(internal.emailReceipts.reserve, args);
      return jsonResponse(result, 200);
    }
    if (operation === "complete") {
      if (
        typeof args.receiptId !== "string" ||
        typeof args.storageId !== "string" ||
        Object.keys(args).length !== 2
      )
        return jsonResponse({ error: "InvalidCompletion" }, 400);
      const result = await ctx.runMutation(
        internal.emailReceipts.completeUpload,
        args as FunctionArgs<typeof internal.emailReceipts.completeUpload>,
      );
      return jsonResponse(result, 202);
    }
    return jsonResponse({ error: "InvalidOperation" }, 400);
  }),
});

async function readWebhookBody(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return body + decoder.decode();
      size += value.byteLength;
      if (size > maxWebhookBytes) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
    },
    status,
  });
}

export default http;

function isReservation(
  value: Record<string, unknown>,
): value is FunctionArgs<typeof internal.emailReceipts.reserve> {
  return (
    Object.keys(value).length === 4 &&
    typeof value.envelopeFrom === "string" &&
    typeof value.envelopeTo === "string" &&
    typeof value.sha256 === "string" &&
    typeof value.rawSize === "number"
  );
}
