import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authComponent } from "../auth";

export const roles = ["owner", "admin", "agent", "viewer"] as const;

export type Role = (typeof roles)[number];
export type AppCtx = QueryCtx | MutationCtx;

export type AuthUser = {
  _id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null;
};

export type AuthContext = {
  authUser: AuthUser;
  tokenIdentifier: string;
};

const managementRoles = new Set<Role>(["owner", "admin"]);

export async function requireAuthContext(ctx: AppCtx): Promise<AuthContext> {
  const [authUser, identity] = await Promise.all([
    authComponent.safeGetAuthUser(ctx),
    ctx.auth.getUserIdentity(),
  ]);

  if (!identity || !authUser) {
    throw new ConvexError("Unauthenticated");
  }

  if (!authUser.emailVerified) {
    throw new ConvexError("EmailVerificationRequired");
  }

  return {
    authUser,
    tokenIdentifier: identity.tokenIdentifier,
  };
}

export async function getProfileByAuthUserId(ctx: AppCtx, authUserId: string) {
  return await ctx.db
    .query("profiles")
    .withIndex("by_authUserId", (q) => q.eq("authUserId", authUserId))
    .unique();
}

export async function requireProfile(ctx: AppCtx) {
  const auth = await requireAuthContext(ctx);
  const profile = await getProfileByAuthUserId(ctx, auth.authUser._id);

  if (!profile) {
    throw new ConvexError("OnboardingRequired");
  }

  return {
    ...auth,
    profile,
  };
}

export async function getMembership(
  ctx: AppCtx,
  organizationId: Id<"organizations">,
  profileId: Id<"profiles">,
) {
  return await ctx.db
    .query("memberships")
    .withIndex("by_organizationId_and_profileId", (q) =>
      q.eq("organizationId", organizationId).eq("profileId", profileId),
    )
    .unique();
}

export async function requireMembership(ctx: AppCtx, organizationId: Id<"organizations">) {
  const auth = await requireProfile(ctx);
  const membership = await getMembership(ctx, organizationId, auth.profile._id);

  if (!membership) {
    throw new ConvexError("Forbidden");
  }

  return {
    ...auth,
    membership,
  };
}

export async function requireShopMembership(ctx: AppCtx, shopId: Id<"shops">) {
  const shop = await ctx.db.get(shopId);

  if (!shop) {
    throw new ConvexError("ShopNotFound");
  }

  const auth = await requireMembership(ctx, shop.organizationId);

  return {
    ...auth,
    shop,
  };
}

export function assertCanManageOrganization(membership: Doc<"memberships">) {
  if (!managementRoles.has(membership.role)) {
    throw new ConvexError("Forbidden");
  }
}

export function normalizeRole(role: string): Role {
  if (roles.includes(role as Role)) {
    return role as Role;
  }

  throw new ConvexError("InvalidRole");
}
