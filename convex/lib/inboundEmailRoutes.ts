import type { Doc } from "../_generated/dataModel";
import { env, type MutationCtx } from "../_generated/server";

const defaultInboundEmailDomain = "in.handlefast.io";
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
  const existingActiveRoute = await ctx.db
    .query("inboundEmailRoutes")
    .withIndex("by_shopId_and_status", (q) => q.eq("shopId", shop._id).eq("status", "active"))
    .take(1);

  if (existingActiveRoute[0]) {
    return existingActiveRoute[0];
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
