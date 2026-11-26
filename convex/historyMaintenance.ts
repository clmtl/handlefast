import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";

import { shopifyContactAddress } from "./lib/shopifyContact";

const cursor = v.union(v.string(), v.null());
const result = v.object({ nextCursor: cursor, changed: v.number() });

export const resolveReviewedMail = internalMutation({
  args: { shopId: v.id("shops"), keepOpen: v.id("emailReceipts"), through: v.number(), cursor },
  returns: result,
  handler: async (ctx, args) => {
    const keep = await ctx.db.get(args.keepOpen);
    if (keep?.shopId !== args.shopId || keep.triage?.bucket !== "sav" || !keep.humanReview)
      throw new ConvexError("ReviewUnavailable");
    const now = Date.now();
    const page = await ctx.db
      .query("emailReceipts")
      .withIndex("by_shopId_and_triage_bucket_and_receivedAt", (q) =>
        q.eq("shopId", args.shopId).eq("triage.bucket", "sav").lte("receivedAt", args.through),
      )
      .paginate({ cursor: args.cursor, numItems: 75 });
    let changed = 0;
    for (const receipt of page.page) {
      if (!receipt.humanReview || receipt.expiresAt <= now || receipt._creationTime > args.through)
        continue;
      const status = receipt._id === keep._id ? "open" : "resolved";
      if (receipt.humanReview.status === status) continue;
      await ctx.db.patch(receipt._id, {
        humanReview: { ...receipt.humanReview, status, updatedAt: now },
      });
      changed++;
    }
    return { nextCursor: page.isDone ? null : page.continueCursor, changed };
  },
});

const replyPrefix = /^(?:(?:re|aw|sv)\s*:\s*)+/i;
function normalizedSubject(subject: string) {
  return subject.trim().replace(replyPrefix, "").trim().replace(/\s+/g, " ").toLowerCase();
}

export const reconnectHistoricalReplies = internalMutation({
  args: { shopId: v.id("shops"), cursor },
  returns: result,
  handler: async (ctx, args) => {
    const shop = await ctx.db.get(args.shopId);
    if (!shop) throw new ConvexError("ShopUnavailable");
    const now = Date.now();
    const page = await ctx.db
      .query("supportMessages")
      .withIndex("by_shopId_and_createdAt", (q) => q.eq("shopId", shop._id))
      .paginate({ cursor: args.cursor, numItems: 40 });
    let changed = 0;
    for (const message of page.page) {
      if (message.direction !== "outbound" || (message.expiresAt ?? 0) <= now) continue;
      const sent = await ctx.db.get(message._id);
      if (!sent?.conversationId) continue;
      const before = await ctx.db
        .query("supportMessages")
        .withIndex("by_conversationId_and_direction_and_receivedAt", (q) =>
          q.eq("conversationId", sent.conversationId).eq("direction", "inbound"),
        )
        .first();
      const conversation = await ctx.db.get(sent.conversationId);
      if (!conversation) continue;
      const reference = await referencedShopifyForm(ctx, sent, conversation.customerEmail, now);
      if (reference?.conversationId) {
        if (reference.conversationId === conversation._id) continue;
        const parent = await ctx.db.get(reference.conversationId);
        if (
          parent?.shopId === shop._id &&
          (parent.customerEmail === conversation.customerEmail ||
            parent.customerEmail === "mailer@shopify.com")
        ) {
          if (before) {
            changed += await mergeShopifyThread(ctx, parent, conversation, now);
          } else {
            if (parent.customerEmail === "mailer@shopify.com")
              await ctx.db.patch(parent._id, {
                customerEmail: conversation.customerEmail,
                updatedAt: now,
              });
            await reconnect(ctx, sent, parent, now);
            changed++;
          }
          continue;
        }
      }
      if (before) continue;
      const subject = normalizedSubject(sent.subject ?? "");
      if (!subject || !replyPrefix.test(sent.subject?.trim() ?? "")) continue;
      const candidates = await ctx.db
        .query("supportMessages")
        .withIndex("by_shopId_and_from_address_and_receivedAt", (q) =>
          q
            .eq("shopId", shop._id)
            .eq("from.address", conversation.customerEmail)
            .lte("receivedAt", sent.receivedAt),
        )
        .order("desc")
        .take(51);
      if (candidates.length > 50) continue;
      const matches = new Set(
        candidates.flatMap((message) =>
          message.direction === "inbound" &&
          message.conversationId &&
          (message.expiresAt ?? 0) > now &&
          normalizedSubject(message.subject ?? "") === subject
            ? [message.conversationId]
            : [],
        ),
      );
      const [target] = matches;
      if (matches.size !== 1 || !target) continue;
      const parent = await ctx.db.get(target);
      if (
        !parent ||
        parent.shopId !== shop._id ||
        parent.customerEmail !== conversation.customerEmail
      )
        continue;
      await reconnect(ctx, sent, parent, now);
      changed++;
    }
    return { nextCursor: page.isDone ? null : page.continueCursor, changed };
  },
});

async function referencedShopifyForm(
  ctx: MutationCtx,
  sent: Doc<"supportMessages">,
  address: string,
  now: number,
) {
  for (const id of new Set([sent.inReplyTo, ...[...sent.references].reverse()])) {
    if (!id) continue;
    const message = await ctx.db
      .query("supportMessages")
      .withIndex("by_shopId_and_messageId", (q) => q.eq("shopId", sent.shopId).eq("messageId", id))
      .first();
    if (
      message?.direction === "inbound" &&
      message.conversationId &&
      (message.expiresAt ?? 0) > now &&
      message.receivedAt <= sent.receivedAt &&
      shopifyContactAddress(message) === address
    )
      return message;
  }
  return null;
}

async function reconnect(
  ctx: MutationCtx,
  sent: Doc<"supportMessages">,
  parent: Doc<"supportConversations">,
  now: number,
) {
  await ctx.db.patch(sent._id, { conversationId: parent._id, updatedAt: now });
  if (sent.receivedAt > parent.lastMessageAt)
    await ctx.db.patch(parent._id, { lastMessageAt: sent.receivedAt, updatedAt: now });
}

async function mergeShopifyThread(
  ctx: MutationCtx,
  source: Doc<"supportConversations">,
  target: Doc<"supportConversations">,
  now: number,
) {
  const messages = await ctx.db
    .query("supportMessages")
    .withIndex("by_conversationId_and_receivedAt", (q) => q.eq("conversationId", source._id))
    .take(51);
  const queued = await ctx.db
    .query("automaticReplies")
    .withIndex("by_conversationId_and_status", (q) => q.eq("conversationId", source._id))
    .first();
  if (queued || messages.length > 50) return 0;
  const address = target.customerEmail;
  const sameCustomer = messages.every(
    (message) =>
      message.shopId === target.shopId &&
      (message.direction === "inbound"
        ? (shopifyContactAddress(message) ?? message.from.address) === address
        : [...message.to, ...message.cc].some((contact) => contact.address === address)),
  );
  if (!sameCustomer) return 0;

  for (const message of messages)
    await ctx.db.patch(message._id, { conversationId: target._id, updatedAt: now });
  if (source.lastMessageAt > target.lastMessageAt)
    await ctx.db.patch(target._id, { lastMessageAt: source.lastMessageAt, updatedAt: now });
  return messages.length;
}
