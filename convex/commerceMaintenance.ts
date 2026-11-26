import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

export const purge = internalMutation({
  args: {
    connectionId: v.id("shopifyConnections"),
    generation: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("shopifyOrders")
      .withIndex("by_connectionId", (q) => q.eq("connectionId", args.connectionId))
      .paginate({ numItems: 20, cursor: args.cursor ?? null });
    for (const order of page.page) {
      if (order.generation !== args.generation) continue;
      const shipments = await ctx.db
        .query("orderShipments")
        .withIndex("by_orderId", (q) => q.eq("orderId", order._id))
        .take(200);
      for (const shipment of shipments) await ctx.db.delete(shipment._id);
      const links = await ctx.db
        .query("orderLinks")
        .withIndex("by_orderId", (q) => q.eq("orderId", order._id))
        .take(100);
      for (const link of links) await ctx.db.delete(link._id);
      // Repeat until all references are gone before deleting the order.
      if (links.length === 100 || shipments.length === 200) {
        await ctx.scheduler.runAfter(0, internal.commerceMaintenance.purge, args);
        return null;
      }
      await ctx.db.delete(order._id);
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.commerceMaintenance.purge, {
        ...args,
        cursor: page.continueCursor,
      });
    return null;
  },
});
export const expire = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const pairs = await ctx.db
      .query("shopifyPairings")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now()))
      .take(100);
    for (const pair of pairs) await ctx.db.delete(pair._id);
    const cutoff = Date.now() - 365 * 86_400_000;
    const orders = await ctx.db
      .query("shopifyOrders")
      .withIndex("by_placedAt", (q) => q.lt("placedAt", cutoff))
      .take(20);
    for (const order of orders) {
      const shipments = await ctx.db
        .query("orderShipments")
        .withIndex("by_orderId", (q) => q.eq("orderId", order._id))
        .take(200);
      for (const shipment of shipments) await ctx.db.delete(shipment._id);
      const links = await ctx.db
        .query("orderLinks")
        .withIndex("by_orderId", (q) => q.eq("orderId", order._id))
        .take(100);
      for (const link of links) await ctx.db.delete(link._id);
      if (links.length < 100 && shipments.length < 200) await ctx.db.delete(order._id);
    }
    return null;
  },
});
