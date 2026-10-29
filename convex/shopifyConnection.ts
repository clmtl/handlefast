import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  env,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server";
import { assertCanManageOrganization, requireShopMembership } from "./lib/authorization";
import { connectionFields } from "./lib/commerceModel";

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

// Shared atomic completion used by the authenticated browser OAuth callback.
export async function storeConnection(
  ctx: MutationCtx,
  args: {
    shopId: Id<"shops">;
    organizationId: Id<"organizations">;
    domain: string;
    shopifyShopId: string;
    clientId: string;
    secret: string;
    token: string;
    tokenExpiresAt: number;
    scopes: string[];
  },
) {
  const claimed = await ctx.db
    .query("shopifyConnections")
    .withIndex("by_domain", (q) => q.eq("domain", args.domain))
    .unique();
  if (claimed && claimed.shopId !== args.shopId) throw new ConvexError("ShopAlreadyConnected");
  const sameApp = await ctx.db
    .query("shopifyConnections")
    .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
    .unique();
  if (sameApp && sameApp.shopId !== args.shopId) throw new ConvexError("UseOneAppPerShop");
  const previous = await ctx.db
    .query("shopifyConnections")
    .withIndex("by_shopId", (q) => q.eq("shopId", args.shopId))
    .unique();
  const values = {
    ...args,
    generation: crypto.randomUUID(),
    status: "active" as const,
    nextSyncAt: Date.now(),
    createdAt: Date.now(),
  };
  const connectionId = previous?._id ?? (await ctx.db.insert("shopifyConnections", values));
  if (previous) {
    await ctx.db.replace(previous._id, values);
    await ctx.scheduler.runAfter(0, internal.commerceMaintenance.purge, {
      connectionId,
      generation: previous.generation,
    });
  }
  await ctx.db.patch(args.shopId, { platform: "shopify", updatedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.shopifySync.start, { connectionId });
  return connectionId;
}

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
    const sessions = await ctx.db
      .query("shopifyGuidedSessions")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .take(50);
    for (const session of sessions)
      await ctx.db.patch(session._id, {
        status: "error",
        errorCode: "SHOPIFY_AUTH_CANCELLED",
        secret: undefined,
        oauthHash: undefined,
        authorizationUrl: undefined,
        expiresAt: Date.now(),
        lease: undefined,
        leaseUntil: undefined,
      });
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
