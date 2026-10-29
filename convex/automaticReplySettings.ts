import { ConvexError, v } from "convex/values";
import { env, mutation, query } from "./_generated/server";
import { assertCanManageOrganization, requireShopMembership } from "./lib/authorization";
import { replyRule } from "./lib/automaticReplyPolicy";

export const get = query({
  args: { shopId: v.id("shops") },
  returns: v.object({
    enabled: v.boolean(),
    rules: v.array(replyRule),
    canManage: v.boolean(),
    configured: v.boolean(),
  }),
  handler: async (ctx, { shopId }) => {
    const { membership } = await requireShopMembership(ctx, shopId);
    const settings = await ctx.db
      .query("shopSettings")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .unique();
    return {
      enabled: settings?.autoReplyEnabled ?? false,
      rules: settings?.autoReplyRules ?? [],
      canManage: ["owner", "admin"].includes(membership.role),
      configured: Boolean(env.RESEND_API_KEY && env.OPENAI_API_KEY),
    };
  },
});
export const save = mutation({
  args: { shopId: v.id("shops"), enabled: v.boolean(), rules: v.array(replyRule) },
  returns: v.null(),
  handler: async (ctx, { shopId, enabled, rules }) => {
    const { membership, profile, shop } = await requireShopMembership(ctx, shopId);
    assertCanManageOrganization(membership);
    if (
      rules.length > 40 ||
      new Set(rules.map((r) => `${r.category}:${r.priority}`)).size !== rules.length
    )
      throw new ConvexError("InvalidReplyRules");
    if (
      enabled &&
      (!rules.length || !env.RESEND_API_KEY || !env.OPENAI_API_KEY || shop.status === "disabled")
    )
      throw new ConvexError("AutomaticRepliesUnavailable");
    const settings = await ctx.db
      .query("shopSettings")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .unique();
    if (!settings) throw new ConvexError("ShopSettingsNotFound");
    const sorted = [...rules].sort((a, b) =>
      `${a.category}:${a.priority}`.localeCompare(`${b.category}:${b.priority}`),
    );
    if (
      settings.autoReplyEnabled === enabled &&
      JSON.stringify(settings.autoReplyRules ?? []) === JSON.stringify(sorted)
    )
      return null;
    await ctx.db.patch(settings._id, {
      autoReplyEnabled: enabled,
      autoReplyRules: sorted,
      autoReplyRevision: (settings.autoReplyRevision ?? 0) + 1,
      autoReplyActivatedAt: enabled ? Date.now() : undefined,
      autoReplyUpdatedBy: profile._id,
      updatedAt: Date.now(),
    });
    return null;
  },
});
