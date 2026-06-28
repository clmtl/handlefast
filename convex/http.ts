import type { FunctionArgs } from "convex/server";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { env, httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { verifyWebhookSignature } from "./lib/webhookSignatures";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

http.route({
  path: "/webhooks/cloudflare/email-routing",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await req.text();
    const verification = await verifyWebhookSignature(
      req.headers,
      body,
      env.CLOUDFLARE_EMAIL_WEBHOOK_SECRET,
    );

    if (!verification.ok) {
      const status = verification.reason === "WebhookSecretMissing" ? 500 : 401;
      return jsonResponse({ error: verification.reason }, status);
    }

    let payload: FunctionArgs<typeof internal.inboundEmails.ingestFromWorker>;

    try {
      payload = JSON.parse(body);
    } catch {
      return jsonResponse({ error: "InvalidJsonPayload" }, 400);
    }

    const result = await ctx.runMutation(internal.inboundEmails.ingestFromWorker, payload);

    return jsonResponse(result, 202);
  }),
});

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
    },
    status,
  });
}

export default http;
