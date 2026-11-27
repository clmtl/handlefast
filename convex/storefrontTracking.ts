import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { normalizedEmail } from "./lib/commerceModel";

export const storefrontPilotDomain = "8vvazz-uj.myshopify.com";
const requestLimit = 60;
const windowMs = 60_000;

export const lookup = internalMutation({
  args: {
    search: v.union(
      v.object({ mode: v.literal("tracking"), number: v.string() }),
      v.object({ mode: v.literal("order"), number: v.string(), email: v.string() }),
    ),
  },
  handler: async (ctx, { search }) => {
    const connection = await ctx.db
      .query("shopifyConnections")
      .withIndex("by_domain", (q) => q.eq("domain", storefrontPilotDomain))
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
      return { kind: "parcels", parcels: [parcelView(shipment, false)] } as const;
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
    return { kind: "parcels", parcels: parcels.map((row) => parcelView(row, true)) } as const;
  },
});

function parcelView(shipment: Doc<"orderShipments">, includeDescriptions: boolean) {
  const events = shipment.events
    .flatMap(({ time, description }) =>
      time !== null && Math.abs(time) <= 8.64e15 ? [{ time, description }] : [],
    )
    .sort((a, b) => b.time - a.time);
  const first = events[events.length - 1];
  const last = events[0];
  return {
    number: shipment.number,
    status: shipment.status,
    events: includeDescriptions
      ? events
          .filter((event) => event.description.trim())
          .slice(0, 8)
          .map(({ time, description }) => ({ time, description: description.slice(0, 240) }))
      : [
          ...(last
            ? [{ time: last.time, description: "Dernière mise à jour du transporteur" }]
            : []),
          ...(first && first.time !== last.time
            ? [{ time: first.time, description: "Premier événement enregistré" }]
            : []),
        ],
  };
}
