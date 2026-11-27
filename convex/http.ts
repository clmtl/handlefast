import type { FunctionArgs } from "convex/server";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { env, httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { shopifyWebhook, trackingWebhook } from "./commerceHttp";
import { normalizedEmail } from "./lib/commerceModel";
import { deliveryMap } from "./lib/storefrontDeliveryMap";
import { storefrontLanguage } from "./lib/storefrontTrackingLanguage";
import { trackingMessage, trackingPage, trackingResult } from "./lib/storefrontTrackingPage";
import { verifyWebhookSignature } from "./lib/webhookSignatures";
import { storefrontPilotDomain } from "./storefrontTracking";
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
  handler: httpAction(async (_ctx, req) => {
    if (env.STOREFRONT_TRACKING_PILOT !== storefrontPilotDomain)
      return new Response(null, { status: 404 });
    const params = new URL(req.url).searchParams;
    return trackingPage(storefrontLanguage(params.get("lang")), "", 200, params.get("accent"));
  }),
});
http.route({
  path: storefrontTrackingPath,
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (env.STOREFRONT_TRACKING_PILOT !== storefrontPilotDomain)
      return new Response(null, { status: 404 });
    if (req.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded")
      return new Response(null, { status: 415 });

    const body = await readWebhookBody(req);
    if (body === null) return new Response(null, { status: 413 });
    const form = new URLSearchParams(body);
    const params = new URL(req.url).searchParams;
    const language = storefrontLanguage(params.get("lang"));
    const accent = params.get("accent");
    const { text } = language;
    const message = (content: keyof typeof text, status = 200) =>
      trackingPage(language, trackingMessage(text[content], status >= 400), status, accent);
    const mode = form.get("mode");
    const number = form.get("number")?.trim() ?? "";
    const email = normalizedEmail(form.get("email"));
    if (mode !== "tracking" && mode !== "order") return message("choose", 400);
    if (mode === "tracking" && !/^[a-z0-9 _-]{3,128}$/i.test(number))
      return message("invalidTracking", 400);
    if (
      mode === "order" &&
      (!number.replace(/^#/, "") ||
        number.length > 64 ||
        /\p{Cc}/u.test(number) ||
        !email ||
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    )
      return message("invalidOrder", 400);

    const search =
      mode === "order" && email
        ? ({ mode, number, email } as const)
        : ({ mode: "tracking", number } as const);
    const result = await ctx.runMutation(internal.storefrontTracking.lookup, { search });
    switch (result.kind) {
      case "limited":
        return message("limited", 429);
      case "missing":
        return message(mode === "order" ? "missingOrder" : "missingTracking", 404);
      case "pending":
      case "noTracking":
      case "cancelled":
        return message(result.kind);
      case "parcels":
        return trackingPage(
          language,
          trackingResult(language, result.parcels, await deliveryMap(result.destination)),
          200,
          accent,
        );
    }
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
