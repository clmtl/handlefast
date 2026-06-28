import { describe, expect, test } from "vitest";
import { buildCloudflareEmailRoutingPayload } from "./cloudflare-email-routing";

describe("Cloudflare email routing payload", () => {
  test("parses a raw MIME email into the Convex ingestion payload", async () => {
    const rawEmail = [
      "From: Customer <customer@example.com>",
      "To: hf_shop@in.handlefast.io",
      "Reply-To: Customer Replies <reply@example.com>",
      "Message-ID: <order-help@example.com>",
      "Subject: Order help",
      "Date: Sun, 28 Jun 2026 12:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello HandleFast, where is my order?",
    ].join("\r\n");
    const rawSize = new TextEncoder().encode(rawEmail).byteLength;
    const raw = new Response(rawEmail).body;

    if (!raw) {
      throw new Error("Expected Response body");
    }

    const payload = await buildCloudflareEmailRoutingPayload({
      from: "customer@example.com",
      to: "hf_shop@in.handlefast.io",
      headers: new Headers(),
      raw,
      rawSize,
    });

    expect(payload).toMatchObject({
      deliveryKey: "cloudflare_email_routing:hf_shop@in.handlefast.io:<order-help@example.com>",
      envelopeFrom: "customer@example.com",
      envelopeTo: "hf_shop@in.handlefast.io",
      from: { address: "customer@example.com", name: "Customer" },
      messageId: "<order-help@example.com>",
      provider: "cloudflare_email_routing",
      replyTo: [{ address: "reply@example.com", name: "Customer Replies" }],
      subject: "Order help",
      text: "Hello HandleFast, where is my order?",
    });
    expect(payload.receivedAt).toBe(Date.parse("2026-06-28T12:00:00.000Z"));
  });
});
