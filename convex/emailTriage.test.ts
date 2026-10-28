/// <reference types="vite/client" />
import betterAuthTest from "@convex-dev/better-auth/test";
import type { UserIdentity } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import { guardedDecision, reviewDecision, TRIAGE_VERSION } from "./lib/emailTriagePolicy";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const issuer = "https://handlefast-test.convex.site";

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

afterEach(() => vi.unstubAllEnvs());

async function fixture(bucket: "sav" | "review" | "other" = "review") {
  const t = createTestBackend();
  const workspace = await createWorkspace(t, "triage");
  const route = await workspace.client.query(api.inboundEmailRoutes.getForShop, {
    shopId: workspace.shopId,
  });
  if (!route) throw new Error("Missing route");
  const receiptId = await t.run((ctx) =>
    ctx.db.insert("emailReceipts", {
      organizationId: workspace.organizationId,
      shopId: workspace.shopId,
      routeId: route._id,
      key: "test-key",
      envelopeFrom: "customer@example.com",
      envelopeTo: route.address,
      sha256: "hash",
      rawSize: 100,
      receivedAt: Date.now(),
      expiresAt: Date.now() + 86400000,
      status: "processing",
      attempts: 1,
      nextAttemptAt: Date.now() + 300000,
      updatedAt: Date.now(),
    }),
  );
  const payload = {
    provider: "cloudflare_email_routing" as const,
    deliveryKey: "test-key",
    envelopeFrom: "customer@example.com",
    envelopeTo: route.address,
    from: { address: "customer@example.com" },
    to: [{ address: route.address }],
    cc: [],
    replyTo: [],
    subject: "Where is my order?",
    text: "I bought it last week.",
    headers: [],
    references: [],
    messageId: "<first@example.com>",
    attachments: [{ filename: "photo.png", contentType: "image/png", size: 50 }],
    receivedAt: Date.now(),
    rawSize: 100,
    receiptId,
    processingAttempt: 1,
    triage: { bucket, reason: "unclear", source: "ai" as const, version: TRIAGE_VERSION },
  };
  const result = await t.mutation(internal.inboundEmails.ingestFromWorker, payload);
  return { t, workspace, route, receiptId, payload, result };
}

