import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  assertCanManageOrganization,
  getMembership,
  requireMembership,
  requireProfile,
} from "./lib/authorization";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const { profile } = await requireProfile(ctx);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_profileId", (q) => q.eq("profileId", profile._id))
      .take(50);

    return (
      await Promise.all(
        memberships.map(async (membership) => {
          const organization = await ctx.db.get(membership.organizationId);

          if (!organization) {
            return null;
          }

          return {
            organization,
            membership,
          };
        }),
      )
    ).filter((entry) => entry !== null);
  },
});

export const get = query({
  args: {
    organizationId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId);
    const organization = await ctx.db.get(args.organizationId);

    if (!organization) {
      throw new ConvexError("OrganizationNotFound");
    }

    return {
      organization,
      membership,
    };
  },
});

export const updateName = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId);
    assertCanManageOrganization(membership);

    const name = args.name.trim();

    if (!name) {
      throw new ConvexError("OrganizationNameRequired");
    }

    await ctx.db.patch(args.organizationId, {
      name,
      updatedAt: Date.now(),
    });

    return args.organizationId;
  },
});

export const getMembershipForProfile = query({
  args: {
    organizationId: v.id("organizations"),
    profileId: v.id("profiles"),
  },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId);
    assertCanManageOrganization(membership);

    return await getMembership(ctx, args.organizationId, args.profileId);
  },
});
