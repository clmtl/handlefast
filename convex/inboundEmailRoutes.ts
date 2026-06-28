import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertCanManageOrganization, requireShopMembership } from "./lib/authorization";
import { ensureInboundEmailRouteForShop } from "./lib/inboundEmailRoutes";

export const getForShop = query({
  args: {
    shopId: v.id("shops"),
  },
  handler: async (ctx, args) => {
    await requireShopMembership(ctx, args.shopId);

    const routes = await ctx.db
      .query("inboundEmailRoutes")
      .withIndex("by_shopId_and_status", (q) => q.eq("shopId", args.shopId).eq("status", "active"))
      .take(1);

    return routes[0] ?? null;
  },
});

export const ensureForShop = mutation({
  args: {
    shopId: v.id("shops"),
  },
  handler: async (ctx, args) => {
    const { membership, shop } = await requireShopMembership(ctx, args.shopId);
    assertCanManageOrganization(membership);

    return await ensureInboundEmailRouteForShop(ctx, shop);
  },
});
