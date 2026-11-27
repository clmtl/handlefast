import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { normalizedEmail } from "./lib/commerceModel";

const requestLimit = 60;
const windowMs = 60_000;

export const lookup = internalMutation({
  args: {
    domain: v.string(),
    search: v.union(
      v.object({ mode: v.literal("tracking"), number: v.string() }),
      v.object({ mode: v.literal("order"), number: v.string(), email: v.string() }),
    ),
  },
  handler: async (ctx, { domain, search }) => {
    const connection = await ctx.db
      .query("shopifyConnections")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .unique();
    if (connection?.status !== "active") return { kind: "missing" } as const;
    const shop = await ctx.db.get("shops", connection.shopId);
    if (!shop || shop.status === "disabled" || shop.organizationId !== connection.organizationId)
      return { kind: "missing" } as const;

    const budget = await ctx.db
      .query("storefrontTrackingLimits")
      .withIndex("by_shopId", (q) => q.eq("shopId", shop._id))
      .unique();
    const now = Date.now();
    if (!budget) {
      await ctx.db.insert("storefrontTrackingLimits", {
        shopId: shop._id,
        startedAt: now,
        count: 1,
      });
    } else if (now - budget.startedAt >= windowMs) {
      await ctx.db.patch("storefrontTrackingLimits", budget._id, { startedAt: now, count: 1 });
    } else {
      if (budget.count >= requestLimit) return { kind: "limited" } as const;
      await ctx.db.patch("storefrontTrackingLimits", budget._id, { count: budget.count + 1 });
    }

    const belongsToShop = (row: Doc<"orderShipments"> | Doc<"shopifyOrders">) =>
      row.shopId === shop._id &&
      row.organizationId === shop.organizationId &&
      row.connectionId === connection._id &&
      row.generation === connection.generation;
    const retained = (order: Doc<"shopifyOrders">) => order.placedAt >= now - 365 * 86_400_000;

    if (search.mode === "tracking") {
      const numbers = [
        ...new Set([search.number, search.number.toUpperCase(), search.number.toLowerCase()]),
      ];
      const rows = (
        await Promise.all(
          numbers.map((number) =>
            ctx.db
              .query("orderShipments")
              .withIndex("by_connectionId_and_number", (q) =>
                q.eq("connectionId", connection._id).eq("number", number),
              )
              .order("desc")
              .take(20),
          ),
        )
      )
        .flat()
        .filter((row) => row.active && belongsToShop(row));
      if (new Set(rows.map((row) => row.orderId)).size !== 1) return { kind: "missing" } as const;
      const [shipment] = rows.sort((a, b) => (b.syncedAt ?? 0) - (a.syncedAt ?? 0));
      const order = await ctx.db.get("shopifyOrders", shipment.orderId);
      if (!order || !belongsToShop(order) || !retained(order) || order.cancelled)
        return { kind: "missing" } as const;
      return {
        kind: "parcels",
        parcels: [parcelView(shipment)],
        destination: order.destination,
      } as const;
    }

    const reference = search.number.replace(/^#/, "");
    const names = [
      ...new Set(
        [reference, reference.toUpperCase(), reference.toLowerCase()].flatMap((name) => [
          name,
          `#${name}`,
        ]),
      ),
    ];
    const orders = (
      await Promise.all(
        names.map((name) =>
          ctx.db
            .query("shopifyOrders")
            .withIndex("by_shopId_and_generation_and_name", (q) =>
              q.eq("shopId", shop._id).eq("generation", connection.generation).eq("name", name),
            )
            .take(2),
        ),
      )
    )
      .flat()
      .filter(
        (order) =>
          belongsToShop(order) && retained(order) && normalizedEmail(order.email) === search.email,
      );
    if (orders.length !== 1) return { kind: "missing" } as const;
    const [order] = orders;
    if (order.cancelled) return { kind: "cancelled" } as const;
    const shipments = await ctx.db
      .query("orderShipments")
      .withIndex("by_orderId", (q) => q.eq("orderId", order._id))
      .take(100);
    const parcels = shipments.filter((row) => row.active && belongsToShop(row));
    if (parcels.length === 0)
      return { kind: order.fulfillmentStatus === "FULFILLED" ? "noTracking" : "pending" } as const;
    return {
      kind: "parcels",
      parcels: parcels.map((row) => parcelView(row, order.placedAt)),
      destination: order.destination,
    } as const;
  },
});

function parcelView(shipment: Doc<"orderShipments">, placedAt?: number) {
  const lastEventAt = Math.max(
    0,
    ...shipment.events.map(({ time }) => time ?? 0),
    ...Object.values(shipment.milestones ?? {}),
  );
  return {
    number: shipment.number,
    status: shipment.status,
    placedAt,
    milestones: shipment.milestones,
    lastEventAt,
  };
}

export const deliveryPoint = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const point = await ctx.db
      .query("storefrontDeliveryPoints")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    return point ? [point.longitude, point.latitude] : null;
  },
});

export const saveDeliveryPoint = internalMutation({
  args: { key: v.string(), longitude: v.number(), latitude: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("storefrontDeliveryPoints")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (!existing) await ctx.db.insert("storefrontDeliveryPoints", args);
  },
});
