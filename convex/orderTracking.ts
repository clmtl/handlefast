import { v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import { env, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { shipmentFields, trackingUpdate } from "./lib/commerceModel";
import { normalizeTracking, track17 } from "./lib/commerceProviders";

export const claim = internalMutation({
  args: {},
  returns: v.array(
    v.object({ _id: v.id("orderShipments"), _creationTime: v.number(), ...shipmentFields }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("orderShipments")
      .withIndex("by_active_and_nextAttemptAt", (q) =>
        q.eq("active", true).lte("nextAttemptAt", Date.now()),
      )
      .take(20);
    for (const row of rows)
      await ctx.db.patch(row._id, { nextAttemptAt: Date.now() + 10 * 60_000 });
    return rows;
  },
});
export const poll = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (!env.TRACK17_API_KEY) return null;
    const rows = await ctx.runMutation(internal.orderTracking.claim, {});
    // One item per scheduled invocation keeps registration + read below 3 requests/second.
    for (const [index, row] of rows.entries())
      await ctx.scheduler.runAfter(index * 1000, internal.orderTracking.refresh, {
        shipmentId: row._id,
        generation: row.generation,
      });
    return null;
  },
});
export const shipment = internalQuery({
  args: { shipmentId: v.id("orderShipments"), generation: v.string() },
  returns: v.union(
    v.null(),
    v.object({ _id: v.id("orderShipments"), _creationTime: v.number(), ...shipmentFields }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.shipmentId);
    const connection = row ? await ctx.db.get(row.connectionId) : null;
    const shop = row ? await ctx.db.get(row.shopId) : null;
    return row?.active &&
      row.generation === args.generation &&
      connection?.status === "active" &&
      connection.generation === args.generation &&
      shop?.status !== "disabled"
      ? row
      : null;
  },
});
export const refresh = internalAction({
  args: { shipmentId: v.id("orderShipments"), generation: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const key = env.TRACK17_API_KEY;
    const row = await ctx.runQuery(internal.orderTracking.shipment, args);
    if (!key || !row) return null;
    try {
      let carrier = row.carrier;
      if (!row.registered) {
        const result = await track17(key, "register", [
          { number: row.number, tag: String(row._id) },
        ]);
        if (result.code !== 0 || !result.data) throw new Error("TrackingRegistrationFailed");
        const accepted = result.data.accepted
          .map((item) => z.object({ number: z.string(), carrier: z.number() }).parse(item))
          .find((item) => item.number === row.number);
        if (!accepted && !result.data.rejected.some((r) => r.error.code === -18019901))
          throw new Error("TrackingRegistrationFailed");
        carrier = accepted?.carrier ?? carrier;
        await ctx.runMutation(internal.orderTracking.registered, { ...args, carrier });
      }
      const details = await track17(key, "gettrackinfo", [
        { number: row.number, ...(carrier ? { carrier } : {}) },
      ]);
      if (details.code !== 0 || !details.data?.accepted.length)
        throw new Error("TrackingInformationUnavailable");
      for (const item of details.data.accepted) {
        const update = normalizeTracking(item);
        if (update.number !== row.number || (carrier && carrier !== update.carrier)) continue;
        await ctx.runMutation(internal.orderTracking.registered, {
          ...args,
          carrier: update.carrier,
        });
        await ctx.runMutation(internal.orderTracking.apply, { update, cursor: null });
      }
    } catch {
      await ctx.runMutation(internal.orderTracking.failed, args);
    }
    return null;
  },
});
export const registered = internalMutation({
  args: {
    shipmentId: v.id("orderShipments"),
    generation: v.string(),
    carrier: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.shipmentId);
    const connection = row ? await ctx.db.get(row.connectionId) : null;
    if (
      row?.generation === args.generation &&
      connection?.status === "active" &&
      connection.generation === args.generation
    )
      await ctx.db.patch(row._id, {
        registered: true,
        carrier: args.carrier ?? row.carrier,
        error: undefined,
      });
    return null;
  },
});
export const failed = internalMutation({
  args: { shipmentId: v.id("orderShipments"), generation: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.shipmentId);
    if (row?.generation === args.generation)
      await ctx.db.patch(row._id, {
        error: "TrackingInformationUnavailable",
        nextAttemptAt: Date.now() + 60 * 60_000,
      });
    return null;
  },
});
export const apply = internalMutation({
  args: { update: trackingUpdate, cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { update, cursor }) => {
    const page = await ctx.db
      .query("orderShipments")
      .withIndex("by_number", (q) => q.eq("number", update.number))
      .paginate({ numItems: 50, cursor });
    for (const row of page.page) {
      const connection = await ctx.db.get(row.connectionId);
      if (
        !row.active ||
        !row.registered ||
        row.carrier !== update.carrier ||
        connection?.status !== "active" ||
        connection.generation !== row.generation
      )
        continue;
      if (row.eventAt && (!update.eventAt || row.eventAt > update.eventAt)) continue;
      // Unknown or stale events never replace a dated tracking history.
      await ctx.db.patch(row._id, {
        status: update.status,
        events: update.events,
        eventAt: update.eventAt,
        syncedAt: Date.now(),
        error: undefined,
        nextAttemptAt:
          Date.now() +
          (["Delivered", "Returned"].includes(update.status) ? 365 * 86_400_000 : 6 * 60 * 60_000),
      });
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.orderTracking.apply, {
        update,
        cursor: page.continueCursor,
      });
    return null;
  },
});
