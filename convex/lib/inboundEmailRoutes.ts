import type { Doc } from "../_generated/dataModel";
import { env, type MutationCtx, type QueryCtx } from "../_generated/server";

const defaultInboundEmailDomain = "handlefast.io";
const maxEmailLocalPartLength = 64;

export function normalizeEmailAddress(value: string) {
  return value.trim().toLowerCase();
}

export function getInboundEmailDomain() {
  const configuredDomain = env.INBOUND_EMAIL_DOMAIN?.trim().toLowerCase();
  return configuredDomain || defaultInboundEmailDomain;
}

export async function ensureInboundEmailRouteForShop(
  ctx: MutationCtx,
  shop: Doc<"shops">,
  now = Date.now(),
) {
  if (shop.status === "disabled") {
    return null;
  }

  const existingActiveRoute = await ctx.db
    .query("inboundEmailRoutes")
    .withIndex("by_shopId_and_status", (q) => q.eq("shopId", shop._id).eq("status", "active"))
    .take(1);

  if (existingActiveRoute[0]) {
    return existingActiveRoute[0];
  }

  // Provision once. Disabling or rotating a route must not silently create another.
  const previousRoute = await ctx.db
    .query("inboundEmailRoutes")
    .withIndex("by_shopId", (q) => q.eq("shopId", shop._id))
    .first();
  if (previousRoute) {
    return null;
  }

  const domain = getInboundEmailDomain();
  const baseLocalPart = normalizeEmailLocalPart(`hf_${shop._id}`) || "hf_shop";

  for (let index = 0; index < 20; index += 1) {
    const suffix = index === 0 ? "" : `_${index + 1}`;
    const localPart = `${baseLocalPart.slice(0, maxEmailLocalPartLength - suffix.length)}${suffix}`;
    const address = normalizeEmailAddress(`${localPart}@${domain}`);
    const existingRoute = await ctx.db
      .query("inboundEmailRoutes")
      .withIndex("by_address", (q) => q.eq("address", address))
      .unique();

    if (!existingRoute) {
      const routeId = await ctx.db.insert("inboundEmailRoutes", {
        organizationId: shop.organizationId,
        shopId: shop._id,
        address,
        localPart,
        domain,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const route = await ctx.db.get(routeId);

      if (!route) {
        throw new Error("Failed to create inbound email route");
      }

      return route;
    }

    if (existingRoute.shopId === shop._id && existingRoute.status === "active") {
      return existingRoute;
    }
  }

  throw new Error("Unable to allocate inbound email route");
}

function normalizeEmailLocalPart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._+-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxEmailLocalPartLength);
}

// Per-response Reply-To aliases preserve threads even when a sending provider rewrites Message-ID.
export async function automaticReplyRoute(ctx: MutationCtx | QueryCtx, address: string) {
  const match = /^hf_reply_([a-z0-9-]{36})@([^@]+)$/i.exec(address);
  if (!match) return null;
  const reply = await ctx.db
    .query("automaticReplies")
    .withIndex("by_replyToken", (q) => q.eq("replyToken", match[1]))
    .unique();
  if (!reply || !["sending", "retrying", "sent", "uncertain"].includes(reply.status)) return null;
  const receipt = await ctx.db.get(reply.receiptId);
  if (!receipt || receipt.expiresAt <= Date.now()) return null;
  const route = await ctx.db.get(receipt.routeId);
  return route?.domain === match[2].toLowerCase() ? { reply, route } : null;
}
export async function resolveInboundEmailRoute(ctx: MutationCtx | QueryCtx, address: string) {
  const route = await ctx.db
    .query("inboundEmailRoutes")
    .withIndex("by_address", (q) => q.eq("address", address))
    .unique();
  return (
    route ??
    (await automaticReplyRoute(ctx, address))?.route ??
    (await delayReplyRoute(ctx, address))?.route ??
    null
  );
}
export async function delayReplyRoute(ctx: MutationCtx | QueryCtx, address: string) {
  const match = /^hf_delay_([a-z0-9-]{36})@([^@]+)$/i.exec(address);
  if (!match) return null;
  const notice = await ctx.db
    .query("delayNotices")
    .withIndex("by_replyToken", (q) => q.eq("replyToken", match[1]))
    .unique();
  if (
    !notice ||
    notice.expiresAt <= Date.now() ||
    !["sending", "retrying", "sent", "uncertain"].includes(notice.status) ||
    !notice.routeId ||
    !notice.conversationId
  )
    return null;
  const route = await ctx.db.get(notice.routeId);
  return route?.shopId === notice.shopId && route.domain === match[2].toLowerCase()
    ? { notice, route }
    : null;
}
