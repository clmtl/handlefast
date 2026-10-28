import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { env, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import {
  assertCanManageOrganization,
  getMembership,
  requireShopMembership,
} from "./lib/authorization";
import { connectionFields, SHOPIFY_API_VERSION, shopDomain } from "./lib/commerceModel";
import { sha256 } from "./lib/commerceSecrets";

export const status = query({
  args: { shopId: v.id("shops") },
  returns: v.object({
    domain: v.union(v.string(), v.null()),
    connected: v.boolean(),
    canManage: v.boolean(),
    canRefresh: v.boolean(),
    syncedAt: v.union(v.number(), v.null()),
    syncing: v.boolean(),
    error: v.union(v.string(), v.null()),
    trackingConfigured: v.boolean(),
    encryptionConfigured: v.boolean(),
  }),
  handler: async (ctx, { shopId }) => {
    const { membership } = await requireShopMembership(ctx, shopId);
    const row = await ctx.db
      .query("shopifyConnections")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .unique();
    return {
      domain: row?.domain ?? null,
      connected: row?.status === "active",
      canManage: ["owner", "admin"].includes(membership.role),
      canRefresh: membership.role !== "viewer",
      syncedAt: row?.syncedAt ?? null,
      syncing: Boolean(row?.syncLease),
      error: row?.error ?? null,
      trackingConfigured: Boolean(env.TRACK17_API_KEY),
      encryptionConfigured: Boolean(env.COMMERCE_ENCRYPTION_KEY),
    };
  },
});

export const begin = mutation({
  args: { shopId: v.id("shops"), domain: v.string() },
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { shopId, domain: input }) => {
    const { shop, membership, profile } = await requireShopMembership(ctx, shopId);
    assertCanManageOrganization(membership);
    if (shop.status === "disabled") throw new ConvexError("ShopDisabled");
    if (!env.COMMERCE_ENCRYPTION_KEY) throw new ConvexError("CommerceEncryptionNotConfigured");
    const domain = shopDomain(input);
    const existing = await ctx.db
      .query("shopifyConnections")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .unique();
    if (existing && existing.shopId !== shopId) throw new ConvexError("ShopAlreadyConnected");
    const pending = await ctx.db
      .query("shopifyPairings")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .take(50);
    for (const pair of pending) await ctx.db.delete(pair._id);
    const code = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const expiresAt = Date.now() + 30 * 60_000;
    await ctx.db.insert("shopifyPairings", {
      shopId,
      organizationId: shop.organizationId,
      profileId: profile._id,
      domain,
      tokenHash: await sha256(code),
      expiresAt,
    });
    return { code, expiresAt };
  },
});

export const pairing = internalQuery({
  args: { tokenHash: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("shopifyPairings"),
      shopId: v.id("shops"),
      domain: v.string(),
      name: v.string(),
      organizationName: v.string(),
      expiresAt: v.number(),
      siteUrl: v.string(),
      apiVersion: v.string(),
    }),
  ),
  handler: async (ctx, { tokenHash }) => {
    const row = await ctx.db
      .query("shopifyPairings")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!row || row.consumedAt || row.expiresAt <= Date.now()) return null;
    const shop = await ctx.db.get(row.shopId);
    const membership = await getMembership(ctx, row.organizationId, row.profileId);
    if (
      !shop ||
      shop.status === "disabled" ||
      shop.organizationId !== row.organizationId ||
      !membership ||
      !["owner", "admin"].includes(membership.role)
    )
      return null;
    const organization = await ctx.db.get(row.organizationId);
    return {
      id: row._id,
      shopId: row.shopId,
      domain: row.domain,
      name: shop.name,
      organizationName: organization?.name ?? "",
      expiresAt: row.expiresAt,
      siteUrl: env.SITE_URL,
      apiVersion: SHOPIFY_API_VERSION,
    };
  },
});

