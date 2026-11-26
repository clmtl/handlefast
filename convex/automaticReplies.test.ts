/// <reference types="vite/client" />
import betterAuthTest from "@convex-dev/better-auth/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import { routeSupportReply } from "./automaticReplies";
import { getOrCreateConversationId } from "./inboundEmails";
import {
  AUTO_REPLY_WINDOW,
  type ReplyPlan,
  renderAutomaticReply,
  suppressAutoResponse,
} from "./lib/automaticReplyPolicy";
import { orderReferences } from "./lib/commerceModel";
import type { Classification } from "./lib/emailClassificationPolicy";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const classification: Classification = {
  category: "order_status",
  priority: "normal",
  needsReview: false,
  confidence: 0.99,
  reason: "Demande de suivi",
  source: "ai",
  model: "gpt-6-luna",
  version: 1,
};
const plan: ReplyPlan = { intent: "reference", language: "fr", confidence: 0.99 };
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENAI_API_KEY", "synthetic");
  vi.stubEnv("RESEND_API_KEY", "synthetic");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
  options: {
    enabled?: boolean;
    headers?: { name: string; value: string }[];
    replyTo?: string;
    old?: boolean;
    newlyReserved?: boolean;
    locale?: string | null;
    classification?: Classification;
    text?: string;
  } = {},
) {
  const t = createBackend(),
    shop = await workspace(t, "automatic");
  await t.run((ctx) => ctx.db.patch(shop.shopId, { supportEmail: "sav@fixture.example" }));
  vi.stubEnv("VERIFIED_SHOP_SENDERS", JSON.stringify({ [shop.shopId]: "sav@fixture.example" }));
  const route = await shop.client.query(api.inboundEmailRoutes.getForShop, { shopId: shop.shopId });
  if (!route) throw new Error("Missing route");
  if (options.enabled !== false)
    await shop.client.mutation(api.automaticReplySettings.save, {
      shopId: shop.shopId,
      enabled: true,
      rules: [{ category: "order_status", priority: "normal" }],
    });
  const now = Date.now();
  const connectionId = await t.run((ctx) =>
    ctx.db.insert("shopifyConnections", {
      shopId: shop.shopId,
      organizationId: shop.organizationId,
      domain: "fixture.myshopify.com",
      shopifyShopId: "gid://shopify/Shop/1",
      clientId: "test",
      secret: "never-decrypted",
      token: "never-decrypted",
      tokenExpiresAt: now + 86400000,
      scopes: ["read_orders"],
      primaryLocale: options.locale === null ? undefined : (options.locale ?? "fr"),
      generation: "g1",
      status: "active",
      nextSyncAt: now + 86400000,
      createdAt: now,
    }),
  );
  const receivedAt = options.old ? now - 1000 : now;
  const envelopeFrom = "client@example.com";
  const envelopeTo = route.address;
  const sha256 = `${"A".repeat(43)}=`;
  const rawSize = 100;
  const reserved = options.newlyReserved
    ? await t.mutation(internal.emailReceipts.reserve, {
        envelopeFrom,
        envelopeTo,
        sha256,
        rawSize,
      })
    : undefined;
  if (reserved?.status === "rejected") throw new Error("Fixture receipt rejected");
  const deliveryKey = reserved ? `${envelopeTo}:${sha256}` : "auto-fixture";
  const receiptId = await t.run(async (ctx) => {
    if (reserved) {
      await ctx.db.patch(reserved.receiptId, { status: "processing", attempts: 1 });
      return reserved.receiptId;
    }
    return ctx.db.insert("emailReceipts", {
      organizationId: shop.organizationId,
      shopId: shop.shopId,
      routeId: route._id,
      key: deliveryKey,
      envelopeFrom,
      envelopeTo,
      sha256,
      rawSize,
      receivedAt,
      expiresAt: now + 86400000,
      status: "processing",
      attempts: 1,
      nextAttemptAt: now,
      updatedAt: now,
    });
  });
  await t.mutation(internal.inboundEmails.ingestFromWorker, {
    provider: "cloudflare_email_routing",
    deliveryKey,
    envelopeFrom,
    envelopeTo,
    from: { address: "client@example.com" },
    to: [{ address: route.address }],
    cc: [],
    replyTo: options.replyTo ? [{ address: options.replyTo }] : [],
    subject: "Suivi de commande",
    text: options.text ?? "Bonjour, où en est ma commande ? Je ne retrouve plus sa référence.",
    snippet: "Demande de suivi",
    messageId: "<auto@example.com>",
    headers: options.headers ?? [],
    references: [],
    attachments: [],
    receivedAt,
    rawSize: 100,
    receiptId,
    processingAttempt: 1,
    triage: { bucket: "sav", source: "ai", reason: "post_purchase", version: 1 },
  });
  const receipt = await t.run((ctx) => ctx.db.get(receiptId));
  if (!receipt?.classificationJob) throw new Error("Missing classification job");
  await t.mutation(internal.emailClassification.complete, {
    receiptId,
    token: receipt.classificationJob.token,
    classification: options.classification ?? classification,
  });
  return { t, shop, route, receiptId, connectionId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function row(f: Fixture) {
  return f.t.run((ctx) =>
    ctx.db
      .query("automaticReplies")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", f.receiptId))
      .unique(),
  );
}
async function requireRow(f: Fixture) {
  const r = await row(f);
  if (!r) throw new Error("Missing outbox");
  return r;
}
async function ready(f: Fixture, proposal: ReplyPlan = plan) {
  const r = await requireRow(f),
    claim = await f.t.mutation(internal.automaticReplies.claimPreparation, { id: r._id });
  if (!claim) throw new Error("Missing preparation claim");
  await f.t.mutation(internal.automaticReplies.prepared, {
    id: r._id,
    token: claim.token,
    contextKey: claim.contextKey,
    plan: proposal,
  });
  return requireRow(f);
}
async function receipt(f: Fixture) {
  return f.t.run((ctx) => ctx.db.get(f.receiptId));
}

test("untouched shops queue new simple tracking replies and honor an explicit pause", async () => {
  const f = await fixture({ enabled: false, newlyReserved: true });
  const { shopId } = f.shop;
  const settings = await f.shop.client.query(api.automaticReplySettings.get, { shopId });
  expect(settings).toMatchObject({
    enabled: true,
    rules: [
      { category: "order_status", priority: "low" },
      { category: "order_status", priority: "normal" },
    ],
  });
  expect(await receipt(f)).toMatchObject({
    autoReplyEligibility: { eligible: true, revision: 0 },
  });
  expect(await row(f)).toMatchObject({ status: "queued" });
  await f.shop.client.mutation(api.automaticReplySettings.save, {
    shopId,
    enabled: false,
    rules: settings.rules,
  });
  expect(await f.shop.client.query(api.automaticReplySettings.get, { shopId })).toMatchObject({
    enabled: false,
    rules: settings.rules,
  });
  const paused = await f.t.mutation(internal.emailReceipts.reserve, {
    envelopeFrom: "client@example.com",
    envelopeTo: f.route.address,
    sha256: `${"B".repeat(43)}=`,
    rawSize: 100,
  });
  if (paused.status === "rejected") throw new Error("Fixture receipt rejected");
  expect(await f.t.run((ctx) => ctx.db.get(paused.receiptId))).toMatchObject({
    autoReplyEligibility: { eligible: false, revision: 1 },
  });
});

test("new enabled matching emails queue once, show automatic status and suppress human proposals", async () => {
  const f = await fixture(),
    r = await requireRow(f);
  expect(r.status).toBe("queued");
  expect((await receipt(f))?.humanReview).toBeUndefined();
  await f.t.run((ctx) => routeSupportReply(ctx, f.receiptId));
  expect((await requireRow(f))._id).toBe(r._id);
  expect(await f.shop.client.query(api.humanReviews.get, { receiptId: f.receiptId })).toBeNull();
  await expect(
    f.shop.client.mutation(api.humanReviews.request, { receiptId: f.receiptId }),
  ).rejects.toThrow("AutomaticReplyActive");
  const first = await f.t.mutation(internal.automaticReplies.claimPreparation, { id: r._id });
  expect(first).not.toBeNull();
  expect(await f.t.mutation(internal.automaticReplies.claimPreparation, { id: r._id })).toBeNull();
});

test.each([
  { enabled: false },
  { old: true },
  { classification: { ...classification, needsReview: true } },
  { classification: { ...classification, confidence: 0.89 } },
  { classification: { ...classification, source: "manual" as const } },
  { classification: { ...classification, priority: "high" as const } },
  { replyTo: "another@example.com" },
  { text: "x".repeat(6001) },
])("rejects ineligible input %j", async (options) => {
  const f = await fixture(options);
  expect(await row(f)).toBeNull();
  expect((await receipt(f))?.humanReview?.status).toBe("open");
});

test("enabling rules never replies to historical emails", async () => {
  const f = await fixture({ enabled: false });
  await f.shop.client.mutation(api.automaticReplySettings.save, {
    shopId: f.shop.shopId,
    enabled: true,
    rules: [{ category: "order_status", priority: "normal" }],
  });
  await f.t.run((ctx) => routeSupportReply(ctx, f.receiptId));
  expect(await row(f)).toBeNull();
});

test("loop suppression uses original headers even beyond the stored forty", async () => {
  const headers = [
    ...Array.from({ length: 45 }, (_, i) => ({ name: `X-Fixture-${i}`, value: "safe" })),
    { name: "Auto-Submitted", value: "auto-replied" },
  ];
  const f = await fixture({ headers });
  expect(await row(f)).toBeNull();
  expect((await receipt(f))?.automaticReplySuppressed).toBe(true);
  for (const header of [
    { name: "Precedence", value: "bulk" },
    { name: "List-ID", value: "list" },
    { name: "X-Auto-Response-Suppress", value: "All" },
    { name: "X-HandleFast-Auto-Reply", value: "1" },
  ])
    expect(suppressAutoResponse([header])).toBe(true);
  expect(suppressAutoResponse([{ name: "Auto-Submitted", value: "no" }])).toBe(false);
});

test("renders only reviewed bounded templates and safe intent/category combinations", () => {
  const context = {
    statuses: ["InTransit"],
    preparing: false,
    missingOrder: false,
    hasReference: true,
    orderName: "#TEST1001",
    shopName: "Shop",
  };
  expect(
    renderAutomaticReply({ ...plan, intent: "tracking" }, "en", "order_status", context),
  ).toContain("In transit");
  expect(
    renderAutomaticReply({ ...plan, intent: "tracking" }, "fr", "order_status", {
      ...context,
      statuses: ["Unknown"],
    }),
  ).toBeNull();
  expect(renderAutomaticReply({ ...plan, intent: "tracking" }, "fr", "refund", context)).toBeNull();
  for (const p of [
    { ...plan, intent: "handoff" as const },
    { ...plan, confidence: 0.94 },
    { ...plan, confidence: NaN },
  ])
    expect(
      renderAutomaticReply(p, "fr", "order_status", {
        ...context,
        missingOrder: true,
        hasReference: false,
      }),
    ).toBeNull();
  expect(
    renderAutomaticReply(plan, "fr", "order_status", { ...context, missingOrder: true }),
  ).toBeNull();
});

test("uncertain or action-required plans hand off without sending", async () => {
  for (const proposal of [
    { ...plan, intent: "handoff" as const },
    { ...plan, confidence: 0.9 },
    { ...plan, intent: "tracking" as const },
  ]) {
    const f = await fixture();
    const r = await ready(f, proposal);
    expect(r.status).toBe("cancelled");
    expect((await receipt(f))?.humanReview?.status).toBe("open");
  }
});

test.each([
  ["en-GB", "Hello"],
  ["de-AT", "Guten Tag"],
])("replies use %s, and a change invalidates an unsent reply", async (locale, greeting) => {
  const f = await fixture({ locale });
  const reply = await ready(f, { ...plan, language: "other" });
  expect(reply.payload?.text).toContain(greeting);
  expect(reply.payload?.text).not.toContain("Bonjour");
  await f.t.run((ctx) => ctx.db.patch(f.connectionId, { primaryLocale: "es" }));
  expect(await f.t.mutation(internal.automaticReplies.claimSend, { id: reply._id })).toBeNull();
  expect(await row(f)).toMatchObject({ status: "cancelled" });
});

test.each([null, "it"])("hands off when the shop language %s has no template", async (locale) => {
  const f = await fixture({ locale });
  expect(await row(f)).toBeNull();
  expect((await receipt(f))?.humanReview).toMatchObject({ status: "open" });
});

test("owner approval is required even for queued automatic replies in test mode", async () => {
  const f = await fixture();
  const queued = await ready(f);
  vi.stubEnv("REQUIRE_EMAIL_APPROVAL", "true");
  expect(await f.t.mutation(internal.automaticReplies.claimSend, { id: queued._id })).toBeNull();
  expect(await row(f)).toMatchObject({
    status: "cancelled",
    attempts: 0,
    reason: "approval_required",
  });
  const review = await f.shop.client.query(api.humanReviews.get, { receiptId: f.receiptId });
  const target = review?.sendTarget;
  if (!target) throw new Error("Missing approved sending account");
  const args = { receiptId: f.receiptId, ...target, text: "Message approuvé" };
  await expect(
    f.shop.client.mutation(api.automaticReplies.approveManual, {
      ...args,
      to: "another@example.com",
    }),
  ).rejects.toThrow("ManualReplyUnavailable");
  await f.shop.client.mutation(api.automaticReplies.approveManual, args);
  await expect(f.shop.client.mutation(api.automaticReplies.approveManual, args)).rejects.toThrow(
    "ReplyAlreadyQueued",
  );
  const claim = await f.t.mutation(internal.automaticReplies.claimSend, { id: queued._id });
  expect(claim?.payload).toMatchObject({ from: target.from, to: [target.to], text: args.text });
  expect(claim?.payload.from).toBe("sav@fixture.example");
  expect(await f.t.mutation(internal.automaticReplies.claimSend, { id: queued._id })).toBeNull();
});

test("a queued reply cannot send from an old HandleFast address or a revoked shop address", async () => {
  const f = await fixture();
  const queued = await ready(f);
  const payload = queued.payload;
  if (!payload) throw new Error("Missing queued payload");
  await f.t.run((ctx) =>
    ctx.db.patch(queued._id, { payload: { ...payload, from: f.route.address } }),
  );
  expect(await f.t.mutation(internal.automaticReplies.claimSend, { id: queued._id })).toBeNull();
  expect(await row(f)).toMatchObject({ status: "cancelled", attempts: 0 });

  vi.stubEnv("VERIFIED_SHOP_SENDERS", "{}");
  const review = await f.shop.client.query(api.humanReviews.get, { receiptId: f.receiptId });
  expect(review?.sendTarget).toBeNull();
});

test("adding a shop provisions a separate support identity in the same workspace", async () => {
  const f = await fixture();
  const shopId = await f.shop.client.mutation(api.shops.add, {
    organizationId: f.shop.organizationId,
    name: "Deuxième boutique",
  });
  const route = await f.shop.client.query(api.inboundEmailRoutes.getForShop, { shopId });
  expect(route?.address).toBeTruthy();
  expect(route?.address).not.toBe(f.route.address);
  expect((await f.shop.client.query(api.viewer.me)).shops.map((shop) => shop._id)).toContain(
    shopId,
  );
});

test("freezes recipient, thread headers, subject and response; dispatch is claimed only once", async () => {
  const f = await fixture(),
    r = await ready(f);
  expect(r.payload).toMatchObject({
    to: ["client@example.com"],
    reply_to: `hf_reply_${r.replyToken}@${f.route.domain}`,
    subject: "Re: Suivi de commande",
    headers: {
      "In-Reply-To": "<auto@example.com>",
      "Auto-Submitted": "auto-replied",
    },
  });
  expect(r.payload?.text).toContain("référence");
  const claim = await f.t.mutation(internal.automaticReplies.claimSend, { id: r._id });
  expect(claim).not.toBeNull();
  expect(await f.t.mutation(internal.automaticReplies.claimSend, { id: r._id })).toBeNull();
  await f.t.mutation(internal.automaticReplies.sent, {
    id: r._id,
    token: claim?.token ?? "",
    providerId: "resend-test",
  });
  expect((await requireRow(f)).status).toBe("sent");
  expect((await receipt(f))?.humanReview).toBeUndefined();
  await expect(
    f.shop.client.mutation(api.automaticReplies.cancel, { receiptId: f.receiptId }),
  ).rejects.toThrow("SendAlreadyStarted");
});

test.each([
  "disable",
  "rules",
  "manual",
  "route",
  "newer",
  "expire",
])("rechecks %s before provider dispatch", async (change) => {
  const f = await fixture(),
    r = await ready(f);
  if (change === "disable" || change === "rules")
    await f.shop.client.mutation(api.automaticReplySettings.save, {
      shopId: f.shop.shopId,
      enabled: change !== "disable",
      rules: [{ category: "order_status", priority: "high" }],
    });
  if (change === "manual")
    await f.shop.client.mutation(api.emailClassification.correct, {
      receiptId: f.receiptId,
      category: "order_status",
      priority: "normal",
    });
  if (change === "route") await f.t.run((ctx) => ctx.db.patch(f.route._id, { status: "disabled" }));
  if (change === "newer")
    await f.t.run(async (ctx) => {
      const m = await ctx.db
        .query("supportMessages")
        .withIndex("by_receiptId", (q) => q.eq("receiptId", f.receiptId))
        .unique();
      if (!m) throw new Error("Missing message");
      const { _id, _creationTime, ...data } = m;
      await ctx.db.insert("supportMessages", {
        ...data,
        receiptId: undefined,
        receivedAt: Date.now() + 1,
      });
    });
  if (change === "expire") vi.setSystemTime(Date.now() + AUTO_REPLY_WINDOW + 1);
  expect(await f.t.mutation(internal.automaticReplies.claimSend, { id: r._id })).toBeNull();
  expect((await requireRow(f)).status).toBe("cancelled");
});

test("owner and admin control rules; members and outsiders cannot change them", async () => {
  const f = await fixture(),
    outsider = await workspace(f.t, "outsider");
  await expect(
    outsider.client.query(api.automaticReplies.forEmail, { receiptId: f.receiptId }),
  ).rejects.toThrow("Forbidden");
  const membership = await f.t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", f.shop.organizationId))
      .unique(),
  );
  if (!membership) throw new Error("Missing membership");
  for (const role of ["agent", "viewer"] as const) {
    await f.t.run((ctx) => ctx.db.patch(membership._id, { role }));
    await expect(
      f.shop.client.mutation(api.automaticReplySettings.save, {
        shopId: f.shop.shopId,
        enabled: false,
        rules: [],
      }),
    ).rejects.toThrow("Forbidden");
  }
  await expect(
    f.shop.client.mutation(api.automaticReplies.cancel, { receiptId: f.receiptId }),
  ).rejects.toThrow("Forbidden");
  await f.t.run((ctx) => ctx.db.patch(membership._id, { role: "admin" }));
  await f.shop.client.mutation(api.automaticReplySettings.save, {
    shopId: f.shop.shopId,
    enabled: false,
    rules: [],
  });
  await expect(
    f.shop.client.mutation(api.automaticReplySettings.save, {
      shopId: f.shop.shopId,
      enabled: true,
      rules: [],
    }),
  ).rejects.toThrow("AutomaticRepliesUnavailable");
  await expect(
    f.shop.client.mutation(api.automaticReplySettings.save, {
      shopId: f.shop.shopId,
      enabled: false,
      rules: [classification, classification].map(({ category, priority }) => ({
        category,
        priority,
      })),
    }),
  ).rejects.toThrow("InvalidReplyRules");
});

test("human cancellation prevents generation completion from resuming automatic sending", async () => {
  const f = await fixture(),
    r = await requireRow(f),
    claim = await f.t.mutation(internal.automaticReplies.claimPreparation, { id: r._id });
  await f.shop.client.mutation(api.automaticReplies.cancel, { receiptId: f.receiptId });
  await f.t.mutation(internal.automaticReplies.prepared, {
    id: r._id,
    token: claim?.token ?? "",
    contextKey: claim?.contextKey ?? "",
    plan,
  });
  expect((await requireRow(f)).status).toBe("cancelled");
  expect((await receipt(f))?.humanReview?.status).toBe("open");
});

test("network retry keeps identical body and idempotency key, records acceptance only once", async () => {
  const f = await fixture(),
    r = await ready(f);
  const mock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Network lost"))
    .mockResolvedValue(Response.json({ id: "resend-one" }));
  vi.stubGlobal("fetch", mock);
  await f.t.action(internal.automaticReplyProcessing.send, { id: r._id });
  expect((await requireRow(f)).status).toBe("retrying");
  vi.setSystemTime(Date.now() + 60001);
  await f.t.action(internal.automaticReplyProcessing.send, { id: r._id });
  const requests = mock.mock.calls.map((call) => call[1] as RequestInit);
  expect(requests[0].body).toBe(requests[1].body);
  expect(requests[0].headers).toMatchObject({ "Idempotency-Key": `handlefast-auto/${r._id}` });
  expect(requests[1].headers).toEqual(requests[0].headers);
  expect(await requireRow(f)).toMatchObject({
    status: "sent",
    providerId: "resend-one",
    attempts: 2,
  });
  await f.t.action(internal.automaticReplyProcessing.send, { id: r._id });
  expect(mock).toHaveBeenCalledTimes(2);
});

test.each([
  { status: 422, name: "validation_error", expected: "failed" },
  { status: 409, name: "invalid_idempotent_request", expected: "failed" },
  { status: 409, name: "concurrent_idempotent_requests", expected: "retrying" },
  { status: 429, name: "rate_limit_exceeded", expected: "retrying" },
])("handles provider rejection %j", async ({ status, name, expected }) => {
  const f = await fixture(),
    r = await ready(f);
  const mock = vi.fn(async () => Response.json({ name }, { status }));
  vi.stubGlobal("fetch", mock);
  await f.t.action(internal.automaticReplyProcessing.send, { id: r._id });
  expect((await requireRow(f)).status).toBe(expected);
  expect(mock).toHaveBeenCalledTimes(1);
  if (expected === "failed") expect((await receipt(f))?.humanReview?.status).toBe("open");
});

test("uncertain recovery stops after the bounded window and cannot silently send later", async () => {
  const f = await fixture(),
    r = await ready(f);
  const first = await f.t.mutation(internal.automaticReplies.claimSend, { id: r._id });
  expect(first).not.toBeNull();
  vi.setSystemTime(Date.now() + AUTO_REPLY_WINDOW + 1);
  await f.t.mutation(internal.automaticReplies.recover, {});
  expect((await requireRow(f)).status).toBe("uncertain");
  expect((await receipt(f))?.humanReview?.status).toBe("open");
  expect(await f.t.mutation(internal.automaticReplies.claimSend, { id: r._id })).toBeNull();
});

test("retention removes the outbox and pending sends become no-ops", async () => {
  const f = await fixture(),
    r = await ready(f);
  await f.t.run((ctx) => ctx.db.patch(f.receiptId, { expiresAt: Date.now() - 1 }));
  await f.t.mutation(internal.emailRetention.expireReceipt, { receiptId: f.receiptId });
  expect(await row(f)).toBeNull();
  expect(await f.t.mutation(internal.automaticReplies.claimSend, { id: r._id })).toBeNull();
});

async function seedOrder(f: Fixture, email = "client@example.com") {
  const now = Date.now();
  return f.t.run(async (ctx) => {
    const connectionId = f.connectionId;
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

test.each([
  "fresh",
  "stale",
  "identity",
  "unknown",
  "changed",
])("automatic tracking uses cached facts only: %s", async (kind) => {
  const f = await fixture({ text: "Bonjour, où en est ma commande #SYNTHETIC1001 ?" });
  const order = await seedOrder(f);
  if (kind === "stale")
    await f.t.run((ctx) => ctx.db.patch(order.shipmentId, { syncedAt: Date.now() - 13 * 3600000 }));
  if (kind === "unknown")
    await f.t.run((ctx) => ctx.db.patch(order.shipmentId, { status: "NotFound" }));
  if (kind === "identity")
    await f.t.run(async (ctx) => {
      await ctx.db.patch(order.orderId, { email: "another@example.com" });
      await ctx.db.insert("orderLinks", {
        receiptId: f.receiptId,
        shopId: f.shop.shopId,
        orderId: order.orderId,
        profileId: f.shop.profileId,
        updatedAt: Date.now(),
      });
    });
  const r = await requireRow(f),
    claim = await f.t.mutation(internal.automaticReplies.claimPreparation, { id: r._id });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  if (claim) {
    if (kind === "changed")
      await f.t.run((ctx) => ctx.db.patch(order.shipmentId, { status: "Delivered" }));
    await f.t.mutation(internal.automaticReplies.prepared, {
      id: r._id,
      token: claim.token,
      contextKey: claim.contextKey,
      plan: { ...plan, intent: "tracking" },
    });
  }
  const result = await requireRow(f);
  if (kind === "fresh") {
    expect(result.status).toBe("ready");
    expect(result.payload?.text).toContain("En transit");
    expect(result.payload?.text).not.toContain("SYNTHETIC-NEVER-REGISTER");
  } else {
    expect(result.status).toBe("cancelled");
    expect((await receipt(f))?.humanReview?.status).toBe("open");
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

test("replies to per-response aliases stay in the same conversation and respect its cooldown", async () => {
  const f = await fixture(),
    r = await ready(f),
    claim = await f.t.mutation(internal.automaticReplies.claimSend, {
      id: (await requireRow(f))._id,
    });
  await f.t.mutation(internal.automaticReplies.sent, {
    id: r._id,
    token: claim?.token ?? "",
    providerId: "provider-test",
  });
  const now = Date.now() + 1;
  const original = await receipt(f);
  if (!original) throw new Error("Missing receipt");
  const { _id, _creationTime, ...data } = original;
  const receiptId = await f.t.run((ctx) =>
    ctx.db.insert("emailReceipts", {
      ...data,
      key: "followup",
      classification: undefined,
      humanReview: undefined,
      autoReplyEligibility: undefined,
      status: "processing",
      receivedAt: now,
    }),
  );
  await f.t.mutation(internal.inboundEmails.ingestFromWorker, {
    provider: "cloudflare_email_routing",
    deliveryKey: "followup",
    envelopeFrom: "client@example.com",
    envelopeTo: r.payload?.reply_to ?? "",
    from: { address: "client@example.com" },
    to: [{ address: f.route.address }],
    cc: [],
    replyTo: [],
    subject: "Re: Suivi de commande",
    text: "Je ne retrouve pas encore la référence.",
    headers: [],
    references: [],
    inReplyTo: "<provider-rewritten@example.com>",
    attachments: [],
    receivedAt: now,
    rawSize: 100,
    receiptId,
    processingAttempt: 1,
    triage: { bucket: "sav", source: "ai", reason: "post_purchase", version: 1 },
  });
  const next = await f.t.run((ctx) => ctx.db.get(receiptId));
  await f.t.mutation(internal.emailClassification.complete, {
    receiptId,
    token: next?.classificationJob?.token ?? "",
    classification,
  });
  const message = await f.t.run((ctx) =>
    ctx.db
      .query("supportMessages")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
      .unique(),
  );
  expect(message?.conversationId).toBe(r.conversationId);
  expect(
    await f.t.run((ctx) =>
      ctx.db
        .query("automaticReplies")
        .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
        .unique(),
    ),
  ).toBeNull();
  expect((await f.t.run((ctx) => ctx.db.get(receiptId)))?.humanReview?.status).toBe("open");
});

test("ordinary words following commande are not mistaken for an existing reference", () => {
  expect(orderReferences("Suivi de commande\nBonjour, où en est ma commande ?")).toEqual([]);
  expect(orderReferences("Commande #SYNTHETIC1001")).toEqual(["SYNTHETIC1001"]);
  expect(orderReferences("order ABC123")).toEqual(["ABC123"]);
});

test("reply aliases validate status, domain, retention and reception; another sender cannot join the thread", async () => {
  const f = await fixture(),
    r = await ready(f),
    address = r.payload?.reply_to ?? "";
  const reserve = (to: string) =>
    f.t.mutation(internal.emailReceipts.reserve, {
      envelopeFrom: "client@example.com",
      envelopeTo: to,
      sha256: `${"A".repeat(43)}=`,
      rawSize: 100,
    });
  expect((await reserve(address)).status).toBe("rejected");
  const claim = await f.t.mutation(internal.automaticReplies.claimSend, { id: r._id });
  await f.t.mutation(internal.automaticReplies.sent, {
    id: r._id,
    token: claim?.token ?? "",
    providerId: "provider",
  });
  expect((await reserve(address)).status).toBe("upload");
  expect((await reserve(address.replace("@handlefast.io", "@example.com"))).status).toBe(
    "rejected",
  );
  const separate = await f.t.run((ctx) =>
    getOrCreateConversationId(ctx, {
      route: f.route,
      replyAddress: address,
      customerEmail: "another@example.com",
      subject: "Followup",
      inReplyTo: null,
      references: [],
      now: Date.now(),
      receivedAt: Date.now(),
    }),
  );
  expect(separate).not.toBe(r.conversationId);
  await f.t.run((ctx) => ctx.db.patch(f.route._id, { status: "disabled" }));
  expect((await reserve(address)).status).toBe("rejected");
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.route._id, { status: "active" });
    await ctx.db.patch(f.receiptId, { expiresAt: Date.now() - 1 });
  });
  expect((await reserve(address)).status).toBe("rejected");
});

test("a later definitive error cannot erase an earlier unknown sending outcome", async () => {
  const f = await fixture(),
    r = await ready(f);
  const mock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Network lost"))
    .mockResolvedValue(Response.json({ name: "validation_error" }, { status: 422 }));
  vi.stubGlobal("fetch", mock);
  await f.t.action(internal.automaticReplyProcessing.send, { id: r._id });
  vi.setSystemTime(Date.now() + 60001);
  await f.t.action(internal.automaticReplyProcessing.send, { id: r._id });
  expect(await requireRow(f)).toMatchObject({ status: "uncertain", acceptanceUncertain: true });
  expect((await receipt(f))?.humanReview?.status).toBe("open");
});
