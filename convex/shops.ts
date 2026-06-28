import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  assertCanManageOrganization,
  requireMembership,
  requireShopMembership,
} from "./lib/authorization";

export const listForOrganization = query({
  args: {
    organizationId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.organizationId);

    return await ctx.db
      .query("shops")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", args.organizationId))
      .take(100);
  },
});

export const getWithSettings = query({
  args: {
    shopId: v.id("shops"),
  },
  handler: async (ctx, args) => {
    const { shop, membership } = await requireShopMembership(ctx, args.shopId);
    const settings = await ctx.db
      .query("shopSettings")
      .withIndex("by_shopId", (q) => q.eq("shopId", args.shopId))
      .unique();

    return {
      shop,
      membership,
      settings,
    };
  },
});

export const updateSettings = mutation({
  args: {
    shopId: v.id("shops"),
    locale: v.optional(v.string()),
    timezone: v.optional(v.string()),
    autoReplyEnabled: v.optional(v.boolean()),
    escalationEmail: v.optional(v.string()),
    supportEmail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { shop, membership } = await requireShopMembership(ctx, args.shopId);
    assertCanManageOrganization(membership);

    const now = Date.now();
    const settings = await ctx.db
      .query("shopSettings")
      .withIndex("by_shopId", (q) => q.eq("shopId", args.shopId))
      .unique();

    if (!settings) {
      throw new ConvexError("ShopSettingsNotFound");
    }

    if (args.supportEmail !== undefined) {
      await ctx.db.patch(shop._id, {
        supportEmail: normalizeOptionalEmail(args.supportEmail),
        updatedAt: now,
      });
    }

    const settingsPatch = {
      locale: args.locale?.trim() || settings.locale,
      timezone: args.timezone?.trim() || settings.timezone,
      autoReplyEnabled: args.autoReplyEnabled ?? settings.autoReplyEnabled,
      updatedAt: now,
    };

    if (args.escalationEmail !== undefined) {
      await ctx.db.patch(settings._id, {
        ...settingsPatch,
        escalationEmail: normalizeOptionalEmail(args.escalationEmail),
      });
    } else {
      await ctx.db.patch(settings._id, settingsPatch);
    }

    return settings._id;
  },
});

function normalizeOptionalEmail(value: string) {
  const trimmed = value.trim();
  return trimmed || undefined;
}
