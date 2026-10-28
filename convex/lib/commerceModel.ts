import { ConvexError, v } from "convex/values";

export const SHOPIFY_API_VERSION = "2026-10";
export const connectionFields = {
  shopId: v.id("shops"),
  organizationId: v.id("organizations"),
  domain: v.string(),
  shopifyShopId: v.string(),
  clientId: v.string(),
  secret: v.string(),
  token: v.string(),
  tokenExpiresAt: v.number(),
  scopes: v.array(v.string()),
  generation: v.string(),
  status: v.union(v.literal("active"), v.literal("disconnected")),
  nextSyncAt: v.number(),
  syncStartedAt: v.optional(v.number()),
  syncLease: v.optional(v.string()),
  syncedAt: v.optional(v.number()),
  error: v.optional(v.string()),
  createdAt: v.number(),
  lookupAt: v.optional(v.number()),
};
export const orderFields = {
  shopId: v.id("shops"),
  organizationId: v.id("organizations"),
  connectionId: v.id("shopifyConnections"),
  generation: v.string(),
  gid: v.string(),
  name: v.string(),
  email: v.optional(v.string()),
  placedAt: v.number(),
  sourceUpdatedAt: v.number(),
  syncedAt: v.number(),
  financialStatus: v.string(),
  fulfillmentStatus: v.string(),
  cancelled: v.boolean(),
  total: v.string(),
  refunded: v.string(),
  currency: v.string(),
  destination: v.optional(v.object({ city: v.string(), country: v.string(), zip: v.string() })),
  items: v.array(
    v.object({
      id: v.string(),
      title: v.string(),
      quantity: v.number(),
      sku: v.string(),
      variant: v.string(),
    }),
  ),
  detailsTruncated: v.boolean(),
};
export const orderData = v.object({
  gid: orderFields.gid,
  name: orderFields.name,
  email: orderFields.email,
  placedAt: orderFields.placedAt,
  sourceUpdatedAt: orderFields.sourceUpdatedAt,
  financialStatus: orderFields.financialStatus,
  fulfillmentStatus: orderFields.fulfillmentStatus,
  cancelled: orderFields.cancelled,
  total: orderFields.total,
  refunded: orderFields.refunded,
  currency: orderFields.currency,
  destination: orderFields.destination,
  items: orderFields.items,
  detailsTruncated: orderFields.detailsTruncated,
  tracking: v.array(
    v.object({ number: v.string(), company: v.string(), fulfillmentId: v.string() }),
  ),
});
export const trackingEvent = v.object({
  time: v.union(v.number(), v.null()),
  description: v.string(),
  location: v.string(),
});
export const shipmentFields = {
  shopId: v.id("shops"),
  organizationId: v.id("organizations"),
  orderId: v.id("shopifyOrders"),
  connectionId: v.id("shopifyConnections"),
  generation: v.string(),
  number: v.string(),
  company: v.string(),
  fulfillmentId: v.string(),
  carrier: v.optional(v.number()),
  registered: v.boolean(),
  nextAttemptAt: v.number(),
  status: v.string(),
  events: v.array(trackingEvent),
  eventAt: v.optional(v.number()),
  syncedAt: v.optional(v.number()),
  error: v.optional(v.string()),
  active: v.boolean(),
};
export const trackingUpdate = v.object({
  number: v.string(),
  carrier: v.number(),
  status: v.string(),
  events: v.array(trackingEvent),
  eventAt: v.optional(v.number()),
});
export function shopDomain(input: string) {
  const value = input
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\/$/, "");
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(value))
    throw new ConvexError("InvalidShopDomain");
  return value;
}
export function normalizedEmail(input: string | undefined | null) {
  return input?.trim().toLowerCase() || undefined;
}
export function orderReferences(text: string) {
  return [
    ...new Set(
      Array.from(
        text
          .slice(0, 30_000)
          .matchAll(
            /(?:#|(?:commande|order)\s*(?:n[°o.]?\s*)?[:#-]?\s*)([A-Z0-9][A-Z0-9-]{2,30})/gi,
          ),
        (m) => m[1].toUpperCase(),
      ),
    ),
  ].slice(0, 10);
}
export function orderName(value: string) {
  return value.replace(/^#/, "").toUpperCase();
}
