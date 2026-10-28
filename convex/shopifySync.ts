import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { internalAction, internalMutation, mutation } from "./_generated/server";
import { requireShopMembership } from "./lib/authorization";
import { orderData } from "./lib/commerceModel";
import {
  exchangeCredentials,
  ORDERS_QUERY,
  parseOrders,
  shopifyGraphql,
} from "./lib/commerceProviders";
import { decrypt, encrypt } from "./lib/commerceSecrets";

export async function accessToken(ctx: ActionCtx, row: Doc<"shopifyConnections">) {
  const context = `shopify:${row.shopId}`;
  if (row.tokenExpiresAt > Date.now() + 60_000) return decrypt(row.token, context);
  const secret = await decrypt(row.secret, context);
  const fresh = await exchangeCredentials(row.domain, row.clientId, secret);
  if (
    !fresh.scope
      .split(",")
      .map((scope) => scope.trim())
      .includes("read_orders")
  )
    throw new Error("ShopifyOrdersPermissionMissing");
  await ctx.runMutation(internal.shopifySync.saveToken, {
    connectionId: row._id,
    generation: row.generation,
    token: await encrypt(fresh.access_token, context),
    expiresAt: Date.now() + fresh.expires_in * 1000,
  });
  return fresh.access_token;
}
export const saveToken = internalMutation({
  args: {
    connectionId: v.id("shopifyConnections"),
    generation: v.string(),
    token: v.string(),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (row?.status === "active" && row.generation === args.generation)
      await ctx.db.patch(row._id, { token: args.token, tokenExpiresAt: args.expiresAt });
    return null;
  },
});
export const request = mutation({
  args: { shopId: v.id("shops") },
  returns: v.null(),
  handler: async (ctx, { shopId }) => {
    const { shop, membership } = await requireShopMembership(ctx, shopId);
    if (membership.role === "viewer") throw new ConvexError("Forbidden");
    if (shop.status === "disabled") throw new ConvexError("ShopDisabled");
    const row = await ctx.db
      .query("shopifyConnections")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .unique();
    if (row?.status !== "active") throw new ConvexError("ShopifyDisconnected");
    if (row.syncStartedAt && row.syncStartedAt > Date.now() - 60_000) return null;
    await ctx.scheduler.runAfter(0, internal.shopifySync.start, { connectionId: row._id });
    return null;
  },
});
export const start = internalMutation({
  args: { connectionId: v.id("shopifyConnections") },
  returns: v.null(),
  handler: async (ctx, { connectionId }) => {
    const row = await ctx.db.get(connectionId);
    const shop = row ? await ctx.db.get(row.shopId) : null;
    if (row?.status !== "active" || !shop || shop.status === "disabled") return null;
    if (row.syncLease && (row.syncStartedAt ?? 0) > Date.now() - 5 * 60_000) return null;
    const lease = `${Date.now()}:${Math.random()}`;
    const startedAt = Date.now();
    await ctx.db.patch(row._id, {
      syncLease: lease,
      syncStartedAt: startedAt,
      nextSyncAt: startedAt + 5 * 60_000,
      error: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.shopifySync.page, {
      connectionId,
      generation: row.generation,
      lease,
      cursor: null,
      since: row.syncedAt ? row.syncedAt - 5 * 60_000 : startedAt - 60 * 86_400_000,
      startedAt,
    });
    return null;
  },
});
export const page = internalAction({
  args: {
    connectionId: v.id("shopifyConnections"),
    generation: v.string(),
    lease: v.string(),
    cursor: v.union(v.string(), v.null()),
    since: v.number(),
    startedAt: v.number(),
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(internal.shopifyConnection.credentials, {
      connectionId: args.connectionId,
    });
    if (!row || row.generation !== args.generation || row.syncLease !== args.lease) return null;
    try {
      const token = await accessToken(ctx, row);
      const result = parseOrders(
        await shopifyGraphql(row.domain, token, ORDERS_QUERY, {
          query: `updated_at:>='${new Date(args.since).toISOString()}' updated_at:<='${new Date(args.startedAt).toISOString()}'`,
          after: args.cursor,
        }),
      );
      const { attempt: _, ...pageArgs } = args;
      await ctx.runMutation(internal.shopifySync.savePage, {
        ...pageArgs,
        orders: result.orders,
        nextCursor: result.hasNextPage ? result.endCursor : null,
      });
    } catch (error) {
      const reason = commerceError(error);
      if (reason === "ProviderRateLimited" && (args.attempt ?? 0) < 3) {
        await ctx.scheduler.runAfter(
          30_000 * ((args.attempt ?? 0) + 1),
          internal.shopifySync.page,
          { ...args, attempt: (args.attempt ?? 0) + 1 },
        );
        return null;
      }
      await ctx.runMutation(internal.shopifySync.failed, {
        connectionId: row._id,
        generation: row.generation,
        lease: args.lease,
        error: reason,
      });
    }
    return null;
  },
});
export function commerceError(error: unknown) {
  const safe = new Set([
    "ProviderRateLimited",
    "ProviderAccessDenied",
    "ProviderUnavailable",
    "ShopifyDataAccessDenied",
    "ShopifyOrdersPermissionMissing",
    "CommerceEncryptionNotConfigured",
    "InvalidCommerceEncryptionKey",
  ]);
  return error instanceof Error && safe.has(error.message)
    ? error.message
    : "SynchronizationFailed";
}
export const savePage = internalMutation({
  args: {
    connectionId: v.id("shopifyConnections"),
    generation: v.string(),
    lease: v.string(),
    cursor: v.union(v.string(), v.null()),
    since: v.number(),
    startedAt: v.number(),
    orders: v.array(orderData),
    nextCursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (
      row?.status !== "active" ||
      row.generation !== args.generation ||
      row.syncLease !== args.lease
    )
      return null;
    for (const order of args.orders)
      if (order.placedAt >= Date.now() - 365 * 86_400_000) await persistOrder(ctx, row, order);
    if (args.nextCursor) {
      if (args.nextCursor === args.cursor) throw new Error("InvalidShopifyCursor");
      await ctx.db.patch(row._id, {
        nextSyncAt: Date.now() + 5 * 60_000,
        syncStartedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(8000, internal.shopifySync.page, {
        connectionId: row._id,
        generation: row.generation,
        lease: args.lease,
        cursor: args.nextCursor,
        since: args.since,
        startedAt: args.startedAt,
      });
    } else
      await ctx.db.patch(row._id, {
        syncedAt: args.startedAt,
        nextSyncAt: Date.now() + 15 * 60_000,
        syncLease: undefined,
        error: undefined,
      });
    return null;
  },
});

import type { Infer } from "convex/values";
import type { MutationCtx } from "./_generated/server";
export async function persistOrder(
  ctx: MutationCtx,
  row: Doc<"shopifyConnections">,
  order: Infer<typeof orderData>,
): Promise<Id<"shopifyOrders">> {
  const existing = await ctx.db
    .query("shopifyOrders")
    .withIndex("by_shopId_and_gid", (q) => q.eq("shopId", row.shopId).eq("gid", order.gid))
    .unique();
  if (existing?.generation === row.generation && existing.sourceUpdatedAt > order.sourceUpdatedAt)
    return existing._id;
  const { tracking: rawTracking, ...data } = order;
  const tracking = [
    ...new Map(
      rawTracking.map((track) => [`${track.fulfillmentId}:${track.number}`, track]),
    ).values(),
  ].slice(0, 100);
  const values = {
    ...data,
    shopId: row.shopId,
    organizationId: row.organizationId,
    connectionId: row._id,
    generation: row.generation,
    syncedAt: Date.now(),
  };
  const orderId = existing?._id ?? (await ctx.db.insert("shopifyOrders", values));
  if (existing) await ctx.db.replace(existing._id, values);
  const shipments = await ctx.db
    .query("orderShipments")
    .withIndex("by_orderId", (q) => q.eq("orderId", orderId))
    .take(101);
  for (const shipment of shipments) {
    if (
      !tracking.some(
        (t) => t.number === shipment.number && t.fulfillmentId === shipment.fulfillmentId,
      )
    )
      await ctx.db.delete(shipment._id);
    else if (order.cancelled) await ctx.db.patch(shipment._id, { active: false });
  }
  for (const track of tracking) {
    const shipment = shipments.find(
      (s) => s.number === track.number && s.fulfillmentId === track.fulfillmentId,
    );
    if (shipment?.generation === row.generation) {
      await ctx.db.patch(shipment._id, { active: !order.cancelled, company: track.company });
      continue;
    }
    const value = {
      ...track,
      shopId: row.shopId,
      organizationId: row.organizationId,
      connectionId: row._id,
      generation: row.generation,
      orderId,
      registered: false,
      nextAttemptAt: Date.now(),
      status: "Unavailable",
      events: [],
      active: !order.cancelled,
    };
    if (shipment) await ctx.db.replace(shipment._id, value);
    else await ctx.db.insert("orderShipments", value);
  }
  return orderId;
}
export const failed = internalMutation({
  args: {
    connectionId: v.id("shopifyConnections"),
    generation: v.string(),
    lease: v.string(),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (row?.generation === args.generation && row.syncLease === args.lease)
      await ctx.db.patch(row._id, {
        error: args.error,
        syncLease: undefined,
        nextSyncAt: Date.now() + 15 * 60_000,
      });
    return null;
  },
});
export const recover = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const due = await ctx.db
      .query("shopifyConnections")
      .withIndex("by_status_and_nextSyncAt", (q) =>
        q.eq("status", "active").lte("nextSyncAt", Date.now()),
      )
      .take(20);
    for (const row of due)
      await ctx.scheduler.runAfter(0, internal.shopifySync.start, { connectionId: row._id });
    return null;
  },
});
