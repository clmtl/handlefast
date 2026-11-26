import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { suppressAutoResponse, validMailbox } from "./automaticReplyPolicy";
import { verifiedShopSender } from "./shopSender";

export async function manualReplyTarget(
  ctx: QueryCtx | MutationCtx,
  receipt: Doc<"emailReceipts">,
) {
  if (
    receipt.expiresAt <= Date.now() ||
    receipt.status !== "processed" ||
    receipt.triage?.bucket !== "sav" ||
    (receipt.automaticReplySuppressed && !receipt.proactiveNoticeId)
  )
    return null;
  const [shop, route, message] = await Promise.all([
    ctx.db.get(receipt.shopId),
    ctx.db.get(receipt.routeId),
    ctx.db
      .query("supportMessages")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", receipt._id))
      .unique(),
  ]);
  if (
    !shop ||
    shop.status === "disabled" ||
    route?.status !== "active" ||
    route.shopId !== shop._id ||
    !message?.conversationId ||
    message.direction !== "inbound" ||
    suppressAutoResponse(message.headers)
  )
    return null;
  const to = message.from.address.toLowerCase();
  if (
    !validMailbox(to) ||
    to === route.address ||
    to === shop.supportEmail?.toLowerCase() ||
    /(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster)(?:[+._-][^@]*)?@/i.test(to) ||
    message.replyTo.some((reply) => reply.address.toLowerCase() !== to)
  )
    return null;
  const latest = await ctx.db
    .query("supportMessages")
    .withIndex("by_conversationId_and_direction_and_receivedAt", (q) =>
      q.eq("conversationId", message.conversationId).eq("direction", "inbound"),
    )
    .order("desc")
    .first();
  if (latest?._id !== message._id) return null;
  const from = verifiedShopSender(shop);
  if (!from) return null;
  return {
    from,
    to,
    route,
    message,
    conversationId: message.conversationId,
  };
}
