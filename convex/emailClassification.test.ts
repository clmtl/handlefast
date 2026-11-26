/// <reference types="vite/client" />
import betterAuthTest from "@convex-dev/better-auth/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import { classifySupportEmail } from "./lib/emailClassificationModel";
import {
  type Classification,
  classificationFallback,
  classificationPrompt,
  guardClassification,
} from "./lib/emailClassificationPolicy";
import schema from "./schema";

vi.mock("./lib/emailClassificationModel", () => ({ classifySupportEmail: vi.fn() }));
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const model = vi.mocked(classifySupportEmail);
const automatic: Classification = {
  category: "damaged_item",
  priority: "high",
  reason: "Article inutilisable à réception.",
  needsReview: false,
  confidence: 0.98,
  source: "ai",
  model: "gpt-6-luna",
  version: 1,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
  model.mockReset();
  model.mockResolvedValue(automatic);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function createBackend() {
  const t = convexTest({ schema, modules });
  betterAuthTest.register(t);
  return t;
}

async function workspace(t: ReturnType<typeof createBackend>, seed: string) {
  const now = Date.now();
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: seed,
        email: `${seed}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  })) as { _id: string };
  const session = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        token: `session-${seed}`,
        userId: user._id,
        expiresAt: now + 3600000,
        createdAt: now,
        updatedAt: now,
      },
    },
  })) as { _id: string };
  const client = t.withIdentity({
    issuer: "https://test.convex.site",
    subject: user._id,
    tokenIdentifier: `https://test.convex.site|${user._id}`,
    sessionId: session._id,
  });
  const result = await client.mutation(api.onboarding.bootstrap, {
    organizationName: seed,
    shopName: seed,
  });
  if (!result.shopId) throw new Error("Missing shop");
  return { ...result, shopId: result.shopId, client };
}

async function fixture(
  bucket: "sav" | "review" | "other" = "sav",
  text = "Mon article est arrivé cassé, je ne peux pas l’utiliser.",
) {
  const t = createBackend();
  const shop = await workspace(t, "classification");
  const route = await shop.client.query(api.inboundEmailRoutes.getForShop, { shopId: shop.shopId });
  if (!route) throw new Error("Missing route");
  const now = Date.now();
  const receiptId = await t.run((ctx) =>
    ctx.db.insert("emailReceipts", {
      organizationId: shop.organizationId,
      shopId: shop.shopId,
      routeId: route._id,
      key: "classification-fixture",
      envelopeFrom: "client@example.com",
      envelopeTo: route.address,
      sha256: "synthetic-hash",
      rawSize: 100,
      receivedAt: now,
      expiresAt: now + 86400000,
      status: "processing",
      attempts: 1,
      nextAttemptAt: now,
      updatedAt: now,
    }),
  );
  await t.mutation(internal.inboundEmails.ingestFromWorker, {
    provider: "cloudflare_email_routing",
    deliveryKey: "classification-fixture",
    envelopeFrom: "client@example.com",
    envelopeTo: route.address,
    from: { address: "client@example.com" },
    to: [{ address: route.address }],
    cc: [],
    replyTo: [],
    subject: "Article cassé",
    text,
    snippet: text,
    messageId: "<classification@example.com>",
    headers: [],
    references: [],
    attachments: [],
    receivedAt: now,
    rawSize: 100,
    receiptId,
    processingAttempt: 1,
    triage: { bucket, source: "ai", reason: "post_purchase", version: 1 },
  });
  const receipt = await t.run((ctx) => ctx.db.get(receiptId));
  return { t, shop, route, receiptId, token: receipt?.classificationJob?.token ?? "", receipt };
}

test("new SAV email schedules one classification, duplicate requests and execution do not duplicate AI calls", async () => {
  const f = await fixture();
  expect(f.token).not.toBe("");
  await f.shop.client.mutation(api.emailClassification.request, { receiptId: f.receiptId });
  expect((await f.t.run((ctx) => ctx.db.get(f.receiptId)))?.classificationJob?.token).toBe(f.token);
  await f.t.action(internal.emailClassificationProcessing.process, {
    receiptId: f.receiptId,
    token: f.token,
  });
  await f.t.action(internal.emailClassificationProcessing.process, {
    receiptId: f.receiptId,
    token: f.token,
  });
  expect(model).toHaveBeenCalledTimes(1);
  expect(await f.t.run((ctx) => ctx.db.get(f.receiptId))).toMatchObject({
    status: "processed",
    triage: { bucket: "sav" },
    classification: automatic,
    automaticClassification: automatic,
  });
  expect((await f.t.run((ctx) => ctx.db.get(f.receiptId)))?.classificationJob).toBeUndefined();
});

