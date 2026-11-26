import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";

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
    for (const sent of page.page) {
      if (sent.direction !== "outbound" || !sent.conversationId || (sent.expiresAt ?? 0) <= now)
        continue;
      const before = await ctx.db
        .query("supportMessages")
        .withIndex("by_conversationId_and_direction_and_receivedAt", (q) =>
          q.eq("conversationId", sent.conversationId).eq("direction", "inbound"),
        )
        .first();
      if (before) continue;
      const conversation = await ctx.db.get(sent.conversationId);
      if (!conversation) continue;
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
      await ctx.db.patch(sent._id, { conversationId: target, updatedAt: now });
      if (sent.receivedAt > parent.lastMessageAt)
        await ctx.db.patch(target, { lastMessageAt: sent.receivedAt, updatedAt: now });
      changed++;
    }
    return { nextCursor: page.isDone ? null : page.continueCursor, changed };
  },
});
