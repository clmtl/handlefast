/// <reference types="vite/client" />

import betterAuthTest from "@convex-dev/better-auth/test";
import type { FunctionArgs, UserIdentity } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { signWebhookBody, verifyWebhookSignature } from "./lib/webhookSignatures";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const issuer = "https://handlefast-test.convex.site";
type InboundWorkerPayload = FunctionArgs<typeof internal.inboundEmails.ingestFromWorker>;

function createTestBackend() {
  const t = convexTest({ schema, modules });
  betterAuthTest.register(t);
  return t;
}

async function createAuthenticatedClient(t: ReturnType<typeof createTestBackend>, seed: string) {
  const now = Date.now();
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: `User ${seed}`,
        email: `${seed}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  })) as { _id: string; email: string; name: string };

  const session = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        token: `session-${seed}`,
        userId: user._id,
        expiresAt: now + 60 * 60 * 1000,
        createdAt: now,
        updatedAt: now,
      },
    },
  })) as { _id: string };

  const tokenIdentifier = `${issuer}|${user._id}`;
  const identity = {
    issuer,
    subject: user._id,
    tokenIdentifier,
    sessionId: session._id,
    email: user.email,
    name: user.name,
  } as Partial<UserIdentity> & { sessionId: string };

  return {
    authUserId: user._id,
    client: t.withIdentity(identity),
    tokenIdentifier,
  };
}

async function createWorkspace(t: ReturnType<typeof createTestBackend>, seed: string) {
  const auth = await createAuthenticatedClient(t, seed);
  const result = await auth.client.mutation(api.onboarding.bootstrap, {
    organizationName: `${seed} Organization`,
    shopName: `${seed} Shop`,
  });

  if (!result.shopId) {
    throw new Error("Expected workspace bootstrap to include a shop id");
  }

  return {
    ...auth,
    ...result,
    shopId: result.shopId,
  };
}

function inboundPayload(
  routeAddress: string,
  overrides: Partial<InboundWorkerPayload> = {},
): InboundWorkerPayload {
  const receivedAt = Date.parse("2026-06-28T12:00:00.000Z");
  return {
    provider: "cloudflare_email_routing" as const,
    deliveryKey: `cloudflare_email_routing:${routeAddress}:message-1`,
    envelopeFrom: "customer@example.com",
    envelopeTo: routeAddress,
    from: { address: "customer@example.com", name: "Customer" },
    to: [{ address: routeAddress }],
    cc: [],
    replyTo: [],
    subject: "Where is my order?",
    text: "Hello, I need help with my order.",
    html: "<p>Hello, I need help with my order.</p>",
    snippet: "Hello, I need help with my order.",
    headers: [
      { name: "message-id", value: "<message-1@example.com>" },
      { name: "subject", value: "Where is my order?" },
    ],
    messageId: "<message-1@example.com>",
    references: [],
    attachments: [],
    receivedAt,
    rawSize: 2048,
    ...overrides,
  };
}

describe("inbound email routing", () => {
  test("creates and exposes an inbound email route during onboarding", async () => {
    const t = createTestBackend();
    const workspace = await createWorkspace(t, "inbound-route");

    const route = await workspace.client.query(api.inboundEmailRoutes.getForShop, {
      shopId: workspace.shopId,
    });
    const viewer = await workspace.client.query(api.viewer.me);

    expect(route?.address).toMatch(/@in\.handlefast\.io$/);
    expect(route?.status).toBe("active");
    expect(viewer.inboundEmailRoutes).toMatchObject([{ _id: route?._id }]);
  });

  test("keeps route provisioning idempotent", async () => {
    const t = createTestBackend();
    const workspace = await createWorkspace(t, "inbound-idempotent");

    const first = await workspace.client.mutation(api.inboundEmailRoutes.ensureForShop, {
      shopId: workspace.shopId,
    });
    const second = await workspace.client.mutation(api.inboundEmailRoutes.ensureForShop, {
      shopId: workspace.shopId,
    });
    const routes = await t.run(async (ctx) => {
      return await ctx.db
        .query("inboundEmailRoutes")
        .withIndex("by_shopId", (q) => q.eq("shopId", workspace.shopId))
        .take(10);
    });

    expect(first._id).toBe(second._id);
    expect(routes).toHaveLength(1);
  });

  test("stores a matched inbound email as a support message", async () => {
    const t = createTestBackend();
    const workspace = await createWorkspace(t, "inbound-store");
    const route = await workspace.client.query(api.inboundEmailRoutes.getForShop, {
      shopId: workspace.shopId,
    });

    if (!route) {
      throw new Error("Expected route");
    }

    const result = await t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(route.address, {
        attachments: [
          {
            contentType: "application/pdf",
            filename: "invoice.pdf",
            size: 1200,
            disposition: "attachment",
          },
        ],
      }),
    );
    const rows = await readSupportRows(t, workspace.shopId);

    expect(result.status).toBe("received");
    expect(rows.deliveries).toMatchObject([{ status: "received", routeId: route._id }]);
    expect(rows.conversations).toMatchObject([
      { customerEmail: "customer@example.com", status: "open" },
    ]);
    expect(rows.messages).toMatchObject([
      {
        attachmentCount: 1,
        direction: "inbound",
        from: { address: "customer@example.com", name: "Customer" },
        subject: "Where is my order?",
      },
    ]);
    expect(rows.attachments).toMatchObject([{ filename: "invoice.pdf" }]);
  });

  test("deduplicates repeated email deliveries", async () => {
    const t = createTestBackend();
    const workspace = await createWorkspace(t, "inbound-duplicate");
    const route = await workspace.client.query(api.inboundEmailRoutes.getForShop, {
      shopId: workspace.shopId,
    });

    if (!route) {
      throw new Error("Expected route");
    }

    const payload = inboundPayload(route.address);
    const first = await t.mutation(internal.inboundEmails.ingestFromWorker, payload);
    const second = await t.mutation(internal.inboundEmails.ingestFromWorker, payload);
    const rows = await readSupportRows(t, workspace.shopId);

    expect(first.status).toBe("received");
    expect(second.status).toBe("duplicate");
    expect(rows.deliveries).toHaveLength(1);
    expect(rows.messages).toHaveLength(1);
  });

  test("records unmatched deliveries without creating support messages", async () => {
    const t = createTestBackend();

    const result = await t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload("unknown@in.handlefast.io"),
    );
    const rows = await t.run(async (ctx) => {
      const deliveries = await ctx.db.query("inboundEmailDeliveries").take(10);
      const messages = await ctx.db.query("supportMessages").take(10);
      return { deliveries, messages };
    });

    expect(result.status).toBe("unmatched");
    expect(rows.deliveries).toMatchObject([{ status: "unmatched" }]);
    expect(rows.messages).toHaveLength(0);
  });

  test("verifies signed Cloudflare Worker webhook payloads", async () => {
    const body = JSON.stringify({ ok: true });
    const secret = "test-secret";
    const timestamp = Date.now().toString();
    const signature = await signWebhookBody(secret, timestamp, body);
    const headers = new Headers({
      "x-handlefast-signature": signature,
      "x-handlefast-timestamp": timestamp,
    });

    await expect(verifyWebhookSignature(headers, body, secret)).resolves.toEqual({ ok: true });
    await expect(verifyWebhookSignature(headers, `${body} `, secret)).resolves.toMatchObject({
      ok: false,
      reason: "WebhookSignatureInvalid",
    });
  });
});

async function readSupportRows(t: ReturnType<typeof createTestBackend>, shopId: Id<"shops">) {
  return await t.run(async (ctx) => {
    const deliveries = await ctx.db
      .query("inboundEmailDeliveries")
      .withIndex("by_shopId_and_receivedAt", (q) => q.eq("shopId", shopId))
      .take(10);
    const conversations = await ctx.db
      .query("supportConversations")
      .withIndex("by_shopId_and_status_and_lastMessageAt", (q) => q.eq("shopId", shopId))
      .take(10);
    const messages = await ctx.db
      .query("supportMessages")
      .withIndex("by_shopId_and_createdAt", (q) => q.eq("shopId", shopId))
      .take(10);
    const attachments = await ctx.db
      .query("emailAttachments")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .take(10);

    return {
      deliveries,
      conversations,
      messages,
      attachments,
    };
  });
}
