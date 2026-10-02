import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertCanManageOrganization, requireShopMembership } from "./lib/authorization";
import { ensureInboundEmailRouteForShop } from "./lib/inboundEmailRoutes";
import { inboundEmailRouteStatusValidator } from "./schema";

const routeValidator = v.union(
  v.null(),
  v.object({
    _id: v.id("inboundEmailRoutes"),
    _creationTime: v.number(),
    organizationId: v.id("organizations"),
    shopId: v.id("shops"),
    address: v.string(),
    localPart: v.string(),
    lastReceivedAt: v.optional(v.number()),
    verifiedAt: v.optional(v.number()),
    verifiedSupportEmail: v.optional(v.string()),
    domain: v.string(),
    status: inboundEmailRouteStatusValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  }),
);

export const getForShop = query({
  args: {
    shopId: v.id("shops"),
  },
  returns: routeValidator,
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
  returns: routeValidator,
  handler: async (ctx, args) => {
    const { membership, shop } = await requireShopMembership(ctx, args.shopId);
    assertCanManageOrganization(membership);

    return await ensureInboundEmailRouteForShop(ctx, shop);
  },
});
