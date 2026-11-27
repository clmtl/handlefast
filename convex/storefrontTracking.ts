import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

export const lookup = internalQuery({
  args: { number: v.string() },
  handler: async (ctx, { number }) => {
    const connection = await ctx.db
      .query("shopifyConnections")
      .withIndex("by_domain", (q) => q.eq("domain", "8vvazz-uj.myshopify.com"))
      .unique();
    if (connection?.status !== "active") return null;
    const shop = await ctx.db.get("shops", connection.shopId);
    if (!shop || shop.status === "disabled" || shop.organizationId !== connection.organizationId)
      return null;

    const shipments = await ctx.db
      .query("orderShipments")
      .withIndex("by_connectionId_and_number", (q) =>
        q.eq("connectionId", connection._id).eq("number", number),
      )
      .take(10);
    const shipment = shipments.find(
      (row) =>
        row.active &&
        row.shopId === shop._id &&
        row.organizationId === shop.organizationId &&
        row.generation === connection.generation,
    );
    if (!shipment) return null;
    return {
      status: shipment.status,
      events: shipment.events
        .filter((event) => event.time !== null && Math.abs(event.time) <= 8.64e15)
        .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
        .slice(0, 8)
        .map(({ description, time }) => ({ description: description.slice(0, 240), time })),
    };
  },
});
