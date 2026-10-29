/// <reference types="vite/client" />
import betterAuthTest from "@convex-dev/better-auth/test";
import type { UserIdentity } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import { decrypt, encrypt, sha256 } from "./lib/commerceSecrets";
import { TRIAGE_VERSION } from "./lib/emailTriagePolicy";
import schema from "./schema";
import { storeConnection } from "./shopifyConnection";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
function backend() {
  const t = convexTest({ schema, modules });
  betterAuthTest.register(t);
  return t;
}
async function workspace(t: ReturnType<typeof backend>, seed: string) {
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
        token: seed,
        userId: user._id,
        expiresAt: now + 3600_000,
        createdAt: now,
        updatedAt: now,
      },
    },
  })) as { _id: string };
  const identity = {
    issuer: "https://test.convex.site",
    subject: user._id,
    tokenIdentifier: `https://test.convex.site|${user._id}`,
    sessionId: session._id,
  } as Partial<UserIdentity>;
  const client = t.withIdentity(identity);
  const result = await client.mutation(api.onboarding.bootstrap, {
    organizationName: seed,
    shopName: seed,
  });
  if (!result.shopId) throw new Error("Missing shop");
  return { ...result, client, shopId: result.shopId };
}
async function connect(
  t: ReturnType<typeof backend>,
  w: Awaited<ReturnType<typeof workspace>>,
  domain = "test.myshopify.com",
  clientId = "a".repeat(32),
) {
  await t.run(async (ctx) =>
    storeConnection(ctx, {
      shopId: w.shopId,
      organizationId: w.organizationId,
      domain,
      shopifyShopId: "gid://shopify/Shop/1",
      clientId,
      secret: await encrypt("secret-secret-secret", `shopify:${w.shopId}`),
      token: await encrypt("test-access-token", `shopify:${w.shopId}`),
      tokenExpiresAt: Date.now() + 3600_000,
      scopes: ["read_orders"],
    }),
  );
  const row = await t.run((ctx) =>
    ctx.db
      .query("shopifyConnections")
      .withIndex("by_shopId", (q) => q.eq("shopId", w.shopId))
      .unique(),
  );
  if (!row) throw new Error("Missing connection");
  await t.run((ctx) => ctx.db.patch(row._id, { webhooksConfiguredAt: Date.now() }));
  return { row };
}
function order(gid = "gid://shopify/Order/1234", email = "customer@example.com") {
  return {
    gid,
    name: "#1234",
    email,
    placedAt: Date.now(),
    sourceUpdatedAt: Date.now(),
    financialStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    cancelled: false,
    total: "42.00",
    refunded: "0.00",
    currency: "EUR",
    items: [{ id: "line1", title: "T-shirt", quantity: 2, variant: "Blue", sku: "TEE" }],
    detailsTruncated: false,
    tracking: [
      { number: "TRACK1234", company: "Carrier", fulfillmentId: "f1" },
      { number: "TRACK5678", company: "Carrier", fulfillmentId: "f2" },
    ],
  };
}
async function email(
  t: ReturnType<typeof backend>,
  w: Awaited<ReturnType<typeof workspace>>,
  subject = "Commande #1234",
  from = "customer@example.com",
) {
  const route = await w.client.query(api.inboundEmailRoutes.getForShop, { shopId: w.shopId });
  if (!route) throw new Error("Missing route");
  const receiptId = await t.run((ctx) =>
    ctx.db.insert("emailReceipts", {
      organizationId: w.organizationId,
      shopId: w.shopId,
      routeId: route._id,
      key: `${subject}:${from}`,
      envelopeFrom: from,
      envelopeTo: route.address,
      sha256: "hash",
      rawSize: 100,
      receivedAt: Date.now(),
      expiresAt: Date.now() + 86400_000,
      status: "processing",
      attempts: 1,
      nextAttemptAt: Date.now() + 300_000,
      updatedAt: Date.now(),
    }),
  );
  await t.mutation(internal.inboundEmails.ingestFromWorker, {
    receiptId,
    processingAttempt: 1,
    provider: "cloudflare_email_routing",
    deliveryKey: `${subject}:${from}`,
    envelopeFrom: from,
    envelopeTo: route.address,
    from: { address: from },
    to: [{ address: route.address }],
    cc: [],
    replyTo: [],
    subject,
    text: "Mon colis est-il en route ?",
    headers: [],
    references: [],
    attachments: [],
    receivedAt: Date.now(),
    rawSize: 100,
    triage: { bucket: "sav", reason: "unclear", source: "ai", version: TRIAGE_VERSION },
  });
  return receiptId;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("COMMERCE_ENCRYPTION_KEY", btoa("k".repeat(32)));
  vi.stubEnv("SITE_URL", "http://localhost:3000");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("shopify connection and tenant isolation", () => {
  test("pairs to the originating organization, conceals credentials, rejects replay and cross-tenant claims", async () => {
    const t = backend(),
      owner = await workspace(t, "owner"),
      outsider = await workspace(t, "outsider");
    const { row } = await connect(t, owner);
    expect(row.organizationId).toBe(owner.organizationId);
    const status = await owner.client.query(api.shopifyConnection.status, { shopId: owner.shopId });
    expect(status.connected).toBe(true);
    expect(status).not.toHaveProperty("secret");
    expect(status).not.toHaveProperty("token");
    await expect(
      outsider.client.query(api.shopifyConnection.status, { shopId: owner.shopId }),
    ).rejects.toThrow("Forbidden");
    await expect(
      outsider.client.mutation(internal.shopifyGuided.reserve, {
        shopId: outsider.shopId,
        domain: row.domain,
      }),
    ).rejects.toThrow("ShopAlreadyConnected");
    await owner.client.mutation(api.shopifyConnection.disconnect, { shopId: owner.shopId });
    expect(
      await t.query(internal.shopifyConnection.credentials, { connectionId: row._id }),
    ).toBeNull();
    const removed = await t.run((ctx) => ctx.db.get(row._id));
    expect(removed?.secret).toBe("");
    expect(removed?.token).toBe("");
  });
  test("accepts a signed Shopify uninstall and rejects a forged uninstall", async () => {
    const t = backend(),
      w = await workspace(t, "uninstall"),
      { row } = await connect(t, w);
    const body = JSON.stringify({ id: 1 });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("secret-secret-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = btoa(
      String.fromCharCode(
        ...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))),
      ),
    );
    const headers = {
      "x-shopify-shop-domain": row.domain,
      "x-shopify-topic": "app/uninstalled",
      "x-shopify-hmac-sha256": "invalid",
    };
    expect((await t.fetch("/webhooks/shopify", { method: "POST", body, headers })).status).toBe(
      401,
    );
    expect((await t.run((ctx) => ctx.db.get(row._id)))?.status).toBe("active");
    headers["x-shopify-hmac-sha256"] = signature;
    expect((await t.fetch("/webhooks/shopify", { method: "POST", body, headers })).status).toBe(
      200,
    );
    expect((await t.run((ctx) => ctx.db.get(row._id)))?.token).toBe("");
  });
});
describe("support order context", () => {
  test("requires email plus order reference for automatic association, supports multiple parcels and manual suppression", async () => {
    const t = backend(),
      w = await workspace(t, "matching"),
      { row } = await connect(t, w);
    const [stored] = await t.mutation(internal.orderContext.saveLookup, {
      connectionId: row._id,
      generation: row.generation,
      orders: [order()],
    });
    const receiptId = await email(t, w);
    const context = await w.client.query(api.orderContext.forEmail, { receiptId });
    expect(context?.mode).toBe("automatic");
    expect(context?.selected?._id).toBe(stored._id);
    expect(context?.shipments).toHaveLength(2);
    const wrongSender = await email(t, w, "Commande #1234", "someone@example.com");
    expect(
      (await w.client.query(api.orderContext.forEmail, { receiptId: wrongSender }))?.selected,
    ).toBeNull();
    const noNumber = await email(t, w, "Où est mon colis ?");
    expect(
      (await w.client.query(api.orderContext.forEmail, { receiptId: noNumber }))?.selected,
    ).toBeNull();
    await w.client.mutation(api.orderContext.link, { receiptId, orderId: null });
    expect((await w.client.query(api.orderContext.forEmail, { receiptId }))?.selected).toBeNull();
    await w.client.mutation(api.orderContext.link, { receiptId, orderId: null, reset: true });
    expect((await w.client.query(api.orderContext.forEmail, { receiptId }))?.mode).toBe(
      "automatic",
    );
  });
  test("cannot link orders from another shop; stale jobs cannot write after disconnect", async () => {
    const t = backend(),
      a = await workspace(t, "a"),
      b = await workspace(t, "b");
    const { row } = await connect(t, a),
      second = await connect(t, b, "second.myshopify.com", "b".repeat(32));
    const [otherOrder] = await t.mutation(internal.orderContext.saveLookup, {
      connectionId: second.row._id,
      generation: second.row.generation,
      orders: [order()],
    });
    const receiptId = await email(t, a);
    await expect(
      a.client.mutation(api.orderContext.link, { receiptId, orderId: otherOrder._id }),
    ).rejects.toThrow("OrderUnavailable");
    await expect(b.client.query(api.orderContext.forEmail, { receiptId })).rejects.toThrow(
      "Forbidden",
    );
    await a.client.mutation(api.shopifyConnection.disconnect, { shopId: a.shopId });
    expect(
      await t.mutation(internal.orderContext.saveLookup, {
        connectionId: row._id,
        generation: row.generation,
        orders: [order()],
      }),
    ).toEqual([]);
  });
  test("viewer can read cached context but cannot link, lookup or trigger synchronization", async () => {
    const t = backend(),
      w = await workspace(t, "viewer"),
      { row } = await connect(t, w);
    const [stored] = await t.mutation(internal.orderContext.saveLookup, {
      connectionId: row._id,
      generation: row.generation,
      orders: [order()],
    });
    const receiptId = await email(t, w);
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", w.organizationId))
        .first();
      if (m) await ctx.db.patch(m._id, { role: "viewer" });
    });
    expect((await w.client.query(api.orderContext.forEmail, { receiptId }))?.canEdit).toBe(false);
    await expect(
      w.client.mutation(api.orderContext.link, { receiptId, orderId: stored._id }),
    ).rejects.toThrow("Forbidden");
    await expect(w.client.action(api.orderContext.lookup, { receiptId })).rejects.toThrow(
      "Forbidden",
    );
    await expect(w.client.mutation(api.shopifySync.request, { shopId: w.shopId })).rejects.toThrow(
      "Forbidden",
    );
  });
});
describe("shipment updates", () => {
  test("authenticates webhooks, preserves fresher history and ignores disconnected shipments", async () => {
    vi.stubEnv("TRACK17_API_KEY", "test-tracking-secret");
    const t = backend(),
      w = await workspace(t, "tracking"),
      { row } = await connect(t, w);
    await t.mutation(internal.orderContext.saveLookup, {
      connectionId: row._id,
      generation: row.generation,
      orders: [order()],
    });
    const shipment = await t.run((ctx) => ctx.db.query("orderShipments").first());
    if (!shipment) throw new Error("Missing shipment");
    await t.mutation(internal.orderTracking.registered, {
      shipmentId: shipment._id,
      generation: row.generation,
      carrier: 3011,
    });
    const body = JSON.stringify({
      event: "TRACKING_UPDATED",
      data: {
        number: shipment.number,
        carrier: 3011,
        track_info: {
          latest_status: { status: "Delivered" },
          latest_event: {
            time_utc: "2026-10-20T12:00:00Z",
            description: "Delivered",
            location: "Paris",
          },
        },
      },
    });
    const rejected = await t.fetch("/webhooks/17track", {
      method: "POST",
      body,
      headers: { sign: "0".repeat(64) },
    });
    expect(rejected.status).toBe(401);
    const accepted = await t.fetch("/webhooks/17track", {
      method: "POST",
      body,
      headers: { sign: await sha256(`${body}/test-tracking-secret`) },
    });
    expect(accepted.status).toBe(200);
    await t.mutation(internal.orderTracking.apply, {
      cursor: null,
      update: {
        number: shipment.number,
        carrier: 3011,
        status: "InTransit",
        eventAt: 1,
        events: [],
      },
    });
    const updated = await t.run((ctx) => ctx.db.get(shipment._id));
    expect(updated?.status).toBe("Delivered");
    expect(updated?.events[0].location).toBe("Paris");
    await w.client.mutation(api.shopifyConnection.disconnect, { shopId: w.shopId });
    await t.mutation(internal.orderTracking.apply, {
      cursor: null,
      update: {
        number: shipment.number,
        carrier: 3011,
        status: "Exception",
        eventAt: Date.now() + 1000,
        events: [],
      },
    });
    expect((await t.run((ctx) => ctx.db.get(shipment._id)))?.status).toBe("Delivered");
  });
  test("renews an expired Shopify token and commits the successful synchronization checkpoint", async () => {
    const t = backend(),
      w = await workspace(t, "renewal"),
      { row } = await connect(t, w);
    await t.run((ctx) => ctx.db.patch(row._id, { tokenExpiresAt: 0 }));
    await t.mutation(internal.shopifySync.start, { connectionId: row._id });
    const running = await t.run((ctx) => ctx.db.get(row._id));
    const calls = vi.fn().mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/oauth/access_token")
              ? { access_token: "renewed-token", expires_in: 86400, scope: "read_orders" }
              : {
                  data: {
                    orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  },
                },
          ),
        ),
    );
    vi.stubGlobal("fetch", calls);
    await t.action(internal.shopifySync.page, {
      connectionId: row._id,
      generation: row.generation,
      lease: running?.syncLease ?? "",
      cursor: null,
      since: 0,
      startedAt: Date.now(),
    });
    const updated = await t.run((ctx) => ctx.db.get(row._id));
    expect(await decrypt(updated?.token ?? "", `shopify:${w.shopId}`)).toBe("renewed-token");
    expect(updated?.syncedAt).toBe(Date.now());
    expect(updated?.syncLease).toBeUndefined();
    expect(calls).toHaveBeenCalledTimes(2);
  });
  test("persists generic provider errors and schedules retry without leaking response data", async () => {
    const t = backend(),
      w = await workspace(t, "failure"),
      { row } = await connect(t, w);
    await t.mutation(internal.shopifySync.start, { connectionId: row._id });
    const running = await t.run((ctx) => ctx.db.get(row._id));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("secret provider error", { status: 500 })),
    );
    await t.action(internal.shopifySync.page, {
      connectionId: row._id,
      generation: row.generation,
      lease: running?.syncLease ?? "",
      cursor: null,
      since: 0,
      startedAt: Date.now(),
    });
    const failed = await t.run((ctx) => ctx.db.get(row._id));
    expect(failed?.error).toBe("ProviderUnavailable");
    expect(failed?.syncLease).toBeUndefined();
    expect(failed?.nextSyncAt).toBeGreaterThan(Date.now());
  });
});
