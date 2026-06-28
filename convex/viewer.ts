import { query } from "./_generated/server";
import { getProfileByAuthUserId, requireAuthContext, requireProfile } from "./lib/authorization";

export const me = query({
  args: {},
  handler: async (ctx) => {
    const { authUser } = await requireAuthContext(ctx);
    const profile = await getProfileByAuthUserId(ctx, authUser._id);

    if (!profile) {
      return {
        profile: null,
        organizations: [],
        memberships: [],
        shops: [],
        shopSettings: [],
        hasCompletedOnboarding: false,
      };
    }

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_profileId", (q) => q.eq("profileId", profile._id))
      .take(20);

    const organizations = (
      await Promise.all(memberships.map((membership) => ctx.db.get(membership.organizationId)))
    ).filter((organization) => organization !== null);

    const activeOrganization = organizations[0];
    const shops = activeOrganization
      ? await ctx.db
          .query("shops")
          .withIndex("by_organizationId", (q) => q.eq("organizationId", activeOrganization._id))
          .take(20)
      : [];

    const shopSettings = (
      await Promise.all(
        shops.map((shop) =>
          ctx.db
            .query("shopSettings")
            .withIndex("by_shopId", (q) => q.eq("shopId", shop._id))
            .unique(),
        ),
      )
    ).filter((settings) => settings !== null);

    return {
      profile,
      organizations,
      memberships,
      shops,
      shopSettings,
      hasCompletedOnboarding: memberships.length > 0,
    };
  },
});

export const requireOnboarded = query({
  args: {},
  handler: async (ctx) => {
    const { profile } = await requireProfile(ctx);
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_profileId", (q) => q.eq("profileId", profile._id))
      .take(1);

    if (membership.length === 0) {
      return {
        hasCompletedOnboarding: false,
      };
    }

    return {
      hasCompletedOnboarding: true,
    };
  },
});
