import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const roleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("agent"),
  v.literal("viewer"),
);

export default defineSchema({
  launchPreferences: defineTable({
    email: v.string(),
    source: v.string(),
    createdAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_createdAt", ["createdAt"]),

  profiles: defineTable({
    authUserId: v.string(),
    authTokenIdentifier: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_authUserId", ["authUserId"])
    .index("by_authTokenIdentifier", ["authTokenIdentifier"])
    .index("by_email", ["email"]),

  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_createdAt", ["createdAt"]),

  memberships: defineTable({
    organizationId: v.id("organizations"),
    profileId: v.id("profiles"),
    role: roleValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_profileId", ["profileId"])
    .index("by_organizationId", ["organizationId"])
    .index("by_organizationId_and_profileId", ["organizationId", "profileId"])
    .index("by_profileId_and_organizationId", ["profileId", "organizationId"])
    .index("by_organizationId_and_role", ["organizationId", "role"]),

  shops: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    slug: v.string(),
    platform: v.union(v.literal("manual"), v.literal("shopify")),
    status: v.union(v.literal("setup"), v.literal("active"), v.literal("disabled")),
    supportEmail: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId", ["organizationId"])
    .index("by_organizationId_and_slug", ["organizationId", "slug"])
    .index("by_organizationId_and_status", ["organizationId", "status"])
    .index("by_createdAt", ["createdAt"]),

  shopSettings: defineTable({
    organizationId: v.id("organizations"),
    shopId: v.id("shops"),
    locale: v.string(),
    timezone: v.string(),
    autoReplyEnabled: v.boolean(),
    escalationEmail: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_shopId", ["shopId"])
    .index("by_organizationId", ["organizationId"])
    .index("by_organizationId_and_shopId", ["organizationId", "shopId"]),
});
