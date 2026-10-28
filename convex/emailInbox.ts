import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalQuery, mutation, query } from "./_generated/server";
import { assertCanManageOrganization, requireShopMembership } from "./lib/authorization";
import { receiptDoc, receiptStatus } from "./lib/emailReceiptValidators";

export const connection = query({
  args: { shopId: v.id("shops") },
  returns: v.object({
    address: v.union(v.string(), v.null()),
    supportEmail: v.string(),
    enabled: v.boolean(),
    shopDisabled: v.boolean(),
    verified: v.boolean(),
    lastReceivedAt: v.union(v.number(), v.null()),
    canManage: v.boolean(),
    testSubject: v.union(v.string(), v.null()),
    testExpiresAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, { shopId }) => {
    const { shop, membership } = await requireShopMembership(ctx, shopId);
    const route = await ctx.db
      .query("inboundEmailRoutes")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .order("desc")
      .first();
    const test = route
      ? await ctx.db
          .query("emailConnectionTests")
          .withIndex("by_routeId", (q) => q.eq("routeId", route._id))
          .order("desc")
          .first()
      : null;
    return {
      address: route?.address ?? null,
      supportEmail: shop.supportEmail ?? "",
      enabled: route?.status === "active" && shop.status !== "disabled",
      shopDisabled: shop.status === "disabled",
      verified: Boolean(
        route?.verifiedAt &&
          route.verifiedSupportEmail === shop.supportEmail &&
          route.status === "active" &&
          shop.status !== "disabled",
      ),
      lastReceivedAt: route?.lastReceivedAt ?? null,
      canManage: membership.role === "owner" || membership.role === "admin",
      testSubject: test ? `HandleFast test ${test._id}` : null,
      testExpiresAt: test?.expiresAt ?? null,
    };
  },
});

export const beginTest = mutation({
  args: { shopId: v.id("shops"), supportEmail: v.string() },
  returns: v.string(),
  handler: async (ctx, { shopId, supportEmail }) => {
    const { shop, membership } = await requireShopMembership(ctx, shopId);
    assertCanManageOrganization(membership);
    const email = supportEmail.trim().toLowerCase();
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new ConvexError("InvalidSupportEmail");
    const route = await ctx.db
      .query("inboundEmailRoutes")
      .withIndex("by_shopId_and_status", (q) => q.eq("shopId", shopId).eq("status", "active"))
      .first();
    if (!route || shop.status === "disabled") throw new ConvexError("ReceptionDisabled");
    if (email === route.address) throw new ConvexError("UseYourShopSupportAddress");
    const now = Date.now();
    await ctx.db.patch(shopId, { supportEmail: email, updatedAt: now });
    await ctx.db.patch(route._id, { verifiedAt: undefined, verifiedSupportEmail: undefined });
    const id = await ctx.db.insert("emailConnectionTests", {
      shopId,
      routeId: route._id,
      supportEmail: email,
      createdAt: now,
      expiresAt: now + 30 * 60 * 1000,
    });
    return `HandleFast test ${id}`;
  },
});

export const setEnabled = mutation({
  args: { shopId: v.id("shops"), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { shopId, enabled }) => {
    const { shop, membership } = await requireShopMembership(ctx, shopId);
    assertCanManageOrganization(membership);
    if (enabled && shop.status === "disabled") throw new ConvexError("ShopDisabled");
    const route = await ctx.db
      .query("inboundEmailRoutes")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .order("desc")
      .first();
    if (!route || route.status === "rotated") throw new ConvexError("RouteUnavailable");
    await ctx.db.patch(route._id, {
      status: enabled ? "active" : "disabled",
      verifiedAt: undefined,
      verifiedSupportEmail: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const recent = query({
  args: { shopId: v.id("shops") },
  returns: v.array(
    v.object({
      id: v.id("emailReceipts"),
      from: v.string(),
      receivedAt: v.number(),
      expiresAt: v.number(),
      status: receiptStatus,
      subject: v.string(),
      snippet: v.string(),
      hasOriginal: v.boolean(),
    }),
  ),
  handler: async (ctx, { shopId }) => {
    await requireShopMembership(ctx, shopId);
    const receipts = await ctx.db
      .query("emailReceipts")
      .withIndex("by_shopId_and_receivedAt", (q) => q.eq("shopId", shopId))
      .order("desc")
      .take(25);
    return await Promise.all(
      receipts
        .filter((receipt) => receipt.expiresAt > Date.now())
        .map(async (receipt) => {
          const message = await ctx.db
            .query("supportMessages")
            .withIndex("by_receiptId", (q) => q.eq("receiptId", receipt._id))
            .first();
          return {
            id: receipt._id,
            from: message?.from.address ?? receipt.envelopeFrom,
            receivedAt: receipt.receivedAt,
            expiresAt: receipt.expiresAt,
            status: receipt.status,
            subject: message?.subject ?? "Email awaiting processing",
            snippet: message?.snippet ?? "",
            hasOriginal: Boolean(receipt.rawStorageId),
          };
        }),
    );
  },
});

export const authorizedReceipt = internalQuery({
  args: { receiptId: v.id("emailReceipts") },
  returns: receiptDoc,
  handler: async (ctx, { receiptId }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt) throw new ConvexError("EmailUnavailable");
    await requireShopMembership(ctx, receipt.shopId);
    return receipt;
  },
});

export const download = action({
  args: { receiptId: v.id("emailReceipts") },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const receipt = await ctx.runQuery(internal.emailInbox.authorizedReceipt, args);
    if (!receipt.rawStorageId || receipt.expiresAt <= Date.now())
      throw new ConvexError("EmailUnavailable");
    const url = await ctx.storage.getUrl(receipt.rawStorageId);
    if (!url) throw new ConvexError("EmailUnavailable");
    return url;
  },
});

export const retry = mutation({
  args: { receiptId: v.id("emailReceipts") },
  returns: v.null(),
  handler: async (ctx, { receiptId }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt?.rawStorageId || receipt.expiresAt <= Date.now())
      throw new ConvexError("EmailUnavailable");
    const { shop, membership } = await requireShopMembership(ctx, receipt.shopId);
    assertCanManageOrganization(membership);
    const route = await ctx.db.get(receipt.routeId);
    if (shop.status === "disabled" || route?.status !== "active")
      throw new ConvexError("ReceptionDisabled");
    if (receipt.status !== "failed" && receipt.status !== "paused") return null;
    await ctx.db.patch(receiptId, {
      status: "queued",
      attempts: 0,
      error: undefined,
      nextAttemptAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.emailProcessing.process, { receiptId });
    return null;
  },
});
