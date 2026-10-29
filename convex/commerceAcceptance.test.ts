/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { decrypt, encrypt } from "./lib/commerceSecrets";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const runId = "00000000-0000-4000-8000-000000000001";
async function fixture() {
  const t = convexTest({ schema, modules });
  const data = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Acceptance",
      slug: "acceptance",
      createdAt: now,
      updatedAt: now,
    });
    const shopId = await ctx.db.insert("shops", {
      organizationId,
      name: "Acceptance",
      slug: "acceptance",
      platform: "shopify",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const routeId = await ctx.db.insert("inboundEmailRoutes", {
      organizationId,
      shopId,
      address: "test@handlefast.invalid",
      localPart: "test",
      domain: "handlefast.invalid",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const connectionId = await ctx.db.insert("shopifyConnections", {
      organizationId,
      shopId,
      domain: "merchant.myshopify.com",
      shopifyShopId: "gid://shopify/Shop/1",
      clientId: "a".repeat(32),
      secret: await encrypt("private-secret", `shopify:${shopId}`),
      token: await encrypt("working-token", `shopify:${shopId}`),
      tokenExpiresAt: now + 3600_000,
      scopes: ["read_orders"],
      generation: "generation",
      status: "active",
      nextSyncAt: now,
      createdAt: now,
    });
    const receipts = [];
    for (const isTest of [true, false]) {
      const key = isTest ? "test-fixture" : "real-receipt";
      const receiptId = await ctx.db.insert("emailReceipts", {
        organizationId,
        shopId,
        routeId,
        key,
        envelopeFrom: "customer@example.com",
        envelopeTo: "test@handlefast.invalid",
        sha256: "hash",
        rawSize: 100,
        status: "processed",
        receivedAt: now,
        expiresAt: now + 3600_000,
        attempts: 1,
        nextAttemptAt: now,
        updatedAt: now,
      });
      const deliveryId = await ctx.db.insert("inboundEmailDeliveries", {
        organizationId,
        shopId,
        routeId,
        deliveryKey: key,
        provider: "cloudflare_email_routing",
        envelopeFrom: "customer@example.com",
        envelopeTo: "test@handlefast.invalid",
        receivedAt: now,
        rawSize: 100,
        receiptId,
        status: "received",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("supportMessages", {
        organizationId,
        shopId,
        routeId,
        deliveryId,
        receiptId,
        expiresAt: now + 3600_000,
        direction: "inbound",
        from: { address: "customer@example.com" },
        to: [],
        cc: [],
        replyTo: [],
        subject: isTest ? "HF-QA Feature4 acceptance" : "Actual customer message",
        headers: isTest ? [{ name: "X-HandleFast-Acceptance", value: runId }] : [],
        references: [],
        receivedAt: now,
        rawSize: 100,
        attachmentCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      receipts.push(receiptId);
    }
    return { connectionId, shopId, receipts };
  });
  return { t, ...data };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("SITE_URL", "https://handlefast-staging.bk201li.workers.dev");
  vi.stubEnv("COMMERCE_ENCRYPTION_KEY", btoa("k".repeat(32)));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("acceptance helpers refuse production before contacting a provider or changing data", async () => {
  const { t, connectionId, receipts } = await fixture();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  vi.stubEnv("SITE_URL", "https://handlefast.example");
  await expect(
    t.action(internal.commerceAcceptance.renewShopifyAccess, { connectionId }),
  ).rejects.toThrow("StagingAcceptanceOnly");
  await expect(
    t.mutation(internal.commerceAcceptance.expireFixtures, { runId, receiptIds: receipts }),
  ).rejects.toThrow("StagingAcceptanceOnly");
  expect(fetcher).not.toHaveBeenCalled();
  expect((await t.run((ctx) => ctx.db.get(receipts[0])))?.expiresAt).toBeGreaterThan(Date.now());
});

test("exercises real renewal code, persists the new token and never calls 17TRACK", async () => {
  const { t, connectionId, shopId } = await fixture();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/admin/oauth/access_token")) {
      expect(new URLSearchParams(String(init?.body)).get("grant_type")).toBe("client_credentials");
      return Response.json({
        access_token: "renewed-token",
        expires_in: 86399,
        scope: "read_orders",
      });
    }
    expect(new URL(url).hostname).toBe("merchant.myshopify.com");
    expect(new Headers(init?.headers).get("X-Shopify-Access-Token")).toBe("renewed-token");
    return Response.json({
      data: { shop: { id: "gid://shopify/Shop/1", myshopifyDomain: "merchant.myshopify.com" } },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const result = await t.action(internal.commerceAcceptance.renewShopifyAccess, { connectionId });
  expect(result).toEqual({ renewed: true, shopMatches: true, expiresAt: Date.now() + 86399_000 });
  const saved = await t.run((ctx) => ctx.db.get(connectionId));
  expect(await decrypt(saved?.token ?? "", `shopify:${shopId}`)).toBe("renewed-token");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("a failed renewal leaves the working stored token and expiry intact", async () => {
  const { t, connectionId } = await fixture();
  const before = await t.run((ctx) => ctx.db.get(connectionId));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })),
  );
  await expect(
    t.action(internal.commerceAcceptance.renewShopifyAccess, { connectionId }),
  ).rejects.toThrow();
  const after = await t.run((ctx) => ctx.db.get(connectionId));
  expect(after?.token).toBe(before?.token);
  expect(after?.tokenExpiresAt).toBe(before?.tokenExpiresAt);
});

test("cleanup rejects mixed customer/test receipts atomically", async () => {
  const { t, receipts } = await fixture();
  await expect(
    t.mutation(internal.commerceAcceptance.expireFixtures, { runId, receiptIds: receipts }),
  ).rejects.toThrow("AcceptanceFixtureRequired");
  expect((await t.run((ctx) => ctx.db.get(receipts[0])))?.expiresAt).toBeGreaterThan(Date.now());
});

test("cleanup removes only marked fixtures using normal email retention", async () => {
  const { t, receipts } = await fixture();
  expect(
    await t.mutation(internal.commerceAcceptance.expireFixtures, {
      runId,
      receiptIds: [receipts[0]],
    }),
  ).toBe(1);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await t.run((ctx) => ctx.db.get(receipts[0]))).toBeNull();
  expect(await t.run((ctx) => ctx.db.get(receipts[1]))).not.toBeNull();
  expect(await t.run((ctx) => ctx.db.query("supportMessages").take(5))).toHaveLength(1);
});
