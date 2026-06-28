import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const roleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("agent"),
  v.literal("viewer"),
);

export const inboundEmailRouteStatusValidator = v.union(
  v.literal("active"),
  v.literal("disabled"),
  v.literal("rotated"),
);

export const inboundEmailDeliveryStatusValidator = v.union(
  v.literal("received"),
  v.literal("duplicate"),
  v.literal("unmatched"),
  v.literal("failed"),
);

export const supportConversationStatusValidator = v.union(
  v.literal("open"),
  v.literal("pending"),
  v.literal("closed"),
);

export const supportMessageDirectionValidator = v.union(
  v.literal("inbound"),
  v.literal("outbound"),
);

const emailIdentityValidator = v.object({
  address: v.string(),
  name: v.optional(v.string()),
});

const inboundEmailHeaderValidator = v.object({
  name: v.string(),
  value: v.string(),
});

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

  inboundEmailRoutes: defineTable({
    organizationId: v.id("organizations"),
    shopId: v.id("shops"),
    address: v.string(),
    localPart: v.string(),
    domain: v.string(),
    status: inboundEmailRouteStatusValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_address", ["address"])
    .index("by_shopId", ["shopId"])
    .index("by_shopId_and_status", ["shopId", "status"])
    .index("by_organizationId", ["organizationId"])
    .index("by_organizationId_and_status", ["organizationId", "status"]),

  inboundEmailDeliveries: defineTable({
    organizationId: v.optional(v.id("organizations")),
    shopId: v.optional(v.id("shops")),
    routeId: v.optional(v.id("inboundEmailRoutes")),
    provider: v.literal("cloudflare_email_routing"),
    deliveryKey: v.string(),
    envelopeFrom: v.string(),
    envelopeTo: v.string(),
    messageId: v.optional(v.string()),
    receivedAt: v.number(),
    rawSize: v.number(),
    status: inboundEmailDeliveryStatusValidator,
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_deliveryKey", ["deliveryKey"])
    .index("by_organizationId_and_receivedAt", ["organizationId", "receivedAt"])
    .index("by_shopId_and_receivedAt", ["shopId", "receivedAt"])
    .index("by_status_and_createdAt", ["status", "createdAt"]),

  supportConversations: defineTable({
    organizationId: v.id("organizations"),
    shopId: v.id("shops"),
    routeId: v.id("inboundEmailRoutes"),
    customerEmail: v.string(),
    subject: v.optional(v.string()),
    status: supportConversationStatusValidator,
    lastMessageAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organizationId_and_lastMessageAt", ["organizationId", "lastMessageAt"])
    .index("by_shopId_and_status_and_lastMessageAt", ["shopId", "status", "lastMessageAt"])
    .index("by_shopId_and_customerEmail", ["shopId", "customerEmail"]),

  supportMessages: defineTable({
    organizationId: v.id("organizations"),
    shopId: v.id("shops"),
    conversationId: v.id("supportConversations"),
    routeId: v.id("inboundEmailRoutes"),
    deliveryId: v.id("inboundEmailDeliveries"),
    direction: supportMessageDirectionValidator,
    from: emailIdentityValidator,
    to: v.array(emailIdentityValidator),
    cc: v.array(emailIdentityValidator),
    replyTo: v.array(emailIdentityValidator),
    subject: v.optional(v.string()),
    text: v.optional(v.string()),
    html: v.optional(v.string()),
    snippet: v.optional(v.string()),
    headers: v.array(inboundEmailHeaderValidator),
    messageId: v.optional(v.string()),
    inReplyTo: v.optional(v.string()),
    references: v.array(v.string()),
    receivedAt: v.number(),
    rawSize: v.number(),
    attachmentCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_conversationId_and_createdAt", ["conversationId", "createdAt"])
    .index("by_shopId_and_createdAt", ["shopId", "createdAt"])
    .index("by_deliveryId", ["deliveryId"])
    .index("by_messageId", ["messageId"]),

  emailAttachments: defineTable({
    organizationId: v.id("organizations"),
    shopId: v.id("shops"),
    messageId: v.id("supportMessages"),
    filename: v.optional(v.string()),
    contentType: v.string(),
    size: v.number(),
    disposition: v.optional(v.union(v.literal("attachment"), v.literal("inline"))),
    contentId: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    createdAt: v.number(),
  })
    .index("by_messageId", ["messageId"])
    .index("by_shopId", ["shopId"])
    .index("by_organizationId", ["organizationId"]),
});
