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

    expect(route?.address).toMatch(/@handlefast\.io$/);
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

    expect(first).not.toBeNull();
    expect(first?._id).toBe(second?._id);
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
      inboundPayload("unknown@handlefast.io"),
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

async function setupInbound(seed: string, t = createTestBackend()) {
  const workspace = await createWorkspace(t, seed);
  const route = await workspace.client.query(api.inboundEmailRoutes.getForShop, {
    shopId: workspace.shopId,
  });
  if (!route) throw new Error("Expected route");
  return { t, workspace, route };
}

describe("inbound email regression coverage", () => {
  test("retries a previously unmatched delivery after the route is restored", async () => {
    const { t, route } = await setupInbound("retry");
    const payload = inboundPayload(route.address);
    await t.run((ctx) => ctx.db.patch(route._id, { status: "disabled" }));
    const unmatched = await t.mutation(internal.inboundEmails.ingestFromWorker, payload);
    expect(unmatched.status).toBe("unmatched");
    expect((await t.mutation(internal.inboundEmails.ingestFromWorker, payload)).status).toBe(
      "unmatched",
    );
    await t.run((ctx) => ctx.db.patch(route._id, { status: "active" }));
    const recovered = await t.mutation(internal.inboundEmails.ingestFromWorker, payload);
    expect(recovered.status).toBe("received");
    expect(recovered.deliveryId).toBe(unmatched.deliveryId);
    expect((await t.mutation(internal.inboundEmails.ingestFromWorker, payload)).status).toBe(
      "duplicate",
    );
    const delivery = await t.run((ctx) => ctx.db.get(recovered.deliveryId));
    expect(delivery?.status).toBe("received");
    expect(delivery?.error).toBeUndefined();
  });

  test("keeps unrelated messages from the same customer in separate conversations", async () => {
    const { t, route } = await setupInbound("separate");
    const first = await t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(route.address),
    );
    const second = await t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(route.address, {
        deliveryKey: "second-issue",
        messageId: "<second@example.com>",
        subject: "Refund for another order",
      }),
    );
    if (first.status !== "received" || second.status !== "received")
      throw new Error("Expected received");
    expect(first.conversationId).not.toBe(second.conversationId);
  });

  test("finds references in the correct shop and reopens the closed conversation", async () => {
    const { t, route: a } = await setupInbound("thread-a");
    const { route: b } = await setupInbound("thread-b", t);
    await t.mutation(internal.inboundEmails.ingestFromWorker, inboundPayload(a.address));
    const original = await t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(b.address),
    );
    if (original.status !== "received") throw new Error("Expected received");
    await t.run((ctx) => ctx.db.patch(original.conversationId, { status: "closed" }));
    const reply = await t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(b.address, {
        deliveryKey: "reply-b",
        messageId: "<reply-b@example.com>",
        inReplyTo: "<message-1@example.com>",
      }),
    );
    if (reply.status !== "received") throw new Error("Expected received");
    expect(reply.conversationId).toBe(original.conversationId);
    expect((await t.run((ctx) => ctx.db.get(original.conversationId)))?.status).toBe("open");
  });

  test("ignores references belonging only to another shop", async () => {
    const { t, route: a } = await setupInbound("foreign-a");
    const { route: b } = await setupInbound("foreign-b", t);
    const original = await t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(a.address),
    );
    const reply = await t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(b.address, {
        deliveryKey: "foreign-reply",
        messageId: "<foreign-reply@example.com>",
        inReplyTo: "<message-1@example.com>",
      }),
    );
    if (original.status !== "received" || reply.status !== "received")
      throw new Error("Expected received");
    expect(reply.conversationId).not.toBe(original.conversationId);
  });

  test("uses the closest reference when no In-Reply-To is provided", async () => {
    const { t, route } = await setupInbound("closest");
    await t.mutation(internal.inboundEmails.ingestFromWorker, inboundPayload(route.address));
    const second = await t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(route.address, {
        deliveryKey: "second",
        messageId: "<second@example.com>",
      }),
    );
    const reply = await t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(route.address, {
        deliveryKey: "closest-reply",
        messageId: "<closest-reply@example.com>",
        references: ["<message-1@example.com>", "<second@example.com>"],
      }),
    );
    if (second.status !== "received" || reply.status !== "received")
      throw new Error("Expected received");
    expect(reply.conversationId).toBe(second.conversationId);
  });

  test("records server receipt time separately from sender time", async () => {
    const { t, workspace, route } = await setupInbound("clock");
    const before = Date.now();
    const sentAt = Date.parse("2001-01-01T00:00:00Z");
    await t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(route.address, { receivedAt: sentAt, sentAt }),
    );
    const rows = await readSupportRows(t, workspace.shopId);
    expect(rows.messages[0].receivedAt).toBeGreaterThanOrEqual(before);
    expect(rows.messages[0].sentAt).toBe(sentAt);
    expect(rows.conversations[0].lastMessageAt).toBe(rows.messages[0].receivedAt);
    expect(rows.deliveries[0].receivedAt).toBe(rows.messages[0].receivedAt);
  });

  test.each([
    "agent",
    "viewer",
  ] as const)("%s cannot provision through onboarding or route management", async (role) => {
    const { t, workspace, route } = await setupInbound(`role-${role}`);
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("memberships")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", workspace.organizationId))
        .first();
      if (!member) throw new Error("Expected membership");
      await ctx.db.patch(member._id, { role });
      await ctx.db.delete(route._id);
    });
    await expect(
      workspace.client.mutation(api.inboundEmailRoutes.ensureForShop, { shopId: workspace.shopId }),
    ).rejects.toThrow("Forbidden");
    await workspace.client.mutation(api.onboarding.bootstrap, {});
    expect(
      await workspace.client.query(api.inboundEmailRoutes.getForShop, { shopId: workspace.shopId }),
    ).toBeNull();
  });

  test.each([
    "owner",
    "admin",
  ] as const)("%s can provision a legacy shop without a route", async (role) => {
    const { t, workspace, route } = await setupInbound(`legacy-${role}`);
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("memberships")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", workspace.organizationId))
        .first();
      if (!member) throw new Error("Expected membership");
      await ctx.db.patch(member._id, { role });
      await ctx.db.delete(route._id);
    });
    expect(
      await workspace.client.mutation(api.inboundEmailRoutes.ensureForShop, {
        shopId: workspace.shopId,
      }),
    ).toMatchObject({ status: "active" });
  });

  test.each(["disabled", "rotated"] as const)("does not replace a %s route", async (status) => {
    const { t, workspace, route } = await setupInbound(`route-${status}`);
    await t.run((ctx) => ctx.db.patch(route._id, { status }));
    await workspace.client.mutation(api.onboarding.bootstrap, {});
    expect(
      await workspace.client.mutation(api.inboundEmailRoutes.ensureForShop, {
        shopId: workspace.shopId,
      }),
    ).toBeNull();
    const routes = await t.run((ctx) =>
      ctx.db
        .query("inboundEmailRoutes")
        .withIndex("by_shopId", (q) => q.eq("shopId", workspace.shopId))
        .take(5),
    );
    expect(routes).toHaveLength(1);
    expect(routes[0].status).toBe(status);
  });

  test("disabled shops do not receive messages or provision routes", async () => {
    const { t, workspace, route } = await setupInbound("disabled-shop");
    await t.run((ctx) => ctx.db.patch(workspace.shopId, { status: "disabled" }));
    expect(
      (await t.mutation(internal.inboundEmails.ingestFromWorker, inboundPayload(route.address)))
        .status,
    ).toBe("unmatched");
    expect(
      await workspace.client.mutation(api.inboundEmailRoutes.ensureForShop, {
        shopId: workspace.shopId,
      }),
    ).toBeNull();
    expect((await readSupportRows(t, workspace.shopId)).messages).toHaveLength(0);
  });

  test("requires authentication and organization membership for route access", async () => {
    const { t, workspace: a } = await setupInbound("access-a");
    const { workspace: b } = await setupInbound("access-b", t);
    await expect(t.query(api.inboundEmailRoutes.getForShop, { shopId: a.shopId })).rejects.toThrow(
      "Unauthenticated",
    );
    await expect(
      a.client.query(api.inboundEmailRoutes.getForShop, { shopId: b.shopId }),
    ).rejects.toThrow("Forbidden");
    await expect(
      a.client.mutation(api.inboundEmailRoutes.ensureForShop, { shopId: b.shopId }),
    ).rejects.toThrow("Forbidden");
  });
});
