/// <reference types="vite/client" />
import betterAuthTest from "@convex-dev/better-auth/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import type { Classification } from "./lib/emailClassificationPolicy";
import { humanReviewContext } from "./lib/humanReviewContext";
import { prepareHumanReview } from "./lib/humanReviewModel";
import {
  normalizeProposal,
  type Proposal,
  replyBlockReason,
  reviewFallback,
} from "./lib/humanReviewPolicy";
import schema from "./schema";

vi.mock("./lib/humanReviewModel", () => ({ prepareHumanReview: vi.fn() }));
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const model = vi.mocked(prepareHumanReview);
const classification: Classification = {
  category: "delivery_issue",
  priority: "high",
  needsReview: false,
  reason: "Retard signalé",
  source: "ai",
  version: 1,
};
const proposal: Proposal = {
  summary: "Le client signale une livraison en retard.",
  solution: "Vérifier la livraison avant de proposer une solution.",
  draftReply: "Bonjour, nous allons vérifier les informations de livraison.",
  missingInformation: [],
  warnings: [],
  source: "ai",
  model: "gpt-6-luna",
  confidence: 0.98,
  version: 1,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
  model.mockReset();
  model.mockResolvedValue(proposal);
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
  ready = true,
  text = "Bonjour, ma commande #SYNTHETIC1001 est en retard. Pouvez-vous vérifier ?",
) {
  const t = createBackend(),
    shop = await workspace(t, "review");
  const route = await shop.client.query(api.inboundEmailRoutes.getForShop, { shopId: shop.shopId });
  if (!route) throw new Error("Missing route");
  const now = Date.now();
  const receiptId = await t.run((ctx) =>
    ctx.db.insert("emailReceipts", {
      organizationId: shop.organizationId,
      shopId: shop.shopId,
      routeId: route._id,
      key: "review-fixture",
      envelopeFrom: "client@example.com",
      envelopeTo: route.address,
      sha256: "synthetic",
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
    deliveryKey: "review-fixture",
    envelopeFrom: "client@example.com",
    envelopeTo: route.address,
    from: { address: "client@example.com" },
    to: [{ address: route.address }],
    cc: [],
    replyTo: [],
    subject: "Commande #SYNTHETIC1001",
    text,
    snippet: text,
    messageId: "<review@example.com>",
    headers: [],
    references: [],
    attachments: [],
    receivedAt: now,
    rawSize: 100,
    receiptId,
    processingAttempt: 1,
    triage: { bucket, source: "ai", reason: "post_purchase", version: 1 },
  });
  const initial = await t.run((ctx) => ctx.db.get(receiptId));
  if (ready && initial?.classificationJob)
    await t.mutation(internal.emailClassification.complete, {
      receiptId,
      token: initial.classificationJob.token,
      classification,
    });
  const receipt = await t.run((ctx) => ctx.db.get(receiptId));
  return { t, shop, route, receiptId, initial, token: receipt?.humanReview?.job?.token ?? "" };
}
async function seedOrder(f: Awaited<ReturnType<typeof fixture>>, email = "client@example.com") {
  const now = Date.now();
  return f.t.run(async (ctx) => {
    const connectionId = await ctx.db.insert("shopifyConnections", {
      shopId: f.shop.shopId,
      organizationId: f.shop.organizationId,
      domain: "fixture.myshopify.com",
      shopifyShopId: "gid://shopify/Shop/1",
      clientId: "test",
      secret: "never-decrypted",
      token: "never-decrypted",
      tokenExpiresAt: now + 86400000,
      scopes: ["read_orders"],
      generation: "g1",
      status: "active",
      nextSyncAt: now + 86400000,
      createdAt: now,
    });
    const orderId = await ctx.db.insert("shopifyOrders", {
      shopId: f.shop.shopId,
      organizationId: f.shop.organizationId,
      connectionId,
      generation: "g1",
      gid: "gid://shopify/Order/1",
      name: "#SYNTHETIC1001",
      email,
      placedAt: now - 86400000,
      sourceUpdatedAt: now,
      syncedAt: now,
      financialStatus: "PAID",
      fulfillmentStatus: "FULFILLED",
      cancelled: false,
      total: "25.00",
      refunded: "0.00",
      currency: "EUR",
      destination: { city: "Private City", zip: "PRIVATE-ZIP", country: "FR" },
      items: [
        { id: "item", title: "Test shirt", quantity: 1, sku: "PRIVATE-SKU", variant: "blue" },
      ],
      detailsTruncated: false,
    });
    const shipmentId = await ctx.db.insert("orderShipments", {
      shopId: f.shop.shopId,
      organizationId: f.shop.organizationId,
      connectionId,
      generation: "g1",
      orderId,
      number: "SYNTHETIC-NEVER-REGISTER",
      company: "Fixture",
      fulfillmentId: "f1",
      registered: false,
      nextAttemptAt: now + 86400000,
      status: "InTransit",
      events: [{ time: now, description: "Parcel in transit", location: "Private warehouse" }],
      syncedAt: now,
      active: true,
    });
    return { connectionId, orderId, shipmentId };
  });
}
async function current(f: Awaited<ReturnType<typeof fixture>>) {
  return f.t.run((ctx) => ctx.db.get(f.receiptId));
}
async function context(f: Awaited<ReturnType<typeof fixture>>) {
  return f.t.run(async (ctx) => {
    const receipt = await ctx.db.get(f.receiptId);
    if (!receipt) throw new Error("Missing receipt");
    return humanReviewContext(ctx, receipt);
  });
}

test("creates a visible alert before AI/classification and hands off after classification, without duplicates", async () => {
  const f = await fixture("sav", false);
  expect(f.initial?.humanReview).toMatchObject({ status: "open", reason: "auto_reply_disabled" });
  expect(f.initial?.humanReview?.job).toBeUndefined();
  expect(
    await f.shop.client.query(api.humanReviews.overview, {
      shopId: f.shop.shopId,
      asOf: Date.now(),
    }),
  ).toMatchObject({ open: 1, inProgress: 0 });
  await f.t.mutation(internal.emailClassification.complete, {
    receiptId: f.receiptId,
    token: f.initial?.classificationJob?.token ?? "",
    classification,
  });
  const token = (await current(f))?.humanReview?.job?.token;
  expect(token).toBeTruthy();
  await f.shop.client.mutation(api.humanReviews.request, { receiptId: f.receiptId });
  expect((await current(f))?.humanReview?.job?.token).toBe(token);
  await f.t.action(internal.humanReviewProcessing.process, {
    receiptId: f.receiptId,
    token: token ?? "",
  });
  await f.t.action(internal.humanReviewProcessing.process, {
    receiptId: f.receiptId,
    token: token ?? "",
  });
  expect(model).toHaveBeenCalledTimes(1);
  expect((await current(f))?.humanReview).toMatchObject({ status: "open", proposal });
  expect(await f.t.run((ctx) => ctx.db.query("supportMessages").take(10))).toHaveLength(1);
});

test("the enable flag never grants a reply without an authorized rule", () => {
  expect(replyBlockReason(false, classification)).toBe("auto_reply_disabled");
  expect(replyBlockReason(true, { ...classification, priority: "normal" })).toBe(
    "no_authorized_rule",
  );
  expect(replyBlockReason(true, { ...classification, needsReview: true })).toBe(
    "classification_review",
  );
  expect(replyBlockReason(true, classification)).toBe("sensitive_request");
});

test("manual status and edited draft win an in-flight generation and actor is recorded server-side", async () => {
  const f = await fixture();
  const args = { receiptId: f.receiptId, token: f.token };
  const input = await f.t.mutation(internal.humanReviews.claim, args);
  if (!input) throw new Error("Missing input");
  expect(await f.t.mutation(internal.humanReviews.claim, args)).toBeNull();
  await f.shop.client.mutation(api.humanReviews.saveDraft, {
    receiptId: f.receiptId,
    draft: "Notre brouillon validé par un humain.",
  });
  await f.shop.client.mutation(api.humanReviews.setStatus, {
    receiptId: f.receiptId,
    status: "resolved",
  });
  await f.t.mutation(internal.humanReviews.complete, {
    ...args,
    contextKey: input.contextKey,
    proposal,
  });
  expect((await current(f))?.humanReview).toMatchObject({
    status: "resolved",
    editedDraft: "Notre brouillon validé par un humain.",
    draftUpdatedBy: f.shop.profileId,
    updatedBy: f.shop.profileId,
    proposal,
  });
  expect(
    await f.shop.client.query(api.humanReviews.overview, {
      shopId: f.shop.shopId,
      asOf: Date.now(),
    }),
  ).toMatchObject({ open: 0 });
  await f.shop.client.mutation(api.humanReviews.setStatus, {
    receiptId: f.receiptId,
    status: "open",
  });
  expect(
    await f.shop.client.query(api.humanReviews.overview, {
      shopId: f.shop.shopId,
      asOf: Date.now(),
    }),
  ).toMatchObject({ open: 1 });
});

test("provider failure, missing key and empty content retain the alert with no invented reply", async () => {
  const f = await fixture();
  model.mockRejectedValueOnce(new Error("provider failed"));
  await f.t.action(internal.humanReviewProcessing.process, {
    receiptId: f.receiptId,
    token: f.token,
  });
  expect((await current(f))?.humanReview).toMatchObject({
    status: "open",
    proposal: { source: "fallback", draftReply: "" },
  });
  vi.stubEnv("OPENAI_API_KEY", "");
  const noKey = await fixture();
  await noKey.t.action(internal.humanReviewProcessing.process, {
    receiptId: noKey.receiptId,
    token: noKey.token,
  });
  expect((await current(noKey))?.humanReview?.proposal?.source).toBe("fallback");
  vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
  const empty = await fixture("sav", true, "");
  await empty.t.action(internal.humanReviewProcessing.process, {
    receiptId: empty.receiptId,
    token: empty.token,
  });
  expect((await current(empty))?.humanReview?.proposal?.summary).toContain("pièces jointes");
  expect(model).toHaveBeenCalledTimes(1);
});

test("expired jobs can be relaunched and stale completions cannot replace a newer request", async () => {
  const f = await fixture();
  vi.setSystemTime(Date.now() + 120001);
  await f.t.mutation(internal.humanReviews.expireJob, { receiptId: f.receiptId, token: f.token });
  expect((await current(f))?.humanReview).toMatchObject({
    status: "open",
    proposal: { source: "fallback" },
  });
  await f.shop.client.mutation(api.humanReviews.request, { receiptId: f.receiptId });
  const next = (await current(f))?.humanReview?.job?.token;
  expect(next).not.toBe(f.token);
  await f.t.mutation(internal.humanReviews.complete, {
    receiptId: f.receiptId,
    token: f.token,
    contextKey: "stale",
    proposal,
  });
  expect((await current(f))?.humanReview?.job?.token).toBe(next);
});

test("non-SAV emails have no alert; manual SAV correction creates it and moving out cancels results", async () => {
  const f = await fixture("review");
  expect((await current(f))?.humanReview).toBeUndefined();
  await expect(
    f.shop.client.mutation(api.humanReviews.request, { receiptId: f.receiptId }),
  ).rejects.toThrow("NotSupportEmail");
  await f.shop.client.mutation(api.emailTriage.reclassify, {
    receiptId: f.receiptId,
    bucket: "sav",
  });
  expect((await current(f))?.humanReview?.status).toBe("open");
  const classJob = (await current(f))?.classificationJob;
  await f.t.mutation(internal.emailClassification.complete, {
    receiptId: f.receiptId,
    token: classJob?.token ?? "",
    classification,
  });
  const token = (await current(f))?.humanReview?.job?.token ?? "";
  await f.shop.client.mutation(api.emailTriage.reclassify, {
    receiptId: f.receiptId,
    bucket: "other",
  });
  await f.t.mutation(internal.humanReviews.complete, {
    receiptId: f.receiptId,
    token,
    contextKey: "stale",
    proposal,
  });
  expect((await current(f))?.humanReview).toBeUndefined();
  expect(await f.shop.client.query(api.humanReviews.get, { receiptId: f.receiptId })).toBeNull();
});

test("cache-only context reuses the selected matching order, excludes private address/SKU/tracking and never queues tracking", async () => {
  const f = await fixture();
  const ids = await seedOrder(f);
  const before = await f.t.run((ctx) => ctx.db.get(ids.shipmentId));
  const input = await context(f);
  expect(input.warnings).not.toContain("missing_order");
  expect(input.prompt).toContain("#SYNTHETIC1001");
  expect(input.prompt).toContain("Parcel in transit");
  for (const privateValue of [
    "PRIVATE-ZIP",
    "PRIVATE-SKU",
    "Private City",
    "SYNTHETIC-NEVER-REGISTER",
    "never-decrypted",
    "Private warehouse",
  ])
    expect(input.prompt).not.toContain(privateValue);
  await f.t.action(internal.humanReviewProcessing.process, {
    receiptId: f.receiptId,
    token: f.token,
  });
  expect(model).toHaveBeenCalledTimes(1);
  expect(await f.t.run((ctx) => ctx.db.get(ids.shipmentId))).toEqual(before);
});

test("ambiguous or mismatched identities never expose another order to the model", async () => {
  const f = await fixture();
  const ids = await seedOrder(f, "different@example.com");
  expect((await context(f)).warnings).toContain("missing_order");
  await f.shop.client.mutation(api.orderContext.link, {
    receiptId: f.receiptId,
    orderId: ids.orderId,
  });
  const input = await context(f);
  expect(input.warnings).toContain("identity_mismatch");
  expect(JSON.parse(input.prompt).cachedOrder).toBeNull();
  expect(input.prompt).not.toContain("Test shirt");
});

test("changed cached order during generation discards its result; subsequent context changes mark a proposal stale", async () => {
  const f = await fixture();
  const ids = await seedOrder(f);
  const args = { receiptId: f.receiptId, token: f.token };
  const input = await f.t.mutation(internal.humanReviews.claim, args);
  if (!input) throw new Error("Missing input");
  await f.t.run((ctx) =>
    ctx.db.patch(ids.orderId, { sourceUpdatedAt: Date.now() + 1, total: "30.00" }),
  );
  await f.t.mutation(internal.humanReviews.complete, {
    ...args,
    contextKey: input.contextKey,
    proposal,
  });
  expect((await current(f))?.humanReview?.proposal?.source).toBe("fallback");
  expect((await f.shop.client.query(api.humanReviews.get, { receiptId: f.receiptId }))?.stale).toBe(
    true,
  );
  await f.shop.client.mutation(api.humanReviews.request, { receiptId: f.receiptId });
  const token = (await current(f))?.humanReview?.job?.token ?? "";
  await f.t.action(internal.humanReviewProcessing.process, { receiptId: f.receiptId, token });
  expect((await f.shop.client.query(api.humanReviews.get, { receiptId: f.receiptId }))?.stale).toBe(
    false,
  );
  await f.shop.client.mutation(api.emailClassification.correct, {
    receiptId: f.receiptId,
    category: "refund",
    priority: "urgent",
  });
  expect((await f.shop.client.query(api.humanReviews.get, { receiptId: f.receiptId }))?.stale).toBe(
    true,
  );
});

test("stale tracking, omitted attachments, long content and missing order are explicit warnings", async () => {
  const f = await fixture("sav", true, "a".repeat(8000));
  const ids = await seedOrder(f);
  await f.t.run(async (ctx) => {
    const message = await ctx.db
      .query("supportMessages")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", f.receiptId))
      .unique();
    if (message) await ctx.db.patch(message._id, { attachmentCount: 1 });
    await ctx.db.patch(ids.shipmentId, { syncedAt: Date.now() - 13 * 3600000 });
  });
  const input = await context(f);
  expect(input.warnings).toEqual(
    expect.arrayContaining(["truncated_input", "attachments_not_read", "stale_tracking"]),
  );
  expect(JSON.parse(input.prompt).email.body).toHaveLength(6000);
});

test("read/write operations enforce auth, tenant isolation and roles", async () => {
  const f = await fixture(),
    outsider = await workspace(f.t, "outsider");
  for (const client of [f.t, outsider.client]) {
    await expect(client.query(api.humanReviews.get, { receiptId: f.receiptId })).rejects.toThrow();
    await expect(
      client.query(api.humanReviews.overview, { shopId: f.shop.shopId, asOf: Date.now() }),
    ).rejects.toThrow();
    await expect(
      client.query(api.humanReviews.list, {
        shopId: f.shop.shopId,
        status: "open",
        asOf: Date.now(),
        paginationOpts: { cursor: null, numItems: 20 },
      }),
    ).rejects.toThrow();
    await expect(
      client.mutation(api.humanReviews.request, { receiptId: f.receiptId }),
    ).rejects.toThrow();
    await expect(
      client.mutation(api.humanReviews.setStatus, { receiptId: f.receiptId, status: "resolved" }),
    ).rejects.toThrow();
    await expect(
      client.mutation(api.humanReviews.saveDraft, { receiptId: f.receiptId, draft: "x" }),
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
    (await f.shop.client.query(api.humanReviews.get, { receiptId: f.receiptId }))?.canManage,
  ).toBe(false);
  await expect(
    f.shop.client.mutation(api.humanReviews.saveDraft, { receiptId: f.receiptId, draft: "x" }),
  ).rejects.toThrow("Forbidden");
  await expect(
    f.shop.client.mutation(api.humanReviews.setStatus, {
      receiptId: f.receiptId,
      status: "resolved",
    }),
  ).rejects.toThrow("Forbidden");
  await expect(
    f.shop.client.mutation(api.humanReviews.request, { receiptId: f.receiptId }),
  ).rejects.toThrow("Forbidden");
  await f.t.run((ctx) => ctx.db.patch(membership._id, { role: "agent" }));
  await f.shop.client.mutation(api.humanReviews.setStatus, {
    receiptId: f.receiptId,
    status: "in_progress",
  });
  expect((await current(f))?.humanReview?.updatedBy).toBe(f.shop.profileId);
  await expect(
    f.shop.client.mutation(api.humanReviews.saveDraft, {
      receiptId: f.receiptId,
      draft: "x".repeat(6001),
    }),
  ).rejects.toThrow("DraftTooLong");
});

test("pagination filters status before page limits; counters are capped and expired receipts cannot be edited or read", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    const receipt = await ctx.db.get(f.receiptId);
    if (!receipt) throw new Error();
    const { _id, _creationTime, ...fields } = receipt;
    for (let i = 0; i < 55; i++)
      await ctx.db.insert("emailReceipts", { ...fields, key: `count-${i}` });
  });
  expect(
    await f.shop.client.query(api.humanReviews.overview, {
      shopId: f.shop.shopId,
      asOf: Date.now(),
    }),
  ).toMatchObject({ open: 50, openMore: true });
  await f.shop.client.mutation(api.humanReviews.setStatus, {
    receiptId: f.receiptId,
    status: "in_progress",
  });
  const page = await f.shop.client.query(api.humanReviews.list, {
    shopId: f.shop.shopId,
    status: "in_progress",
    asOf: Date.now(),
    paginationOpts: { cursor: null, numItems: 1 },
  });
  expect(page.page.map((r) => r.receiptId)).toEqual([f.receiptId]);
  await f.t.run((ctx) => ctx.db.patch(f.receiptId, { expiresAt: Date.now() - 1 }));
  expect(await f.shop.client.query(api.humanReviews.get, { receiptId: f.receiptId })).toBeNull();
  await expect(
    f.shop.client.mutation(api.humanReviews.request, { receiptId: f.receiptId }),
  ).rejects.toThrow("EmailUnavailable");
  await f.t.mutation(internal.emailRetention.expireReceipt, { receiptId: f.receiptId });
  expect(await current(f)).toBeNull();
});