test("manual correction wins an in-flight AI response and preserves the automatic decision and actor", async () => {
  const f = await fixture();
  const args = { receiptId: f.receiptId, token: f.token };
  expect(await f.t.mutation(internal.emailClassification.claim, args)).not.toBeNull();
  expect(await f.t.mutation(internal.emailClassification.claim, args)).toBeNull();
  await f.shop.client.mutation(api.emailClassification.correct, {
    receiptId: f.receiptId,
    category: "refund",
    priority: "urgent",
  });
  await f.t.mutation(internal.emailClassification.complete, { ...args, classification: automatic });
  expect(await f.t.run((ctx) => ctx.db.get(f.receiptId))).toMatchObject({
    classification: {
      category: "refund",
      priority: "urgent",
      source: "manual",
      needsReview: false,
    },
    automaticClassification: automatic,
    classificationUpdatedBy: f.shop.profileId,
  });
  await f.shop.client.mutation(api.emailClassification.request, { receiptId: f.receiptId });
  expect((await f.t.run((ctx) => ctx.db.get(f.receiptId)))?.classificationJob).toBeUndefined();
});

test("non-SAV is excluded, moving to SAV queues analysis and moving out invalidates its result", async () => {
  const f = await fixture("review");
  expect(f.token).toBe("");
  await expect(
    f.shop.client.mutation(api.emailClassification.request, { receiptId: f.receiptId }),
  ).rejects.toThrow("NotSupportEmail");
  await f.shop.client.mutation(api.emailTriage.reclassify, {
    receiptId: f.receiptId,
    bucket: "sav",
  });
  const token = (await f.t.run((ctx) => ctx.db.get(f.receiptId)))?.classificationJob?.token;
  expect(token).toBeTruthy();
  await f.shop.client.mutation(api.emailTriage.reclassify, {
    receiptId: f.receiptId,
    bucket: "other",
  });
  await f.t.mutation(internal.emailClassification.complete, {
    receiptId: f.receiptId,
    token: token ?? "",
    classification: automatic,
  });
  expect((await f.t.run((ctx) => ctx.db.get(f.receiptId)))?.classification).toBeUndefined();
  expect(
    await f.shop.client.query(api.emailClassification.get, { receiptId: f.receiptId }),
  ).toBeNull();
});

test("provider failure, missing key and attachment-only mail retain SAV with a visible review fallback", async () => {
  const f = await fixture();
  model.mockRejectedValueOnce(new Error("provider unavailable"));
  await f.t.action(internal.emailClassificationProcessing.process, {
    receiptId: f.receiptId,
    token: f.token,
  });
  expect(await f.t.run((ctx) => ctx.db.get(f.receiptId))).toMatchObject({
    status: "processed",
    triage: { bucket: "sav" },
    classification: { source: "fallback", needsReview: true },
  });
  vi.stubEnv("OPENAI_API_KEY", "");
  const absent = await fixture();
  await absent.t.action(internal.emailClassificationProcessing.process, {
    receiptId: absent.receiptId,
    token: absent.token,
  });
  expect((await absent.t.run((ctx) => ctx.db.get(absent.receiptId)))?.classification?.source).toBe(
    "fallback",
  );
  vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
  const empty = await fixture("sav", "");
  await empty.t.action(internal.emailClassificationProcessing.process, {
    receiptId: empty.receiptId,
    token: empty.token,
  });
  expect(
    (await empty.t.run((ctx) => ctx.db.get(empty.receiptId)))?.classification?.reason,
  ).toContain("pièces jointes");
  expect(model).toHaveBeenCalledTimes(1);
});

test("timeouts are recoverable and late results cannot replace a newer request", async () => {
  const f = await fixture();
  vi.advanceTimersByTime(120001);
  await f.t.mutation(internal.emailClassification.expireJob, {
    receiptId: f.receiptId,
    token: f.token,
  });
  expect((await f.t.run((ctx) => ctx.db.get(f.receiptId)))?.classification).toMatchObject({
    source: "fallback",
    needsReview: true,
  });
  await f.shop.client.mutation(api.emailClassification.request, { receiptId: f.receiptId });
  const next = (await f.t.run((ctx) => ctx.db.get(f.receiptId)))?.classificationJob?.token;
  expect(next).not.toBe(f.token);
  await f.t.mutation(internal.emailClassification.complete, {
    receiptId: f.receiptId,
    token: f.token,
    classification: automatic,
  });
  expect((await f.t.run((ctx) => ctx.db.get(f.receiptId)))?.classificationJob?.token).toBe(next);
});

