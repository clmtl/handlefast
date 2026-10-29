/// <reference types="vite/client" />
import betterAuthTest from "@convex-dev/better-auth/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import { ensureDeliveryPromise } from "./lib/deliveryContext";
import {
  DAY,
  deliveryDeadline,
  localTime,
  nextDeliveryRun,
  validDay,
  validDeliveryConfig,
} from "./lib/deliveryPolicy";
import { cachedOrderContext } from "./orderContext";
import schema from "./schema";
import { persistOrder } from "./shopifySync";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const config = {
  maxDays: 3,
  calendar: "calendar" as const,
  timezone: "Europe/Paris",
  hour: 9,
  locale: "fr" as const,
  holidays: [] as string[],
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-01T10:00:00Z"));
  vi.stubEnv("RESEND_API_KEY", "synthetic");
  vi.stubEnv("OPENAI_API_KEY", "synthetic");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected external request");
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
        expiresAt: now + 365 * DAY,
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

async function fixture(live = false) {
  const t = createBackend(),
    shop = await workspace(t, "delivery");
  const route = await shop.client.query(api.inboundEmailRoutes.getForShop, { shopId: shop.shopId });
  if (!route) throw new Error("Missing route");
  const connectionId = await t.run((ctx) =>
    ctx.db.insert("shopifyConnections", {
      shopId: shop.shopId,
      organizationId: shop.organizationId,
      domain: "fixture.myshopify.com",
      shopifyShopId: "gid://shopify/Shop/1",
      clientId: "synthetic",
      secret: "never-decrypt",
      token: "never-decrypt",
      tokenExpiresAt: Date.now() + 365 * DAY,
      scopes: ["read_orders"],
      generation: "g1",
      status: "active",
      nextSyncAt: Date.now() + 365 * DAY,
      syncedAt: Date.now(),
      createdAt: Date.now(),
    }),
  );
  await shop.client.mutation(api.deliveryMonitoring.save, {
    shopId: shop.shopId,
    mode: "simulation",
    ...config,
  });
  const f = { t, shop, route, connectionId };
  await finishScan(f, true);
  if (live) {
    await shop.client.mutation(api.deliveryMonitoring.save, {
      shopId: shop.shopId,
      mode: "live",
      ...config,
    });
    await finishScan(f, true);
  }
  vi.setSystemTime(Date.now() + 3600000);
  const orderId = await t.run(async (ctx) => {
    const connection = await ctx.db.get(connectionId);
    if (!connection) throw new Error("Missing connection");
    return persistOrder(ctx, connection, {
      gid: "gid://shopify/Order/8001",
      name: "#QA8001",
      email: "client@example.com",
      placedAt: Date.now(),
      sourceUpdatedAt: Date.now(),
      financialStatus: "PAID",
      fulfillmentStatus: "UNFULFILLED",
      cancelled: false,
      total: "49.00",
      refunded: "0.00",
      currency: "EUR",
      items: [{ id: "item", title: "Synthetic", quantity: 1, sku: "PRIVATE", variant: "" }],
      detailsTruncated: false,
      tracking: [],
    });
  });
  vi.setSystemTime(Date.now() + 5 * DAY);
  await t.run((ctx) => ctx.db.patch(connectionId, { syncedAt: Date.now() }));
  return { ...f, orderId };
}
type Base = { t: ReturnType<typeof createBackend>; shop: Awaited<ReturnType<typeof workspace>> };
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function policy(f: Base) {
  return f.t.run((ctx) =>
    ctx.db
      .query("deliveryPolicies")
      .withIndex("by_shopId", (q) => q.eq("shopId", f.shop.shopId))
      .unique(),
  );
}
async function finishScan(f: Base, simulation: boolean) {
  const p = await policy(f);
  if (!p?.scanToken) throw new Error("Missing scan");
  await f.t.mutation(internal.deliveryMonitoring.scanPage, {
    shopId: f.shop.shopId,
    token: p.scanToken,
    revision: p.revision,
    simulation,
    cursor: null,
  });
}
async function scan(f: Base, simulation = true) {
  if (simulation)
    await f.shop.client.mutation(api.deliveryMonitoring.simulate, { shopId: f.shop.shopId });
  else {
    const p = await policy(f);
    if (!p) throw new Error("Missing policy");
    await f.t.run((ctx) => ctx.db.patch(p._id, { nextRunAt: Date.now() - 1 }));
    await f.t.mutation(internal.deliveryMonitoring.recover, {});
  }
  await finishScan(f, simulation);
}
async function notice(f: Fixture) {
  const n = await f.t.run((ctx) =>
    ctx.db
      .query("delayNotices")
      .withIndex("by_shopId_and_orderGid", (q) =>
        q.eq("shopId", f.shop.shopId).eq("orderGid", "gid://shopify/Order/8001"),
      )
      .unique(),
  );
  if (!n) throw new Error("Missing notice");
  return n;
}
async function order(f: Fixture) {
  const o = await f.t.run((ctx) => ctx.db.get(f.orderId));
  if (!o) throw new Error("Missing order");
  return o;
}
async function contact(
  f: Fixture,
  text = "Bonjour, où en est ma commande #QA8001 ?",
  extra: { envelopeTo?: string; from?: string; bucket?: "sav" | "other" } = {},
) {
  const now = Date.now(),
    key = `contact-${crypto.randomUUID()}`,
    to = extra.envelopeTo ?? f.route.address,
    from = extra.from ?? "client@example.com";
  const receiptId = await f.t.run((ctx) =>
    ctx.db.insert("emailReceipts", {
      organizationId: f.shop.organizationId,
      shopId: f.shop.shopId,
      routeId: f.route._id,
      key,
      envelopeFrom: from,
      envelopeTo: to,
      sha256: "synthetic",
      rawSize: 100,
      status: "processing",
      receivedAt: now,
      expiresAt: now + 365 * DAY,
      attempts: 1,
      nextAttemptAt: now,
      updatedAt: now,
    }),
  );
  await f.t.mutation(internal.inboundEmails.ingestFromWorker, {
    provider: "cloudflare_email_routing",
    deliveryKey: key,
    envelopeFrom: from,
    envelopeTo: to,
    from: { address: from },
    to: [{ address: to }],
    cc: [],
    replyTo: [],
    subject: "Votre commande",
    text,
    headers: [],
    messageId: `<${key}@example.com>`,
    references: [],
    attachments: [],
    receivedAt: now,
    rawSize: 100,
    receiptId,
    processingAttempt: 1,
    triage: { bucket: extra.bucket ?? "sav", reason: "post_purchase", source: "ai", version: 1 },
  });
  return receiptId;
}

test("deadline counts calendar days to local end of day and preserves DST", () => {
  const placed = Date.parse("2026-03-28T12:00:00Z");
  expect(new Date(deliveryDeadline(placed, { ...config, maxDays: 1 })).toISOString()).toBe(
    "2026-03-29T21:59:59.999Z",
  );
  expect(
    new Date(nextDeliveryRun(Date.parse("2026-03-28T23:00:00Z"), "Europe/Paris", 9)).toISOString(),
  ).toBe("2026-03-29T07:00:00.000Z");
  expect(
    new Date(nextDeliveryRun(Date.parse("2026-10-24T23:00:00Z"), "Europe/Paris", 9)).toISOString(),
  ).toBe("2026-10-25T08:00:00.000Z");
  expect(new Date(localTime("2026-03-29", 2, "Europe/Paris")).toISOString()).toBe(
    "2026-03-29T01:00:00.000Z",
  );
});
test("business days skip weekends and explicit closed days; configuration rejects invalid dates/timezones", () => {
  expect(
    new Date(
      deliveryDeadline(Date.parse("2026-10-30T12:00Z"), {
        ...config,
        maxDays: 1,
        calendar: "business",
        holidays: ["2026-11-02"],
      }),
    ).toISOString(),
  ).toBe("2026-11-03T22:59:59.999Z");
  expect(validDay("2028-02-29")).toBe(true);
  expect(validDay("2026-02-29")).toBe(false);
  for (const bad of [
    { maxDays: 0 },
    { maxDays: 91 },
    { maxDays: NaN },
    { hour: 24 },
    { hour: 0.5 },
    { timezone: "Invalid/Timezone" },
    { holidays: ["2026-02-29"] },
    { holidays: ["2026-12-25", "2026-12-25"] },
  ])
    expect(validDeliveryConfig({ ...config, ...bad })).toBe(false);
});

test("default configuration is absent; simulation is the first configured mode and never sends", async () => {
  const t = createBackend(),
    shop = await workspace(t, "default");
  expect(
    (await shop.client.query(api.deliveryMonitoring.get, { shopId: shop.shopId })).config,
  ).toBeNull();
  const f = await fixture();
  await scan(f);
  const n = await notice(f);
  expect(n).toMatchObject({
    status: "none",
    reason: "eligible",
    evaluatedMode: "simulation",
    attempts: 0,
    estimated: false,
    attention: true,
  });
  expect(n.payload).toBeUndefined();
  expect(await f.t.mutation(internal.deliveryMonitoring.claimSend, { id: n._id })).toBeNull();
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  const list = await f.shop.client.query(api.deliveryMonitoring.list, {
    shopId: f.shop.shopId,
    history: false,
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(list.page[0]).toMatchObject({ simulation: true, reason: "eligible" });
  expect(list.page[0].text).toContain("#QA8001");
});

test("live activation requires a completed simulation of unchanged settings and applies only to new orders", async () => {
  const f = await fixture();
  await expect(
    f.shop.client.mutation(api.deliveryMonitoring.save, {
      shopId: f.shop.shopId,
      mode: "live",
      ...config,
    }),
  ).rejects.toThrow("SimulateBeforeLive");
  await scan(f);
  await f.shop.client.mutation(api.deliveryMonitoring.save, {
    shopId: f.shop.shopId,
    mode: "live",
    ...config,
  });
  await finishScan(f, true);
  await scan(f, false);
  expect(await notice(f)).toMatchObject({ status: "none", reason: "historical", attempts: 0 });
  await expect(
    f.shop.client.mutation(api.deliveryMonitoring.save, {
      shopId: f.shop.shopId,
      mode: "live",
      ...config,
      maxDays: 5,
    }),
  ).rejects.toThrow("SimulateBeforeLive");
});

test("promises use effective rules and retain the original deadline across configuration changes", async () => {
  const f = await fixture(),
    initial = await notice(f);
  await f.shop.client.mutation(api.deliveryMonitoring.save, {
    shopId: f.shop.shopId,
    mode: "simulation",
    ...config,
    maxDays: 10,
  });
  await finishScan(f, true);
  await f.t.run(async (ctx) => {
    const o = await ctx.db.get(f.orderId);
    if (o) await ensureDeliveryPromise(ctx, o);
  });
  expect((await notice(f)).deadlineAt).toBe(initial.deadlineAt);
  const o = await order(f);
  const { _id, _creationTime, ...data } = o;
  const id = await f.t.run((ctx) =>
    ctx.db.insert("shopifyOrders", {
      ...data,
      gid: "gid://shopify/Order/8002",
      name: "#QA8002",
      placedAt: Date.now(),
    }),
  );
  await f.t.run(async (ctx) => {
    const next = await ctx.db.get(id);
    if (next) await ensureDeliveryPromise(ctx, next);
  });
  const newer = await f.t.run((ctx) =>
    ctx.db
      .query("delayNotices")
      .withIndex("by_shopId_and_orderGid", (q) =>
        q.eq("shopId", f.shop.shopId).eq("orderGid", "gid://shopify/Order/8002"),
      )
      .unique(),
  );
  expect(newer?.promise.maxDays).toBe(10);
});

test.each([
  "cancelled",
  "refunded",
  "unpaid",
  "stale",
  "recipient",
  "disconnected",
  "reception",
  "not_due",
  "tracking_issue",
  "delivered",
])("blocks or excludes %s before any send", async (reason) => {
  const f = await fixture(true);
  if (reason === "cancelled") await f.t.run((ctx) => ctx.db.patch(f.orderId, { cancelled: true }));
  if (reason === "refunded")
    await f.t.run((ctx) => ctx.db.patch(f.orderId, { financialStatus: "REFUNDED" }));
  if (reason === "unpaid")
    await f.t.run((ctx) =>
      ctx.db.patch(f.orderId, { financialStatus: "PARTIALLY_REFUNDED", refunded: "5.00" }),
    );
  if (reason === "stale")
    await f.t.run((ctx) => ctx.db.patch(f.connectionId, { syncedAt: Date.now() - 2 * DAY }));
  if (reason === "recipient") await f.t.run((ctx) => ctx.db.patch(f.orderId, { email: "invalid" }));
  if (reason === "disconnected")
    await f.t.run((ctx) => ctx.db.patch(f.connectionId, { status: "disconnected" }));
  if (reason === "reception")
    await f.t.run((ctx) => ctx.db.patch(f.route._id, { status: "disabled" }));
  if (reason === "not_due") {
    const n = await notice(f);
    await f.t.run((ctx) => ctx.db.patch(n._id, { deadlineAt: Date.now() + DAY }));
  }
  if (reason === "tracking_issue")
    await f.t.run((ctx) => ctx.db.patch(f.orderId, { fulfillmentStatus: "FULFILLED" }));
  if (reason === "delivered") await shipment(f, "Delivered");
  await scan(f, false);
  expect(await notice(f)).toMatchObject({ reason, status: "none", attempts: 0 });
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});
async function shipment(f: Fixture, status = "InTransit") {
  await f.t.run((ctx) => ctx.db.patch(f.orderId, { fulfillmentStatus: "FULFILLED" }));
  return f.t.run((ctx) =>
    ctx.db.insert("orderShipments", {
      shopId: f.shop.shopId,
      organizationId: f.shop.organizationId,
      connectionId: f.connectionId,
      generation: "g1",
      orderId: f.orderId,
      number: `SYNTHETIC-DO-NOT-REGISTER-${crypto.randomUUID()}`,
      company: "Fixture",
      fulfillmentId: "f1",
      registered: true,
      status,
      events: [],
      syncedAt: Date.now(),
      active: true,
      nextAttemptAt: Date.now() + 365 * DAY,
    }),
  );
}

test("partial delivery watches remaining parcels; stale or failed parcels prevent reassurance", async () => {
  const f = await fixture(true);
  await shipment(f, "Delivered");
  const second = await shipment(f, "InTransit");
  await scan(f);
  expect((await notice(f)).reason).toBe("eligible");
  await f.t.run((ctx) => ctx.db.patch(second, { syncedAt: Date.now() - 13 * 3600000 }));
  await scan(f);
  expect((await notice(f)).reason).toBe("stale");
  await f.t.run((ctx) => ctx.db.patch(second, { syncedAt: Date.now(), status: "Returned" }));
  await scan(f);
  expect((await notice(f)).reason).toBe("tracking_issue");
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

test.each([
  { text: "Où en est ma commande #QA8001 ?", reason: "contacted" },
  { text: "Bonjour, pouvez-vous m’aider ?", reason: "ambiguous_contact" },
  { text: "Ma commande #UNKNOWN100 est en retard", reason: "ambiguous_contact" },
])("existing customer contact blocks %j", async ({ text, reason }) => {
  const f = await fixture(true);
  await contact(f, text);
  await scan(f, false);
  expect(await notice(f)).toMatchObject({ status: "none", reason });
});

test("contact about another known order does not block this one; unrelated mail is ignored", async () => {
  const f = await fixture(true),
    o = await order(f);
  const { _id, _creationTime, ...data } = o;
  await f.t.run((ctx) =>
    ctx.db.insert("shopifyOrders", {
      ...data,
      gid: "gid://shopify/Order/9002",
      name: "#OTHER9002",
      cancelled: true,
    }),
  );
  await contact(f, "J’ai une question sur ma commande #OTHER9002");
  await contact(f, "Offre publicitaire", { bucket: "other" });
  await scan(f, false);
  expect((await notice(f)).status).toBe("queued");
});

test("an unparsed forwarded email holds proactive sending until intake completes", async () => {
  const f = await fixture(true);
  await f.t.run((ctx) =>
    ctx.db.insert("emailReceipts", {
      organizationId: f.shop.organizationId,
      shopId: f.shop.shopId,
      routeId: f.route._id,
      key: "forwarded-pending",
      envelopeFrom: "forwarder@example.com",
      envelopeTo: f.route.address,
      sha256: "synthetic",
      rawSize: 100,
      status: "queued",
      receivedAt: Date.now(),
      expiresAt: Date.now() + DAY,
      attempts: 0,
      nextAttemptAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await scan(f, false);
  expect(await notice(f)).toMatchObject({ status: "none", reason: "pending_email" });
});

test("live sends once per stable Shopify order identity, even after duplicate scans and cache replacement", async () => {
  const f = await fixture(true);
  await scan(f, false);
  const n = await notice(f);
  expect(n.status).toBe("queued");
  const mock = vi.fn(async () => Response.json({ id: "accepted-notice" }));
  vi.stubGlobal("fetch", mock);
  await f.t.action(internal.deliveryNotificationProcessing.send, { id: n._id });
  expect(await notice(f)).toMatchObject({
    status: "sent",
    attempts: 1,
    providerId: "accepted-notice",
  });
  await scan(f, false);
  await f.t.action(internal.deliveryNotificationProcessing.send, { id: n._id });
  expect(mock).toHaveBeenCalledTimes(1);
  const o = await order(f);
  const { _id, _creationTime, ...data } = o;
  const replacement = await f.t.run(async (ctx) => {
    await ctx.db.delete(f.orderId);
    const id = await ctx.db.insert("shopifyOrders", data);
    const next = await ctx.db.get(id);
    if (next) await ensureDeliveryPromise(ctx, next);
    return id;
  });
  expect(await notice(f)).toMatchObject({
    _id: n._id,
    orderId: replacement,
    status: "sent",
    attempts: 1,
  });
  expect((await notice(f)).payload?.to).toEqual(["client@example.com"]);
});

test.each([
  "contact",
  "disable",
  "config",
  "context",
  "expired",
])("rechecks %s at dispatch time", async (change) => {
  const f = await fixture(true);
  await scan(f, false);
  const n = await notice(f);
  if (change === "contact") await contact(f);
  if (change === "disable" || change === "config")
    await f.shop.client.mutation(api.deliveryMonitoring.save, {
      shopId: f.shop.shopId,
      mode: change === "disable" ? "off" : "simulation",
      ...config,
      maxDays: change === "config" ? 5 : config.maxDays,
    });
  if (change === "context")
    await f.t.run((ctx) => ctx.db.patch(f.orderId, { sourceUpdatedAt: Date.now() + 1 }));
  if (change === "expired") vi.setSystemTime(Date.now() + 3 * 3600000);
  expect(await f.t.mutation(internal.deliveryMonitoring.claimSend, { id: n._id })).toBeNull();
  expect((await notice(f)).status).toBe("cancelled");
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

test("frozen retry uses one idempotency key and retains ambiguous outcomes", async () => {
  const f = await fixture(true);
  await scan(f, false);
  const n = await notice(f),
    mock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("lost response"))
      .mockResolvedValue(Response.json({ id: "accepted" }));
  vi.stubGlobal("fetch", mock);
  await f.t.action(internal.deliveryNotificationProcessing.send, { id: n._id });
  expect((await notice(f)).status).toBe("retrying");
  vi.setSystemTime(Date.now() + 60001);
  await f.t.action(internal.deliveryNotificationProcessing.send, { id: n._id });
  expect((await notice(f)).status).toBe("sent");
  expect(mock.mock.calls[0][1].body).toBe(mock.mock.calls[1][1].body);
  expect(mock.mock.calls[0][1].headers["Idempotency-Key"]).toBe(`handlefast-delay/${n._id}`);
});

test("lost acceptance followed by rejection remains uncertain; recovery never sends after its deadline", async () => {
  const f = await fixture(true);
  await scan(f, false);
  const n = await notice(f),
    mock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("lost"))
      .mockResolvedValue(Response.json({ name: "validation_error" }, { status: 422 }));
  vi.stubGlobal("fetch", mock);
  await f.t.action(internal.deliveryNotificationProcessing.send, { id: n._id });
  vi.setSystemTime(Date.now() + 60001);
  await f.t.action(internal.deliveryNotificationProcessing.send, { id: n._id });
  expect((await notice(f)).status).toBe("uncertain");
  vi.setSystemTime(Date.now() + DAY);
  await f.t.mutation(internal.deliveryMonitoring.recover, {});
  await f.t.action(internal.deliveryNotificationProcessing.send, { id: n._id });
  expect(mock).toHaveBeenCalledTimes(2);
});

test("replies to notices become human SAV conversations with the correct cached order", async () => {
  const f = await fixture(true);
  await scan(f, false);
  const n = await notice(f),
    claim = await f.t.mutation(internal.deliveryMonitoring.claimSend, { id: n._id });
  if (!claim) throw new Error("Missing claim");
  await f.t.mutation(internal.deliveryMonitoring.sent, {
    id: n._id,
    token: claim.token,
    providerId: "provider",
  });
  const receiptId = await contact(f, "Merci, mais le colis n’est pas arrivé.", {
    envelopeTo: claim.payload.reply_to,
    bucket: "other",
  });
  const receipt = await f.t.run((ctx) => ctx.db.get(receiptId));
  expect(receipt?.triage).toMatchObject({ bucket: "sav", source: "rules" });
  expect(receipt?.proactiveNoticeId).toBe(n._id);
  const message = await f.t.run((ctx) =>
    ctx.db
      .query("supportMessages")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
      .unique(),
  );
  expect(message?.conversationId).toBe(n.conversationId);
  const cached = await f.t.run(async (ctx) => {
    const r = await ctx.db.get(receiptId);
    if (!r || !message) throw new Error("Missing");
    return cachedOrderContext(ctx, r, message);
  });
  expect(cached?.selected?._id).toBe(f.orderId);
  expect(receipt?.humanReview?.status).toBe("open");
  expect(
    await f.t.run((ctx) =>
      ctx.db
        .query("automaticReplies")
        .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
        .unique(),
    ),
  ).toBeNull();
});

test("owners/admins manage policy, agents can cancel queued notices, viewers and other shops cannot", async () => {
  const f = await fixture(true),
    outside = await workspace(f.t, "outside");
  await scan(f, false);
  const n = await notice(f);
  await expect(
    outside.client.query(api.deliveryMonitoring.list, {
      shopId: f.shop.shopId,
      history: false,
      paginationOpts: { cursor: null, numItems: 10 },
    }),
  ).rejects.toThrow("Forbidden");
  const member = await f.t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", f.shop.organizationId))
      .unique(),
  );
  if (!member) throw new Error("Missing membership");
  for (const role of ["viewer", "agent"] as const) {
    await f.t.run((ctx) => ctx.db.patch(member._id, { role }));
    await expect(
      f.shop.client.mutation(api.deliveryMonitoring.save, {
        shopId: f.shop.shopId,
        mode: "off",
        ...config,
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      f.shop.client.mutation(api.deliveryMonitoring.simulate, { shopId: f.shop.shopId }),
    ).rejects.toThrow("Forbidden");
    if (role === "viewer")
      await expect(
        f.shop.client.mutation(api.deliveryMonitoring.cancel, { id: n._id }),
      ).rejects.toThrow("Forbidden");
  }
  await f.shop.client.mutation(api.deliveryMonitoring.cancel, { id: n._id });
  expect((await notice(f)).status).toBe("cancelled");
  await f.t.run((ctx) => ctx.db.patch(member._id, { role: "owner" }));
  await scan(f, false);
  expect((await notice(f)).status).toBe("cancelled");
});

test("expired notices and aliases are removed while sent deduplication survives a connection purge", async () => {
  const f = await fixture(true);
  await scan(f, false);
  const n = await notice(f);
  await f.t.run((ctx) => ctx.db.patch(n._id, { expiresAt: Date.now() - 1 }));
  await f.t.mutation(internal.deliveryMonitoring.recover, {});
  expect(await f.t.run((ctx) => ctx.db.get(n._id))).toBeNull();
  expect(await f.t.mutation(internal.deliveryMonitoring.claimSend, { id: n._id })).toBeNull();
});

test("recovery is bounded to three attempts and terminal provider errors remain visible", async () => {
  const f = await fixture(true);
  await scan(f, false);
  const n = await notice(f),
    mock = vi.fn(async () => Response.json({ name: "rate_limit_exceeded" }, { status: 429 }));
  vi.stubGlobal("fetch", mock);
  for (let i = 0; i < 4; i++) {
    await f.t.action(internal.deliveryNotificationProcessing.send, { id: n._id });
    vi.setSystemTime(Date.now() + 60001);
  }
  expect(mock).toHaveBeenCalledTimes(3);
  expect(await notice(f)).toMatchObject({ status: "failed", attempts: 3, attention: true });
});

test("interrupted sends recover using the original payload and mark expired acceptance as uncertain", async () => {
  const f = await fixture(true);
  await scan(f, false);
  const n = await notice(f),
    claim = await f.t.mutation(internal.deliveryMonitoring.claimSend, { id: n._id });
  expect(claim).not.toBeNull();
  vi.setSystemTime(Date.now() + 120001);
  await f.t.mutation(internal.deliveryMonitoring.recover, {});
  expect(await notice(f)).toMatchObject({ status: "retrying", acceptanceUncertain: true });
  vi.setSystemTime(Date.now() + 3 * 3600000);
  await f.t.mutation(internal.deliveryMonitoring.recover, {});
  expect((await notice(f)).status).toBe("uncertain");
  expect(await f.t.mutation(internal.deliveryMonitoring.claimSend, { id: n._id })).toBeNull();
});

test("pagination scans beyond the first batch and a repeated cron cannot start a second scan", async () => {
  const f = await fixture(),
    o = await order(f);
  const { _id, _creationTime, ...data } = o;
  await f.t.run(async (ctx) => {
    for (let i = 0; i < 24; i++)
      await ctx.db.insert("shopifyOrders", {
        ...data,
        gid: `gid://shopify/Order/batch${i}`,
        name: `#BATCH${i}`,
      });
  });
  await f.shop.client.mutation(api.deliveryMonitoring.simulate, { shopId: f.shop.shopId });
  const first = await policy(f);
  await f.t.mutation(internal.deliveryMonitoring.recover, {});
  expect((await policy(f))?.scanToken).toBe(first?.scanToken);
  await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
  expect((await policy(f))?.scanToken).toBeUndefined();
  const page = await f.shop.client.query(api.deliveryMonitoring.list, {
    shopId: f.shop.shopId,
    history: false,
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(page.page).toHaveLength(10);
  expect(page.isDone).toBe(false);
  const next = await f.shop.client.query(api.deliveryMonitoring.list, {
    shopId: f.shop.shopId,
    history: false,
    paginationOpts: { cursor: page.continueCursor, numItems: 25 },
  });
  expect(next.page).toHaveLength(15);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});

test("a different sender cannot join a proactive conversation or obtain its cached order", async () => {
  const f = await fixture(true);
  await scan(f, false);
  const n = await notice(f),
    claim = await f.t.mutation(internal.deliveryMonitoring.claimSend, { id: n._id });
  if (!claim) throw new Error("Missing claim");
  await f.t.mutation(internal.deliveryMonitoring.sent, {
    id: n._id,
    token: claim.token,
    providerId: "provider",
  });
  const id = await contact(f, "Mon colis ?", {
    envelopeTo: claim.payload.reply_to,
    from: "another@example.com",
  });
  const receipt = await f.t.run((ctx) => ctx.db.get(id));
  const message = await f.t.run((ctx) =>
    ctx.db
      .query("supportMessages")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", id))
      .unique(),
  );
  expect(receipt?.proactiveNoticeId).toBeUndefined();
  expect(message?.conversationId).not.toBe(n.conversationId);
  const cached = await f.t.run(async (ctx) => {
    const r = await ctx.db.get(id);
    if (!r || !message) throw new Error("Missing");
    return cachedOrderContext(ctx, r, message);
  });
  expect(cached?.selected).toBeNull();
});

test("accepted history retains the actual recipient when the order email later changes", async () => {
  const f = await fixture(true);
  await scan(f, false);
  const n = await notice(f),
    claim = await f.t.mutation(internal.deliveryMonitoring.claimSend, { id: n._id });
  if (!claim) throw new Error("Missing claim");
  await f.t.mutation(internal.deliveryMonitoring.sent, {
    id: n._id,
    token: claim.token,
    providerId: "accepted",
  });
  await f.t.run((ctx) => ctx.db.patch(f.orderId, { email: "new-address@example.com" }));
  await scan(f, false);
  const page = await f.shop.client.query(api.deliveryMonitoring.list, {
    shopId: f.shop.shopId,
    history: true,
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(page.page[0].email).toBe("client@example.com");
});