describe("SAV triage", () => {
  test("retains non-SAV message and attachments without creating a conversation; retries are idempotent", async () => {
    const f = await fixture("other");
    expect(f.result.status).toBe("filtered");
    expect(await f.t.run((ctx) => ctx.db.query("supportConversations").take(10))).toHaveLength(0);
    expect(await f.t.run((ctx) => ctx.db.query("emailAttachments").take(10))).toHaveLength(1);
    const receipt = await f.t.run((ctx) => ctx.db.get(f.receiptId));
    expect(receipt).toMatchObject({
      status: "processed",
      triage: { bucket: "other" },
      automaticTriage: { bucket: "other" },
    });
    const page = await f.workspace.client.query(api.emailTriage.list, {
      shopId: f.workspace.shopId,
      bucket: "other",
      asOf: Date.now(),
      paginationOpts: { cursor: null, numItems: 25 },
    });
    expect(page.page[0]).toMatchObject({ id: f.receiptId, subject: "Where is my order?" });
    expect(
      (
        await f.t.mutation(internal.inboundEmails.ingestFromWorker, {
          ...f.payload,
          receiptId: undefined,
          processingAttempt: undefined,
        })
      ).status,
    ).toBe("duplicate");
    expect(await f.t.run((ctx) => ctx.db.query("supportMessages").take(10))).toHaveLength(1);
  });

  test("reply context is restricted to the same shop, same sender and unexpired messages", async () => {
    const f = await fixture("sav");
    const args = {
      receiptId: f.receiptId,
      now: Date.now(),
      subject: "Re: help",
      from: "customer@example.com",
      to: [f.route.address],
      references: ["<first@example.com>"],
    };
    expect((await f.t.query(internal.emailTriage.context, args)).previous).toContain(
      "I bought it last week",
    );
    expect(
      (await f.t.query(internal.emailTriage.context, { ...args, from: "outsider@example.com" }))
        .previous,
    ).toBe("");
    expect(
      (await f.t.query(internal.emailTriage.context, { ...args, now: Date.now() + 2 * 86400000 }))
        .previous,
    ).toBe("");
  });

  test("manual correction creates and removes SAV conversations without deleting message content or attachments", async () => {
    const f = await fixture();
    await f.workspace.client.mutation(api.emailTriage.reclassify, {
      receiptId: f.receiptId,
      bucket: "sav",
    });
    let messages = await f.t.run((ctx) => ctx.db.query("supportMessages").take(10));
    expect(messages[0].conversationId).toBeDefined();
    await f.workspace.client.mutation(api.emailTriage.reclassify, {
      receiptId: f.receiptId,
      bucket: "other",
    });
    messages = await f.t.run((ctx) => ctx.db.query("supportMessages").take(10));
    expect(messages[0]).toMatchObject({ text: "I bought it last week." });
    expect(messages[0].conversationId).toBeUndefined();
    expect(await f.t.run((ctx) => ctx.db.query("supportConversations").take(10))).toHaveLength(0);
    expect(await f.t.run((ctx) => ctx.db.get(f.receiptId))).toMatchObject({
      triage: { source: "manual", bucket: "other" },
      automaticTriage: { bucket: "review" },
    });
    expect(await f.t.run((ctx) => ctx.db.query("emailAttachments").take(10))).toHaveLength(1);
  });

  test("filtered replies do not reopen an existing SAV conversation", async () => {
    const f = await fixture("sav");
    if (f.result.status !== "received") throw new Error("Expected SAV");
    const conversationId = f.result.conversationId;
    await f.t.run((ctx) => ctx.db.patch(conversationId, { status: "closed" }));
    await f.t.mutation(internal.inboundEmails.ingestFromWorker, {
      ...f.payload,
      receiptId: undefined,
      processingAttempt: undefined,
      deliveryKey: "reply",
      messageId: "<reply@example.com>",
      inReplyTo: "<first@example.com>",
      triage: reviewDecision("unclear"),
    });
    expect(await f.t.run((ctx) => ctx.db.get(conversationId))).toMatchObject({ status: "closed" });
  });

  test("forbids unauthenticated, cross-shop and viewer corrections", async () => {
    const f = await fixture();
    const outsider = await createWorkspace(f.t, "outsider");
    await expect(
      f.t.mutation(api.emailTriage.reclassify, { receiptId: f.receiptId, bucket: "sav" }),
    ).rejects.toThrow();
    await expect(
      outsider.client.mutation(api.emailTriage.reclassify, {
        receiptId: f.receiptId,
        bucket: "sav",
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      outsider.client.query(api.emailTriage.list, {
        shopId: f.workspace.shopId,
        bucket: "review",
        asOf: Date.now(),
        paginationOpts: { cursor: null, numItems: 25 },
      }),
    ).rejects.toThrow("Forbidden");
    await f.t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", f.workspace.organizationId))
        .first();
      if (membership) await ctx.db.patch(membership._id, { role: "viewer" });
    });
    await expect(
      f.workspace.client.mutation(api.emailTriage.reclassify, {
        receiptId: f.receiptId,
        bucket: "sav",
      }),
    ).rejects.toThrow("Forbidden");
  });

  test("connection test emails stay accessible outside SAV and cannot be moved", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.patch(f.receiptId, {
        triage: { bucket: "setup", reason: "connection", source: "rules", version: 1 },
      }),
    );
    await expect(
      f.workspace.client.mutation(api.emailTriage.reclassify, {
        receiptId: f.receiptId,
        bucket: "sav",
      }),
    ).rejects.toThrow("ConnectionEmail");
  });

  test("budget reservations enforce a global monthly limit and fail closed for bad configuration", async () => {
    const t = createTestBackend();
    vi.stubEnv("EMAIL_TRIAGE_MONTHLY_BUDGET_USD", "0.02");
    expect(await t.mutation(internal.emailTriage.reserveBudget, {})).toBe(true);
    expect(await t.mutation(internal.emailTriage.reserveBudget, {})).toBe(true);
    expect(await t.mutation(internal.emailTriage.reserveBudget, {})).toBe(false);
    vi.stubEnv("EMAIL_TRIAGE_MONTHLY_BUDGET_USD", "invalid");
    expect(await t.mutation(internal.emailTriage.reserveBudget, {})).toBe(false);
  });

  test("uncertain or contradictory model outputs always go to review", () => {
    expect(
      guardedDecision({ bucket: "other", confidence: 0.94, reasonCode: "promotion" }).bucket,
    ).toBe("review");
    expect(
      guardedDecision({ bucket: "other", confidence: 1, reasonCode: "post_purchase" }).bucket,
    ).toBe("review");
    expect(
      guardedDecision({ bucket: "sav", confidence: 0.9, reasonCode: "post_purchase" }).bucket,
    ).toBe("sav");
  });
});
