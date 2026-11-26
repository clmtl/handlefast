import type { Doc } from "../_generated/dataModel";
import { env } from "../_generated/server";
import { validMailbox } from "./automaticReplyPolicy";
import { getInboundEmailDomain } from "./inboundEmailRoutes";

export function verifiedShopSender(shop: Doc<"shops"> | null) {
  const address = shop?.supportEmail?.toLowerCase();
  if (
    !shop ||
    !address ||
    !validMailbox(address) ||
    address.endsWith(`@${getInboundEmailDomain()}`) ||
    !env.VERIFIED_SHOP_SENDERS
  )
    return null;
  let senders: unknown;
  try {
    senders = JSON.parse(env.VERIFIED_SHOP_SENDERS);
  } catch {
    return null;
  }
  // Only deployment operators can authorize a specific address for a specific shop.
  if (
    !senders ||
    typeof senders !== "object" ||
    Array.isArray(senders) ||
    !Object.hasOwn(senders, shop._id) ||
    (senders as Record<string, unknown>)[shop._id] !== address
  )
    return null;
  return address;
}
