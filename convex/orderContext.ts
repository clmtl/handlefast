import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { requireShopMembership } from "./lib/authorization";
import {
  connectionFields,
  normalizedEmail,
  orderData,
  orderFields,
  orderName,
  orderReferences,
  shipmentFields,
} from "./lib/commerceModel";
import { ORDERS_QUERY, parseOrders, shopifyGraphql } from "./lib/commerceProviders";
import { accessToken, persistOrder } from "./shopifySync";

const orderDoc = v.object({
  _id: v.id("shopifyOrders"),
  _creationTime: v.number(),
  ...orderFields,
});
const shipmentDoc = v.object({
  _id: v.id("orderShipments"),
  _creationTime: v.number(),
  ...shipmentFields,
});
async function emailContext(ctx: QueryCtx | MutationCtx, receiptId: Doc<"emailReceipts">["_id"]) {
  const receipt = await ctx.db.get(receiptId);
  if (!receipt || receipt.expiresAt <= Date.now()) throw new ConvexError("EmailUnavailable");
  const auth = await requireShopMembership(ctx, receipt.shopId);
  const message = await ctx.db
    .query("supportMessages")
    .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
    .unique();
  if (!message?.conversationId) throw new ConvexError("SupportEmailRequired");
  return { ...auth, receipt, message };
}
export const forEmail = query({
  args: { receiptId: v.id("emailReceipts") },
  returns: v.union(
    v.null(),
    v.object({
      domain: v.string(),
      canEdit: v.boolean(),
      selected: v.union(orderDoc, v.null()),
      candidates: v.array(orderDoc),
      limited: v.boolean(),
      mode: v.union(v.literal("manual"), v.literal("automatic"), v.literal("none")),
      identityMatches: v.boolean(),
      shipments: v.array(shipmentDoc),
    }),
  ),
  handler: async (ctx, { receiptId }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt || receipt.expiresAt <= Date.now()) return null;
    const { membership } = await requireShopMembership(ctx, receipt.shopId);
    const message = await ctx.db
      .query("supportMessages")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
      .unique();
    if (!message?.conversationId) return null;
    const cached = await cachedOrderContext(ctx, receipt, message);
    return cached ? { ...cached, canEdit: membership.role !== "viewer" } : null;
  },
});
export const link = mutation({
  args: {
    receiptId: v.id("emailReceipts"),
    orderId: v.union(v.id("shopifyOrders"), v.null()),
    reset: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { receipt, profile, membership } = await emailContext(ctx, args.receiptId);
    if (membership.role === "viewer") throw new ConvexError("Forbidden");
    if (args.orderId) {
      const order = await ctx.db.get(args.orderId);
      const connection = order ? await ctx.db.get(order.connectionId) : null;
      if (
        !order ||
        order.shopId !== receipt.shopId ||
        connection?.status !== "active" ||
        connection.generation !== order.generation
      )
        throw new ConvexError("OrderUnavailable");
    }
    const current = await ctx.db
      .query("orderLinks")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", args.receiptId))
      .unique();
    if (args.reset) {
      if (current) await ctx.db.delete(current._id);
      return null;
    }
    const value = {
      receiptId: receipt._id,
      shopId: receipt.shopId,
      orderId: args.orderId,
      profileId: profile._id,
      updatedAt: Date.now(),
    };
    if (current) await ctx.db.replace(current._id, value);
    else await ctx.db.insert("orderLinks", value);
    return null;
  },
});
export const authorizeLookup = internalMutation({
  args: { receiptId: v.id("emailReceipts") },
  returns: v.object({
    connection: v.object({
      _id: v.id("shopifyConnections"),
      _creationTime: v.number(),
      ...connectionFields,
    }),
    email: v.string(),
  }),
  handler: async (ctx, args) => {
    const { shop, membership, message } = await emailContext(ctx, args.receiptId);
    if (membership.role === "viewer") throw new ConvexError("Forbidden");
    if (shop.status === "disabled") throw new ConvexError("ShopDisabled");
    const row = await ctx.db
      .query("shopifyConnections")
      .withIndex("by_shopId", (q) => q.eq("shopId", shop._id))
      .unique();
    if (row?.status !== "active") throw new ConvexError("ShopifyDisconnected");
    if ((row.lookupAt ?? 0) > Date.now() - 3000)
      throw new ConvexError("PleaseWaitBeforeRefreshing");
    await ctx.db.patch(row._id, { lookupAt: Date.now() });
    return { connection: row, email: normalizedEmail(message.from.address) ?? "" };
  },
});
export const lookup = action({
  args: { receiptId: v.id("emailReceipts"), name: v.optional(v.string()) },
  returns: v.object({ orders: v.array(orderDoc), hasMore: v.boolean() }),
  handler: async (ctx, args): Promise<{ orders: Doc<"shopifyOrders">[]; hasMore: boolean }> => {
    const name = args.name?.trim().replace(/^#/, "");
    if (name && !/^[a-z0-9-]{1,40}$/i.test(name)) throw new ConvexError("InvalidOrderNumber");
    const { connection, email } = await ctx.runMutation(internal.orderContext.authorizeLookup, {
      receiptId: args.receiptId,
    });
    if (!name && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new ConvexError("InvalidCustomerEmail");
    try {
      const token = await accessToken(ctx, connection);
      const result = parseOrders(
        await shopifyGraphql(connection.domain, token, ORDERS_QUERY, {
          query: name ? `name:${JSON.stringify(name)}` : `email:${JSON.stringify(email)}`,
          after: null,
        }),
      );
      // Shopify search can be broad; filter the returned records before presenting them.
      const orders = result.orders.filter((o) =>
        name ? orderName(o.name) === orderName(name) : o.email === email,
      );
      return {
        orders: await ctx.runMutation(internal.orderContext.saveLookup, {
          receiptId: args.receiptId,
          connectionId: connection._id,
          generation: connection.generation,
          orders,
        }),
        hasMore: result.hasNextPage,
      };
    } catch {
      throw new ConvexError("OrderLookupUnavailable");
    }
  },
});
export const saveLookup = internalMutation({
  args: {
    receiptId: v.optional(v.id("emailReceipts")),
    connectionId: v.id("shopifyConnections"),
    generation: v.string(),
    orders: v.array(orderData),
  },
  returns: v.array(orderDoc),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (row?.status !== "active" || row.generation !== args.generation) return [];
    if (args.receiptId) {
      const auth = await emailContext(ctx, args.receiptId);
      if (auth.receipt.shopId !== row.shopId || auth.membership.role === "viewer")
        throw new ConvexError("Forbidden");
    }
    const result: Doc<"shopifyOrders">[] = [];
    for (const order of args.orders) {
      if (order.placedAt < Date.now() - 365 * 86_400_000) continue;
      const id = await persistOrder(ctx, row, order);
      const shipments = await ctx.db
        .query("orderShipments")
        .withIndex("by_orderId", (q) => q.eq("orderId", id))
        .take(100);
      for (const shipment of shipments)
        if (shipment.active) await ctx.db.patch(shipment._id, { nextAttemptAt: Date.now() });
      const saved = await ctx.db.get(id);
      if (saved) result.push(saved);
    }
    return result;
  },
});

// Cache-only selection shared with the human-review assistant. Never calls a provider.
export async function cachedOrderContext(
  ctx: QueryCtx | MutationCtx,
  receipt: Doc<"emailReceipts">,
  message: Doc<"supportMessages">,
) {
  const connection = await ctx.db
    .query("shopifyConnections")
    .withIndex("by_shopId", (q) => q.eq("shopId", receipt.shopId))
    .unique();
  if (connection?.status !== "active") return null;
  const email = normalizedEmail(message.from.address);
  const orders = await ctx.db
    .query("shopifyOrders")
    .withIndex("by_shopId_and_generation_and_email", (q) =>
      q.eq("shopId", receipt.shopId).eq("generation", connection.generation).eq("email", email),
    )
    .order("desc")
    .take(26);
  const link = await ctx.db
    .query("orderLinks")
    .withIndex("by_receiptId", (q) => q.eq("receiptId", receipt._id))
    .unique();
  let selected = link?.orderId ? await ctx.db.get(link.orderId) : null;
  if (
    selected &&
    (selected.shopId !== receipt.shopId ||
      selected.generation !== connection.generation ||
      selected.placedAt <= Date.now() - 365 * 86_400_000)
  )
    selected = null;
  let automatic = false;
  if (!link) {
    const references = orderReferences(
      `${message.subject ?? ""}\n${message.text ?? message.snippet ?? ""}`,
    );
    const matching = orders.filter(
      (o) => references.includes(orderName(o.name)) && o.placedAt > Date.now() - 365 * 86_400_000,
    );
    // Require both the sender email and an explicit, unambiguous order reference.
    if (references.length === 1 && matching.length === 1 && email) {
      selected = matching[0];
      automatic = true;
    }
  }
  const shipments = selected
    ? await ctx.db
        .query("orderShipments")
        .withIndex("by_orderId", (q) => q.eq("orderId", selected._id))
        .take(100)
    : [];
  return {
    domain: connection.domain,
    selected,
    candidates: orders.slice(0, 25),
    limited: orders.length > 25,
    mode: automatic ? ("automatic" as const) : link ? ("manual" as const) : ("none" as const),
    identityMatches: Boolean(selected?.email && selected.email === email),
    shipments: shipments
      .filter((s) => s.generation === connection.generation)
      .map((s) => ({ ...s, events: s.events.slice(0, 10) })),
  };
}