test("unauthenticated and cross-shop access is denied; viewers read but cannot write, agents can correct", async () => {
  const f = await fixture();
  const outsider = await workspace(f.t, "outsider");
  for (const client of [f.t, outsider.client]) {
    await expect(
      client.query(api.emailClassification.get, { receiptId: f.receiptId }),
    ).rejects.toThrow();
    await expect(
      client.mutation(api.emailClassification.correct, {
        receiptId: f.receiptId,
        category: "refund",
        priority: "high",
      }),
    ).rejects.toThrow();
    await expect(
      client.mutation(api.emailClassification.request, { receiptId: f.receiptId }),
    ).rejects.toThrow();
  }
  const membership = await f.t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", f.shop.organizationId))
      .first(),
  );
  if (!membership) throw new Error("Missing membership");
  await f.t.run((ctx) => ctx.db.patch(membership._id, { role: "viewer" }));
  expect(
    await f.shop.client.query(api.emailClassification.get, { receiptId: f.receiptId }),
  ).toMatchObject({ canCorrect: false });
  await expect(
    f.shop.client.mutation(api.emailClassification.correct, {
      receiptId: f.receiptId,
      category: "refund",
      priority: "high",
    }),
  ).rejects.toThrow("Forbidden");
  await expect(
    f.shop.client.mutation(api.emailClassification.request, { receiptId: f.receiptId }),
  ).rejects.toThrow("Forbidden");
  await f.t.run((ctx) => ctx.db.patch(membership._id, { role: "agent" }));
  await f.shop.client.mutation(api.emailClassification.correct, {
    receiptId: f.receiptId,
    category: "refund",
    priority: "high",
  });
});

test("category and priority filters intersect before pagination and exclude expired receipts even with an old asOf", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    const original = await ctx.db.get(f.receiptId);
    if (!original) throw new Error("Missing receipt");
    const { _id, _creationTime, ...fields } = original;
    for (const [key, category, priority] of [
      ["a", "refund", "high"],
      ["b", "refund", "normal"],
      ["c", "delivery_issue", "high"],
    ] as const) {
      await ctx.db.insert("emailReceipts", {
        ...fields,
        key,
        classificationJob: undefined,
        classification: { ...automatic, category, priority },
      });
    }
    await ctx.db.patch(f.receiptId, {
      classification: { ...automatic, category: "refund", priority: "high" },
      expiresAt: Date.now() - 1,
    });
  });
  const args = {
    shopId: f.shop.shopId,
    bucket: "sav" as const,
    asOf: Date.now() - 1000,
    paginationOpts: { numItems: 1, cursor: null },
  };
  const both = await f.shop.client.query(api.emailTriage.list, {
    ...args,
    category: "refund",
    priority: "high",
  });
  expect(both.page).toHaveLength(1);
  expect(both.page[0].classification).toMatchObject({ category: "refund", priority: "high" });
  const category = await f.shop.client.query(api.emailTriage.list, {
    ...args,
    category: "refund",
    paginationOpts: { numItems: 25, cursor: null },
  });
  expect(category.page).toHaveLength(2);
  const priority = await f.shop.client.query(api.emailTriage.list, {
    ...args,
    priority: "high",
    paginationOpts: { numItems: 25, cursor: null },
  });
  expect(priority.page).toHaveLength(2);
  await expect(
    f.shop.client.mutation(api.emailClassification.correct, {
      receiptId: f.receiptId,
      category: "refund",
      priority: "high",
    }),
  ).rejects.toThrow("EmailUnavailable");
});

test("reply context stays within the same shop and sender", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    const message = await ctx.db
      .query("supportMessages")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", f.receiptId))
      .unique();
    if (!message) throw new Error("Missing message");
    const { _id, _creationTime, ...fields } = message;
    await ctx.db.insert("supportMessages", {
      ...fields,
      receiptId: undefined,
      messageId: "<earlier@example.com>",
      text: "Earlier safe context",
    });
    await ctx.db.insert("supportMessages", {
      ...fields,
      receiptId: undefined,
      from: { address: "someone-else@example.com" },
      messageId: "<outsider@example.com>",
      text: "Private outsider context",
    });
    await ctx.db.patch(message._id, {
      inReplyTo: "<outsider@example.com>",
      references: ["<earlier@example.com>"],
    });
  });
  const input = await f.t.mutation(internal.emailClassification.claim, {
    receiptId: f.receiptId,
    token: f.token,
  });
  expect(input?.prompt).toContain("Earlier safe context");
  expect(input?.prompt).not.toContain("Private outsider context");
});

test("classification guards bound data and mark low confidence or truncated content for review", () => {
  const input = {
    category: "refund" as const,
    priority: "urgent" as const,
    reasonCode: "safety_risk" as const,
    confidence: 0.6,
    needsReview: false,
  };
  expect(guardClassification(input)).toMatchObject({
    category: "other",
    priority: "urgent",
    needsReview: true,
  });
  expect(guardClassification({ ...input, priority: "low" })).toMatchObject({ priority: "normal" });
  expect(guardClassification({ ...input, confidence: Number.NaN })).toEqual(
    classificationFallback(),
  );
  expect(guardClassification({ ...input, confidence: 0.99 }, true).needsReview).toBe(true);
  const prompt = classificationPrompt({ subject: "x".repeat(700), text: "a".repeat(10000) });
  expect(prompt.truncated).toBe(true);
  expect(prompt.prompt.length).toBeLessThan(6000);
});