test("reply context is bounded to the same sender and shop", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    const message = await ctx.db
      .query("supportMessages")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", f.receiptId))
      .unique();
    if (!message) throw new Error();
    const { _id, _creationTime, ...fields } = message;
    await ctx.db.insert("supportMessages", {
      ...fields,
      receiptId: undefined,
      messageId: "<earlier@example.com>",
      text: "Earlier relevant context",
    });
    await ctx.db.insert("supportMessages", {
      ...fields,
      receiptId: undefined,
      messageId: "<outsider@example.com>",
      from: { address: "other@example.com" },
      text: "Other person's private email",
    });
    await ctx.db.patch(message._id, {
      inReplyTo: "<outsider@example.com>",
      references: ["<earlier@example.com>"],
    });
  });
  const input = await context(f);
  expect(input.prompt).toContain("Earlier relevant context");
  expect(input.prompt).not.toContain("Other person's private email");
});

test("low confidence clears the proposed reply, and malformed output falls back", () => {
  expect(
    normalizeProposal(
      {
        summary: "Résumé",
        solution: "À vérifier",
        draftReply: "Promesse dangereuse",
        missingInformation: [],
        confidence: 0.5,
      },
      [],
    ),
  ).toMatchObject({ draftReply: "", warnings: ["uncertain_output"] });
  expect(
    normalizeProposal(
      { summary: "", solution: "x", draftReply: "x", missingInformation: [], confidence: 1 },
      [],
    ),
  ).toEqual(reviewFallback());
});

test("a cache refresh with unchanged facts does not make the proposal stale", async () => {
  const f = await fixture();
  const ids = await seedOrder(f);
  await f.t.action(internal.humanReviewProcessing.process, {
    receiptId: f.receiptId,
    token: f.token,
  });
  await f.t.run(async (ctx) => {
    await ctx.db.patch(ids.orderId, { syncedAt: Date.now() + 1000 });
    await ctx.db.patch(ids.shipmentId, { syncedAt: Date.now() + 1000 });
  });
  expect((await f.shop.client.query(api.humanReviews.get, { receiptId: f.receiptId }))?.stale).toBe(
    false,
  );
});
