import { v } from "convex/values";

// Shopify CLI's branding schema limits app names to 30 characters.
export const SHOPIFY_APP_NAME_MAX_LENGTH = 30;

export const guidedStatus = v.union(
  ...(
    [
      "initializing",
      "pending",
      "authorized",
      "provisioning",
      "ready",
      "installing",
      "connected",
      "error",
    ] as const
  ).map((s) => v.literal(s)),
);
export const guidedFields = {
  shopId: v.id("shops"),
  organizationId: v.id("organizations"),
  profileId: v.id("profiles"),
  domain: v.string(),
  origin: v.string(),
  status: guidedStatus,
  expiresAt: v.number(),
  nextPollAt: v.number(),
  intervalMs: v.number(),
  secret: v.optional(v.string()),
  userCode: v.optional(v.string()),
  verificationUrl: v.optional(v.string()),
  lease: v.optional(v.string()),
  leaseUntil: v.optional(v.number()),
  operationId: v.optional(v.id("shopifyGuidedOperations")),
  oauthHash: v.optional(v.string()),
  authorizationUrl: v.optional(v.string()),
  errorCode: v.optional(v.string()),
};
export const guidedDoc = v.object({
  _id: v.id("shopifyGuidedSessions"),
  _creationTime: v.number(),
  ...guidedFields,
});
export const guidedPublic = v.object({
  id: v.id("shopifyGuidedSessions"),
  domain: v.string(),
  status: guidedStatus,
  expiresAt: v.number(),
  nextPollAt: v.number(),
  leaseUntil: v.optional(v.number()),
  userCode: v.optional(v.string()),
  verificationUrl: v.optional(v.string()),
  authorizationUrl: v.optional(v.string()),
  errorCode: v.optional(v.string()),
});
