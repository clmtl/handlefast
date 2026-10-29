/// <reference types="vite/client" />
import betterAuthTest from "@convex-dev/better-auth/test";
import type { UserIdentity } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import { shopDomain } from "./lib/commerceModel";
import { decrypt } from "./lib/commerceSecrets";
import { appSource } from "./lib/shopifyGuidedClient";
import { configureSupportWebhooks, SUPPORT_TOPICS } from "./lib/shopifyWebhooks";
import schema from "./schema";

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

function provider(
  options: { ambiguousCreate?: boolean; pending?: "authorization_pending" | "slow_down" } = {},
) {
  const state = {
    created: 0,
    appName: "",
    organizationId: "",
    scope: "",
    fail: options.ambiguousCreate ?? false,
  };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const app = () => ({
    id: "gid://shopify/App/123",
    key: "a".repeat(32),
    organizationId: "27",
    activeRoot: { clientCredentials: { secrets: [{ key: "private-app-secret" }] } },
  });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/oauth/device_authorization"))
      return json({
        device_code: "private-device-code",
        user_code: "ABCD-EFGH",
        verification_uri_complete: "https://accounts.shopify.com/activate?code=ABCD-EFGH",
        expires_in: 1200,
        interval: 5,
      });
    if (url === "https://accounts.shopify.com/oauth/token") {
      const fields = new URLSearchParams(String(init?.body));
      if (fields.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code")
        return options.pending
          ? json({ error: options.pending }, 400)
          : json({ access_token: "private-identity-token" });
      return json({
        access_token: fields.get("scope")?.includes("destinations")
          ? "private-business-token"
          : "private-management-token",
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.includes("destinations.shopifysvc.com")) {
      if (body.query.includes("StoreInfoDestinations"))
        return json({
          data: {
            currentUserAccount: {
              destinations: {
                nodes: [
                  {
                    publicId: "merchant-store",
                    primaryDomain: "merchant.myshopify.com",
                    webUrl: "https://admin.shopify.com/store/merchant",
                  },
                ],
              },
            },
          },
        });
      if (body.query.includes("StoreInfoOwningOrg"))
        return json({
          data: {
            currentUserAccount: {
              organizationForDestination: {
                id: "gid://shopify/Organization/27",
                name: "Merchant organization",
              },
            },
          },
        });
      return json({
        data: {
          currentUserAccount: {
            organizationsWithAccessToDestination: {
              nodes: [
                { id: "999", name: "Unrelated" },
                { id: "27", name: "Merchant organization" },
              ],
            },
          },
        },
      });
    }
    if (url.includes("app_management")) {
      if (body.query.includes("mutation CreateApp")) {
        state.created++;
        state.appName = body.variables.initialVersion.source.name;
        state.organizationId = body.variables.organizationId;
        state.scope = body.variables.initialVersion.source.modules.find(
          (m: { type: string }) => m.type === "app_access",
        ).config.scopes;
        if (state.appName.length > 30)
          return json({
            data: {
              appCreate: {
                app: null,
                userErrors: [{ message: "Name must be less than 30 characters" }],
              },
            },
          });
        if (state.fail) {
          state.fail = false;
          throw new Error("lost response with private-secret");
        }
        return json({ data: { appCreate: { app: app(), userErrors: [] } } });
      }
      if (body.query.includes("query RecoverCreatedApp"))
        return json({
          data: {
            appsConnection: {
              edges: [
                {
                  node: {
                    key: "a".repeat(32),
                    organizationId: "27",
                    activeRelease: { version: { name: state.appName } },
                  },
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        });
      return json({ data: { app: app() } });
    }
    if (url.endsWith("/admin/oauth/access_token"))
      return json({ access_token: "private-order-token", scope: "read_orders" });
    if (body.query?.includes("SupportShop"))
      return json({
        data: { shop: { id: "gid://shopify/Shop/100", myshopifyDomain: "merchant.myshopify.com" } },
      });
    if (body.query?.includes("SupportOrders"))
      return json({
        data: { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    throw new Error(`Unexpected provider request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return { state, fetcher };
}
async function authorize(w: Awaited<ReturnType<typeof workspace>>) {
  const sessionId = await w.client.action(api.shopifyGuidedActions.start, {
    shopId: w.shopId,
    domain: "https://admin.shopify.com/store/merchant",
  });
  vi.advanceTimersByTime(5001);
  await w.client.action(api.shopifyGuidedActions.poll, { sessionId });
  return sessionId;
}
async function callbackQuery(state: string) {
  const params = new URLSearchParams({
    shop: "merchant.myshopify.com",
    state,
    code: "single-use-authorization-code",
    timestamp: String(Math.floor(Date.now() / 1000)),
    host: "merchant-host",
  });
  const text = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("private-app-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)),
  );
  params.set("hmac", Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
  return params.toString();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("COMMERCE_ENCRYPTION_KEY", btoa("k".repeat(32)));
  vi.stubEnv("SITE_URL", "https://handlefast-staging.example");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("browser-only Shopify installation", () => {
  test("validates Shopify's 30-character app name limit before making a provider request", () => {
    expect(appSource("https://handlefast.example", "2026-10", "a".repeat(30)).name).toHaveLength(
      30,
    );
    expect(() => appSource("https://handlefast.example", "2026-10", "a".repeat(31))).toThrow(
      "SHOPIFY_INVALID_APP_NAME",
    );
  });
  test("replaces a definitively rejected legacy 31-character name when retrying the same operation", async () => {
    const t = backend(),
      w = await workspace(t, "name-retry"),
      p = provider(),
      sessionId = await authorize(w);
    const oldName = `HandleFast ${"a".repeat(20)}`;
    const operationId = await t.run((ctx) =>
      ctx.db.insert("shopifyGuidedOperations", {
        shopId: w.shopId,
        domain: "merchant.myshopify.com",
        shopifyOrganizationId: "27",
        appName: oldName,
        creationAttempted: false,
        sessionId,
        lease: "rejected-attempt",
        leaseUntil: 0,
      }),
    );
    await w.client.action(api.shopifyGuidedActions.provision, { sessionId });
    expect((await w.client.query(api.shopifyGuided.get, { sessionId }))?.status).toBe("ready");
    expect(p.state.appName.length).toBeLessThanOrEqual(30);
    expect(p.state.appName).not.toBe(oldName);
    expect(p.state.created).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(operationId)))?.appName).toBe(p.state.appName);
  });
  test("authorizes in Shopify, resolves the owning organization and installs into the original HandleFast tenant", async () => {
    const t = backend(),
      w = await workspace(t, "browser"),
      p = provider(),
      sessionId = await authorize(w);
    const authorized = await w.client.query(api.shopifyGuided.get, { sessionId });
    expect(authorized?.status).toBe("authorized");
    expect(authorized).not.toHaveProperty("secret");
    await w.client.action(api.shopifyGuidedActions.provision, { sessionId });
    const ready = await w.client.query(api.shopifyGuided.get, { sessionId });
    expect(ready?.status).toBe("ready");
    expect(p.state.organizationId).toBe("gid://shopify/Organization/27");
    expect(p.state.scope).toBe("read_orders");
    expect(await t.run((ctx) => ctx.db.query("shopifyConnections").first())).toBeNull();
    const url = new URL(ready?.authorizationUrl ?? "");
    expect(url.hostname).toBe("merchant.myshopify.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://handlefast-staging.example/auth/shopify/callback",
    );
    const query = await callbackQuery(url.searchParams.get("state") ?? "");
    expect(await w.client.action(api.shopifyGuidedActions.callback, { query })).toBe(w.shopId);
    const connection = await t.run((ctx) => ctx.db.query("shopifyConnections").first());
    expect(connection?.organizationId).toBe(w.organizationId);
    expect(connection?.domain).toBe("merchant.myshopify.com");
    expect(await decrypt(connection?.token ?? "", `shopify:${w.shopId}`)).toBe(
      "private-order-token",
    );
    const consumed = await t.run((ctx) => ctx.db.get(sessionId));
    expect(consumed?.secret).toBeUndefined();
    expect(consumed?.oauthHash).toBeUndefined();
    await expect(w.client.action(api.shopifyGuidedActions.callback, { query })).rejects.toThrow(
      "ShopifySessionExpired",
    );
  });
  test("does not disclose device or management credentials to the browser", async () => {
    const t = backend(),
      w = await workspace(t, "redaction");
    provider();
    const sessionId = await w.client.action(api.shopifyGuidedActions.start, {
      shopId: w.shopId,
      domain: "merchant",
    });
    const view = await w.client.query(api.shopifyGuided.get, { sessionId });
    expect(view?.userCode).toBe("ABCD-EFGH");
    expect(JSON.stringify(view)).not.toContain("private-device-code");
    const row = await t.run((ctx) => ctx.db.get(sessionId));
    expect(row?.secret).not.toContain("private-device-code");
    await w.client.mutation(api.shopifyGuided.cancel, { sessionId });
    expect((await t.run((ctx) => ctx.db.get(sessionId)))?.secret).toBeUndefined();
  });
  test("rejects a tampered callback before exchanging any code", async () => {
    const t = backend(),
      w = await workspace(t, "forged"),
      p = provider(),
      sessionId = await authorize(w);
    await w.client.action(api.shopifyGuidedActions.provision, { sessionId });
    const s = await w.client.query(api.shopifyGuided.get, { sessionId });
    const state = new URL(s?.authorizationUrl ?? "").searchParams.get("state") ?? "";
    const good = await callbackQuery(state),
      before = p.fetcher.mock.calls.length;
    await expect(
      w.client.action(api.shopifyGuidedActions.callback, {
        query: good.replace("merchant-host", "forged-host"),
      }),
    ).rejects.toThrow("ShopifyInvalidCallback");
    await expect(
      w.client.action(api.shopifyGuidedActions.callback, { query: `${good}&state=${state}` }),
    ).rejects.toThrow("ShopifyInvalidCallback");
    expect(p.fetcher.mock.calls.length).toBe(before);
    expect(await t.run((ctx) => ctx.db.query("shopifyConnections").first())).toBeNull();
  });
  test("rejects another organization and rechecks management permissions before completing", async () => {
    const t = backend(),
      w = await workspace(t, "own"),
      other = await workspace(t, "other");
    provider();
    const sessionId = await authorize(w);
    await expect(
      other.client.action(api.shopifyGuidedActions.provision, { sessionId }),
    ).rejects.toThrow("Forbidden");
    await w.client.action(api.shopifyGuidedActions.provision, { sessionId });
    const s = await w.client.query(api.shopifyGuided.get, { sessionId }),
      query = await callbackQuery(
        new URL(s?.authorizationUrl ?? "").searchParams.get("state") ?? "",
      );
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", w.organizationId))
        .first();
      if (m) await ctx.db.patch(m._id, { role: "viewer" });
    });
    await expect(w.client.action(api.shopifyGuidedActions.callback, { query })).rejects.toThrow(
      "Forbidden",
    );
    expect(await t.run((ctx) => ctx.db.query("shopifyConnections").first())).toBeNull();
  });
  test("resumes an ambiguous app creation without issuing another appCreate", async () => {
    const t = backend(),
      w = await workspace(t, "recovery"),
      p = provider({ ambiguousCreate: true }),
      first = await authorize(w);
    await w.client.action(api.shopifyGuidedActions.provision, { sessionId: first });
    expect((await w.client.query(api.shopifyGuided.get, { sessionId: first }))?.status).toBe(
      "error",
    );
    const second = await authorize(w);
    await w.client.action(api.shopifyGuidedActions.provision, { sessionId: second });
    expect((await w.client.query(api.shopifyGuided.get, { sessionId: second }))?.status).toBe(
      "ready",
    );
    expect(p.state.created).toBe(1);
  });
  test("two tabs share a device authorization and a single app creation", async () => {
    const t = backend(),
      w = await workspace(t, "tabs"),
      p = provider();
    const [first, second] = await Promise.all([
      w.client.action(api.shopifyGuidedActions.start, { shopId: w.shopId, domain: "merchant" }),
      w.client.action(api.shopifyGuidedActions.start, { shopId: w.shopId, domain: "merchant" }),
    ]);
    expect(first).toBe(second);
    expect(
      p.fetcher.mock.calls.filter(([url]) => url.endsWith("/device_authorization")),
    ).toHaveLength(1);
    vi.advanceTimersByTime(5001);
    await w.client.action(api.shopifyGuidedActions.poll, { sessionId: first });
    await Promise.all([
      w.client.action(api.shopifyGuidedActions.provision, { sessionId: first }),
      w.client.action(api.shopifyGuidedActions.provision, { sessionId: second }),
    ]);
    expect(p.state.created).toBe(1);
  });
  test("honors Shopify's polling interval and slow_down", async () => {
    const t = backend(),
      w = await workspace(t, "poll"),
      p = provider({ pending: "slow_down" }),
      id = await w.client.action(api.shopifyGuidedActions.start, {
        shopId: w.shopId,
        domain: "merchant",
      });
    const before = p.fetcher.mock.calls.length;
    await w.client.action(api.shopifyGuidedActions.poll, { sessionId: id });
    expect(p.fetcher.mock.calls.length).toBe(before);
    vi.advanceTimersByTime(5001);
    await w.client.action(api.shopifyGuidedActions.poll, { sessionId: id });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.intervalMs).toBe(10000);
    expect(row?.nextPollAt).toBe(Date.now() + 10000);
  });
  test("expires temporary credentials and removes the old connector API", async () => {
    const t = backend(),
      w = await workspace(t, "expiry");
    provider();
    const id = await w.client.action(api.shopifyGuidedActions.start, {
      shopId: w.shopId,
      domain: "merchant",
    });
    await t.run((ctx) => ctx.db.patch(id, { expiresAt: Date.now() - 1 }));
    await t.mutation(internal.shopifyGuided.expireDue, {});
    expect(await w.client.query(api.shopifyGuided.get, { sessionId: id })).toBeNull();
    expect((await t.fetch("/integrations/shopify/bootstrap", { method: "POST" })).status).toBe(404);
  });
  test.each([
    "https://admin.shopify.com/store/merchant",
    "https://merchant.myshopify.com/",
    "merchant.myshopify.com",
    "merchant",
  ])("accepts a merchant link: %s", (input) => {
    expect(shopDomain(input)).toBe("merchant.myshopify.com");
  });
  test.each([
    "https://evil.com",
    "https://admin.shopify.com/store/merchant?redirect=evil",
    "merchant.myshopify.com@evil.com",
    "https://merchant.myshopify.com.evil.com",
    "http://localhost",
  ])("rejects an untrusted store URL: %s", (input) => {
    expect(() => shopDomain(input)).toThrow("InvalidShopDomain");
  });
  test("registers only missing Shopify webhooks after installation", async () => {
    const uri = "https://example.convex.site/webhooks/shopify",
      registered: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const b = JSON.parse(String(init.body));
        if (b.query.includes("query SupportWebhooks"))
          return new Response(
            JSON.stringify({
              data: {
                webhookSubscriptions: {
                  nodes: [{ id: "existing", topic: SUPPORT_TOPICS[0], uri }],
                  pageInfo: { hasNextPage: false },
                },
              },
            }),
          );
        registered.push(b.variables.topic);
        return new Response(
          JSON.stringify({
            data: {
              webhookSubscriptionCreate: { webhookSubscription: { id: "new" }, userErrors: [] },
            },
          }),
        );
      }),
    );
    await configureSupportWebhooks("merchant.myshopify.com", "private-token", uri);
    expect(registered).toEqual(SUPPORT_TOPICS.slice(1));
  });
});
