import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";
import { getProfileByAuthUserId, requireAuthContext } from "./lib/authorization";
import { ensureInboundEmailRouteForShop } from "./lib/inboundEmailRoutes";
import { slugify } from "./lib/slugs";

export const bootstrap = mutation({
  args: {
    organizationName: v.optional(v.string()),
    shopName: v.optional(v.string()),
  },
  returns: v.object({
    profileId: v.id("profiles"),
    organizationId: v.id("organizations"),
    shopId: v.optional(v.id("shops")),
    inboundEmailRouteId: v.optional(v.id("inboundEmailRoutes")),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { authUser, tokenIdentifier } = await requireAuthContext(ctx);
    const now = Date.now();
    const email = authUser.email ?? undefined;
    const fallbackName = email ? email.split("@")[0] : "HandleFast";
    const profileName = authUser.name ?? fallbackName;

    let profile = await getProfileByAuthUserId(ctx, authUser._id);

    if (!profile) {
      const profileId = await ctx.db.insert("profiles", {
        authUserId: authUser._id,
        authTokenIdentifier: tokenIdentifier,
        ...(email ? { email } : {}),
        name: profileName,
        ...(authUser.image ? { image: authUser.image } : {}),
        createdAt: now,
        updatedAt: now,
      });
      profile = await ctx.db.get(profileId);
    } else {
      await ctx.db.patch(profile._id, {
        authTokenIdentifier: tokenIdentifier,
        ...(email ? { email } : {}),
        name: profileName,
        ...(authUser.image ? { image: authUser.image } : {}),
        updatedAt: now,
      });
    }

    if (!profile) {
      throw new Error("Failed to create profile");
    }

    const existingMembership = await ctx.db
      .query("memberships")
      .withIndex("by_profileId", (q) => q.eq("profileId", profile._id))
      .take(1);

    if (existingMembership.length > 0) {
      const existingShop = await ctx.db
        .query("shops")
        .withIndex("by_organizationId", (q) =>
          q.eq("organizationId", existingMembership[0].organizationId),
        )
        .take(1);
      const inboundEmailRoute = existingShop[0]
        ? await ctx.db
            .query("inboundEmailRoutes")
            .withIndex("by_shopId_and_status", (q) =>
              q.eq("shopId", existingShop[0]._id).eq("status", "active"),
            )
            .first()
        : null;

      return {
        profileId: profile._id,
        organizationId: existingMembership[0].organizationId,
        ...(existingShop[0] ? { shopId: existingShop[0]._id } : {}),
        ...(inboundEmailRoute ? { inboundEmailRouteId: inboundEmailRoute._id } : {}),
        created: false,
      };
    }

    const organizationName = args.organizationName?.trim() || `${profileName}'s organization`;
    const organizationSlug = await getAvailableOrganizationSlug(ctx, organizationName);
    const organizationId = await ctx.db.insert("organizations", {
      name: organizationName,
      slug: organizationSlug,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("memberships", {
      organizationId,
      profileId: profile._id,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });

    const { shopId, inboundEmailRouteId } = await createShop(
      ctx,
      organizationId,
      args.shopName?.trim() || "Primary shop",
    );

    return {
      profileId: profile._id,
      organizationId,
      shopId,
      inboundEmailRouteId,
      created: true,
    };
  },
});

export async function createShop(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  name: string,
) {
  const baseSlug = slugify(name);
  let slug = baseSlug;
  for (let suffix = 2; ; suffix += 1) {
    const existing = await ctx.db
      .query("shops")
      .withIndex("by_organizationId_and_slug", (q) =>
        q.eq("organizationId", organizationId).eq("slug", slug),
      )
      .unique();
    if (!existing) break;
    if (suffix > 20) throw new Error("ShopNameUnavailable");
    slug = `${baseSlug}-${suffix}`;
  }
  const now = Date.now();
  const shopId = await ctx.db.insert("shops", {
    organizationId,
    name,
    slug,
    platform: "manual",
    status: "setup",
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("shopSettings", {
    organizationId,
    shopId,
    locale: "en",
    timezone: "UTC",
    autoReplyEnabled: false,
    createdAt: now,
    updatedAt: now,
  });
  const shop = await ctx.db.get(shopId);
  if (!shop) throw new Error("ShopNotFound");
  const route = await ensureInboundEmailRouteForShop(ctx, shop, now);
  if (!route) throw new Error("InboundEmailRouteUnavailable");
  return { shopId, inboundEmailRouteId: route._id };
}

async function getAvailableOrganizationSlug(ctx: MutationCtx, organizationName: string) {
  const baseSlug = slugify(organizationName);

  for (let index = 0; index < 20; index += 1) {
    const candidate = index === 0 ? baseSlug : `${baseSlug}-${index + 1}`;
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .unique();

    if (!existing) {
      return candidate;
    }
  }

  throw new Error("Unable to allocate organization slug");
}