export const finish = internalMutation({
  args: {
    tokenHash: v.string(),
    domain: v.string(),
    shopifyShopId: v.string(),
    clientId: v.string(),
    secret: v.string(),
    token: v.string(),
    tokenExpiresAt: v.number(),
    scopes: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const pair = await ctx.db
      .query("shopifyPairings")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!pair || pair.consumedAt || pair.expiresAt <= Date.now() || pair.domain !== args.domain)
      throw new ConvexError("PairingExpired");
    const membership = await getMembership(ctx, pair.organizationId, pair.profileId);
    const shop = await ctx.db.get(pair.shopId);
    if (
      !membership ||
      !shop ||
      shop.status === "disabled" ||
      shop.organizationId !== pair.organizationId
    )
      throw new ConvexError("Forbidden");
    assertCanManageOrganization(membership);
    const claimed = await ctx.db
      .query("shopifyConnections")
      .withIndex("by_domain", (q) => q.eq("domain", args.domain))
      .unique();
    if (claimed && claimed.shopId !== pair.shopId) throw new ConvexError("ShopAlreadyConnected");
    const sameApp = await ctx.db
      .query("shopifyConnections")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (sameApp && sameApp.shopId !== pair.shopId) throw new ConvexError("UseOneAppPerShop");
    const previous = await ctx.db
      .query("shopifyConnections")
      .withIndex("by_shopId", (q) => q.eq("shopId", pair.shopId))
      .unique();
    const { tokenHash: _, ...credentials } = args;
    const generation = crypto.randomUUID();
    const values = {
      ...credentials,
      shopId: pair.shopId,
      organizationId: pair.organizationId,
      generation,
      status: "active" as const,
      nextSyncAt: Date.now(),
      createdAt: Date.now(),
    };
    let connectionId: Id<"shopifyConnections">;
    if (previous) {
      connectionId = previous._id;
      await ctx.db.replace(previous._id, values);
      await ctx.scheduler.runAfter(0, internal.commerceMaintenance.purge, {
        connectionId,
        generation: previous.generation,
      });
    } else connectionId = await ctx.db.insert("shopifyConnections", values);
    await ctx.db.patch(pair._id, { consumedAt: Date.now() });
    await ctx.db.patch(pair.shopId, { platform: "shopify", updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.shopifySync.start, { connectionId });
    return null;
  },
});

export const disconnect = mutation({
  args: { shopId: v.id("shops") },
  returns: v.null(),
  handler: async (ctx, { shopId }) => {
    const { membership } = await requireShopMembership(ctx, shopId);
    assertCanManageOrganization(membership);
    const row = await ctx.db
      .query("shopifyConnections")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .unique();
    const pairs = await ctx.db
      .query("shopifyPairings")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .take(50);
    for (const pair of pairs) await ctx.db.delete(pair._id);
    if (row) {
      await ctx.db.patch(row._id, {
        status: "disconnected",
        secret: "",
        token: "",
        generation: crypto.randomUUID(),
        syncLease: undefined,
        error: undefined,
      });
      await ctx.scheduler.runAfter(0, internal.commerceMaintenance.purge, {
        connectionId: row._id,
        generation: row.generation,
      });
    }
    return null;
  },
});

export const credentials = internalQuery({
  args: { connectionId: v.id("shopifyConnections") },
  returns: v.union(
    v.null(),
    v.object({ _id: v.id("shopifyConnections"), _creationTime: v.number(), ...connectionFields }),
  ),
  handler: async (ctx, { connectionId }) => {
    const row = await ctx.db.get(connectionId);
    const shop = row ? await ctx.db.get(row.shopId) : null;
    return row?.status === "active" && shop?.status !== "disabled" ? row : null;
  },
});

export const byDomain = internalQuery({
  args: { domain: v.string() },
  returns: v.union(
    v.null(),
    v.object({ _id: v.id("shopifyConnections"), _creationTime: v.number(), ...connectionFields }),
  ),
  handler: async (ctx, { domain }) => {
    const row = await ctx.db
      .query("shopifyConnections")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .unique();
    return row?.status === "active" ? row : null;
  },
});

export const uninstalled = internalMutation({
  args: { connectionId: v.id("shopifyConnections"), generation: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (row?.generation !== args.generation) return null;
    await ctx.db.patch(row._id, {
      status: "disconnected",
      secret: "",
      token: "",
      syncLease: undefined,
      generation: crypto.randomUUID(),
    });
    await ctx.scheduler.runAfter(0, internal.commerceMaintenance.purge, args);
    return null;
  },
});
