import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { requireShopMembership } from "./lib/authorization";
import { clipEmailText, emailBodyText, translation } from "./lib/emailTranslationPolicy";
import { shopifyContactAddress } from "./lib/shopifyContact";

export function messageText(message: Doc<"supportMessages">) {
  return emailBodyText(message.text, message.html) || message.snippet || "";
}

export const translationTarget = v.union(v.id("supportMessages"), v.id("automaticReplies"));

export const timeline = query({
  args: {
    receiptId: v.id("emailReceipts"),
    includeOlder: v.boolean(),
    shopId: v.optional(v.id("shops")),
  },
  returns: v.array(
    v.object({
      id: translationTarget,
      receiptId: v.optional(v.id("emailReceipts")),
      direction: v.union(v.literal("inbound"), v.literal("outbound")),
      sender: v.string(),
      subject: v.string(),
      date: v.number(),
      text: v.string(),
      translation: v.optional(translation),
      attachmentCount: v.number(),
    }),
  ),
  handler: async (ctx, { receiptId, includeOlder, shopId }) => {
    const receipt = await ctx.db.get(receiptId);
    const now = Date.now();
    if (!receipt || receipt.expiresAt <= now || (shopId && receipt.shopId !== shopId)) return [];
    await requireShopMembership(ctx, receipt.shopId);
    const message = await ctx.db
      .query("supportMessages")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
      .first();
    if (!message) return [];
    const conversationId = message.conversationId;
    const limit = includeOlder ? 50 : 25;
    const [siblings, replies] = conversationId
      ? await Promise.all([
          ctx.db
            .query("supportMessages")
            .withIndex("by_conversationId_and_receivedAt", (q) =>
              q.eq("conversationId", conversationId),
            )
            .order("desc")
            .take(limit),
          ctx.db
            .query("automaticReplies")
            .withIndex("by_conversationId_and_status", (q) =>
              q.eq("conversationId", conversationId).eq("status", "sent"),
            )
            .order("desc")
            .take(limit),
        ])
      : [[message], []];
    if (!siblings.some((sibling) => sibling._id === message._id)) siblings.push(message);
    const incoming = siblings
      .filter((item) => item.shopId === receipt.shopId && (item.expiresAt ?? 0) > now)
      .map((item) => ({
        id: item._id,
        receiptId: item.receiptId,
        direction: item.direction,
        sender:
          shopifyContactAddress(item) ??
          (item.from.name ? `${item.from.name} · ${item.from.address}` : item.from.address),
        subject: item.subject ?? "(sans objet)",
        date: item.receivedAt,
        text: clipEmailText(messageText(item)),
        translation: item.translation,
        attachmentCount: item.attachmentCount,
      }));
    const sent = replies.flatMap((reply) =>
      reply.shopId === receipt.shopId && reply.sentAt && reply.payload
        ? [
            {
              id: reply._id,
              receiptId: undefined,
              direction: "outbound" as const,
              sender: reply.payload.from,
              subject: reply.payload.subject,
              date: reply.sentAt,
              text: reply.payload.text,
              translation: reply.translation,
              attachmentCount: 0,
            },
          ]
        : [],
    );
    return [...incoming, ...sent].sort((a, b) => a.date - b.date);
  },
});
