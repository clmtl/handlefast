import { ConvexError, v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import { action, env, internalAction, internalMutation } from "./_generated/server";
import { requireShopMembership } from "./lib/authorization";
import { shipmentFields, trackingUpdate } from "./lib/commerceModel";
import { normalizeTracking, track17 } from "./lib/commerceProviders";

export const claimManual = internalMutation({
  args: { shipmentId: v.id("orderShipments") },
  returns: v.object({ _id: v.id("orderShipments"), _creationTime: v.number(), ...shipmentFields }),
  handler: async (ctx, { shipmentId }) => {
    const row = await ctx.db.get(shipmentId);
    if (!row) throw new ConvexError("TrackingUnavailable");
    const { shop, membership } = await requireShopMembership(ctx, row.shopId);
    const connection = await ctx.db.get(row.connectionId);
    if (
      membership.role === "viewer" ||
      shop.status === "disabled" ||
      !row.active ||
      connection?.status !== "active" ||
      connection.generation !== row.generation ||
      (row.manualRefreshUntil ?? 0) > Date.now()
    )
      throw new ConvexError("TrackingUnavailable");
    await ctx.db.patch(shipmentId, { manualRefreshUntil: Date.now() + 60_000 });
    return row;
  },
});

export const refreshManually = action({
  args: { shipmentId: v.id("orderShipments") },
  returns: v.boolean(),
  handler: async (ctx, { shipmentId }): Promise<boolean> => {
    const key = env.TRACK17_API_KEY;
    if (!key) throw new ConvexError("TrackingUnavailable");
    const row = await ctx.runMutation(internal.orderTracking.claimManual, { shipmentId });
    const args = { shipmentId, generation: row.generation };
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
        return true;
      }
      throw new Error("TrackingInformationUnavailable");
    } catch {
      await ctx.runMutation(internal.orderTracking.failed, args);
      return false;
    }
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
        milestones: update.milestones
          ? { ...row.milestones, ...update.milestones }
          : row.milestones,
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

export const claimStorefront = internalMutation({
  args: { domain: v.string() },
  handler: async (ctx, { domain }) => {
    const connection = await ctx.db
      .query("shopifyConnections")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .unique();
    if (connection?.status !== "active") return [];
    const shop = await ctx.db.get("shops", connection.shopId);
    if (!shop || shop.status === "disabled") return [];
    const now = Date.now();
    const shipments = await ctx.db
      .query("orderShipments")
      .withIndex("by_connectionId_and_active_and_autoTrackAt", (q) =>
        q
          .eq("connectionId", connection._id)
          .eq("active", true)
          .gt("autoTrackAt", undefined)
          .lte("autoTrackAt", now),
      )
      .take(40);
    for (const row of shipments) {
      await ctx.db.patch("orderShipments", row._id, {
        autoTrackAt: row.generation === connection.generation ? now + 15 * 60_000 : undefined,
      });
    }
    return shipments.filter(
      (row) => row.generation === connection.generation && (row.manualRefreshUntil ?? 0) <= now,
    );
  },
});

export const finishStorefront = internalMutation({
  args: { shipmentId: v.id("orderShipments"), generation: v.string() },
  handler: async (ctx, { shipmentId, generation }) => {
    const row = await ctx.db.get("orderShipments", shipmentId);
    if (!row?.active || row.generation !== generation) return;
    await ctx.db.patch("orderShipments", shipmentId, {
      autoTrackAt: ["Delivered", "Returned"].includes(row.status)
        ? undefined
        : Date.now() + (row.events.length ? 6 * 60 : 15) * 60_000,
    });
  },
});

export const refreshStorefront = internalAction({
  args: {},
  handler: async (ctx) => {
    const domain = env.STOREFRONT_TRACKING_AUTO_REGISTER;
    const key = env.TRACK17_API_KEY;
    if (!domain || !key) return;
    const rows = await ctx.runMutation(internal.orderTracking.claimStorefront, { domain });
    if (!rows.length) return;

    const unregistered = new Map(
      rows.filter((row) => !row.registered).map((row) => [row.number, row]),
    );
    const accepted = new Map<string, number | undefined>();
    if (unregistered.size) {
      const result = await track17(
        key,
        "register",
        [...unregistered.values()].map((row) => ({ number: row.number, tag: String(row._id) })),
      );
      for (const item of result.data?.accepted ?? []) {
        const parsed = z
          .object({ number: z.string(), carrier: z.number().int().positive() })
          .safeParse(item);
        if (parsed.success) accepted.set(parsed.data.number, parsed.data.carrier);
      }
      for (const item of result.data?.rejected ?? []) {
        if (item.error.code === -18019901 && !accepted.has(item.number))
          accepted.set(item.number, undefined);
      }
    }

    const subscribed = rows.filter((row) => row.registered || accepted.has(row.number));
    for (const row of subscribed) {
      if (row.registered) continue;
      await ctx.runMutation(internal.orderTracking.registered, {
        shipmentId: row._id,
        generation: row.generation,
        carrier: accepted.get(row.number),
      });
    }
    const requests = new Map(
      subscribed.map((row) => {
        const carrier = row.carrier ?? accepted.get(row.number);
        return [
          `${row.number}:${carrier ?? ""}`,
          { number: row.number, ...(carrier ? { carrier } : {}) },
        ];
      }),
    );
    if (!requests.size) return;
    const details = await track17(key, "gettrackinfo", [...requests.values()]);
    for (const item of details.data?.accepted ?? []) {
      const update = normalizeTracking(item);
      const matches = subscribed.filter(
        (row) =>
          row.number === update.number &&
          ((row.carrier ?? accepted.get(row.number)) === undefined ||
            (row.carrier ?? accepted.get(row.number)) === update.carrier),
      );
      if (!matches.length) continue;
      for (const row of matches) {
        await ctx.runMutation(internal.orderTracking.registered, {
          shipmentId: row._id,
          generation: row.generation,
          carrier: update.carrier,
        });
      }
      await ctx.runMutation(internal.orderTracking.apply, { update, cursor: null });
      for (const row of matches) {
        await ctx.runMutation(internal.orderTracking.finishStorefront, {
          shipmentId: row._id,
          generation: row.generation,
        });
      }
    }
  },
});
