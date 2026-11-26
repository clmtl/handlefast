import { ConvexError, v } from "convex/values";
import { env, mutation, query } from "./_generated/server";
import { assertCanManageOrganization, requireShopMembership } from "./lib/authorization";
import { effectiveReplyPolicy, replyRule } from "./lib/automaticReplyPolicy";
import { verifiedShopSender } from "./lib/shopSender";

export const get = query({
  args: { shopId: v.id("shops") },
  returns: v.object({
    enabled: v.boolean(),
    rules: v.array(replyRule),
    canManage: v.boolean(),
    configured: v.boolean(),
    approvalRequired: v.boolean(),
  }),
  handler: async (ctx, { shopId }) => {
    const { membership, shop } = await requireShopMembership(ctx, shopId);
    const settings = await ctx.db
      .query("shopSettings")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .unique();
    const policy = effectiveReplyPolicy(settings);
    return {
      enabled: policy.enabled,
      rules: policy.rules,
      canManage: ["owner", "admin"].includes(membership.role),
      approvalRequired: env.REQUIRE_EMAIL_APPROVAL === "true",
      configured: Boolean(env.RESEND_API_KEY && env.OPENAI_API_KEY && verifiedShopSender(shop)),
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
      (!rules.length ||
        !env.RESEND_API_KEY ||
        !env.OPENAI_API_KEY ||
        !verifiedShopSender(shop) ||
        shop.status === "disabled")
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
      !effectiveReplyPolicy(settings).preset &&
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
