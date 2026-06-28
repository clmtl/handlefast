import * as Sentry from "@sentry/cloudflare";
import handler from "@tanstack/react-start/server-entry";
import {
  buildCloudflareEmailRoutingPayload,
  maxInboundEmailRawBytes,
} from "./lib/cloudflare-email-routing";
import { signEmailWebhookBody } from "./lib/email-webhook-signature";

const workerHandler = {
  fetch(request: Request) {
    return handler.fetch(request);
  },
  async email(message, env) {
    if (message.rawSize > maxInboundEmailRawBytes) {
      message.setReject("Email is too large for HandleFast ingestion.");
      return;
    }

    const convexSiteUrl = env.CONVEX_SITE_URL;
    const webhookSecret = env.CLOUDFLARE_EMAIL_WEBHOOK_SECRET;

    if (!convexSiteUrl || !webhookSecret) {
      throw new Error("Cloudflare email routing is missing Convex webhook configuration.");
    }

    const payload = await buildCloudflareEmailRoutingPayload(message);
    const body = JSON.stringify(payload);
    const timestamp = Date.now().toString();
    const signature = await signEmailWebhookBody(webhookSecret, timestamp, body);
    const endpoint = new URL("/webhooks/cloudflare/email-routing", convexSiteUrl);
    const response = await fetch(endpoint, {
      body,
      headers: {
        "Content-Type": "application/json",
        "x-handlefast-signature": signature,
        "x-handlefast-timestamp": timestamp,
      },
      method: "POST",
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(
        `Convex email ingestion failed: ${response.status} ${responseBody.slice(0, 200)}`,
      );
    }
  },
} satisfies ExportedHandler<Env>;

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: getServerTraceSampleRate(env),
  }),
  workerHandler,
);

function getServerTraceSampleRate(env: Env) {
  const configuredRate = Number(env.SENTRY_TRACES_SAMPLE_RATE);

  if (Number.isFinite(configuredRate) && configuredRate >= 0 && configuredRate <= 1) {
    return configuredRate;
  }

  return 0.1;
}
