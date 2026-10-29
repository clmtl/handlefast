import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { cancelAutomaticReply, routeSupportReply } from "./automaticReplies";
import { queueClassification } from "./emailClassification";
import { getOrCreateConversationId } from "./inboundEmails";
import { requireShopMembership } from "./lib/authorization";
import {
  categoryValidator,
  classificationValidator,
  priorityValidator,
} from "./lib/emailClassificationPolicy";
import { TRIAGE_VERSION, triageBucket } from "./lib/emailTriagePolicy";

export const context = internalQuery({
  args: {
    receiptId: v.id("emailReceipts"),
    now: v.number(),
    subject: v.string(),
    from: v.string(),
    to: v.array(v.string()),
    references: v.array(v.string()),
  },
  returns: v.object({ setup: v.boolean(), previous: v.string() }),
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt) return { setup: false, previous: "" };
    const test = await ctx.db
      .query("emailConnectionTests")
      .withIndex("by_routeId", (q) => q.eq("routeId", receipt.routeId))
      .order("desc")
      .first();
    const setup =
      Boolean(
        test &&
          test.expiresAt > args.now &&
          args.subject.includes(String(test._id)) &&
          args.to.includes(test.supportEmail),
      ) ||
      (args.from.toLowerCase() === "forwarding-noreply@google.com" &&
        /forwarding confirmation/i.test(args.subject));
    for (const reference of args.references.slice(0, 20)) {
      const message = await ctx.db
        .query("supportMessages")
        .withIndex("by_shopId_and_messageId", (q) =>
          q.eq("shopId", receipt.shopId).eq("messageId", reference),
        )
        .first();
      if (
        message?.from.address === args.from.toLowerCase() &&
        message.expiresAt &&
        message.expiresAt > args.now
      ) {
        return {
          setup,
          previous: `${message.subject ?? ""}\n${message.text ?? message.snippet ?? ""}`.slice(
            0,
            1500,
          ),
        };
      }
    }
    return { setup, previous: "" };
  },
});

export const list = query({
  args: {
    shopId: v.id("shops"),
    bucket: triageBucket,
    category: v.optional(categoryValidator),
    priority: v.optional(priorityValidator),
    asOf: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(
      v.object({
        id: v.id("emailReceipts"),
        from: v.string(),
        subject: v.string(),
        snippet: v.string(),
        reason: v.string(),
        manual: v.boolean(),
        receivedAt: v.number(),
        classification: v.union(classificationValidator, v.null()),
        classificationPending: v.boolean(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { shopId, bucket, category, priority, asOf, paginationOpts }) => {
    await requireShopMembership(ctx, shopId);
    const receipts = ctx.db.query("emailReceipts");
    const filtered =
      category && priority
        ? receipts.withIndex("by_shop_bucket_category_priority_receivedAt", (q) =>
            q
              .eq("shopId", shopId)
              .eq("triage.bucket", bucket)
              .eq("classification.category", category)
              .eq("classification.priority", priority),
          )
        : category
          ? receipts.withIndex("by_shop_bucket_category_receivedAt", (q) =>
              q
                .eq("shopId", shopId)
                .eq("triage.bucket", bucket)
                .eq("classification.category", category),
            )
          : priority
            ? receipts.withIndex("by_shop_bucket_priority_receivedAt", (q) =>
                q
                  .eq("shopId", shopId)
                  .eq("triage.bucket", bucket)
                  .eq("classification.priority", priority),
              )
            : receipts.withIndex("by_shopId_and_triage_bucket_and_receivedAt", (q) =>
                q.eq("shopId", shopId).eq("triage.bucket", bucket),
              );
    const result = await filtered
      .order("desc")
      .paginate({ ...paginationOpts, numItems: Math.min(50, paginationOpts.numItems) });
    const page = [];
    for (const receipt of result.page) {
      if (receipt.expiresAt <= Math.max(asOf, Date.now())) continue;
      const message = await ctx.db
        .query("supportMessages")
        .withIndex("by_receiptId", (q) => q.eq("receiptId", receipt._id))
        .first();
      page.push({
        id: receipt._id,
        from: message?.from.address ?? receipt.envelopeFrom,
        subject: message?.subject ?? "(sans objet)",
        snippet: message?.snippet ?? "",
        reason: receipt.triage?.reason ?? "unclear",
        manual: receipt.triage?.source === "manual",
        receivedAt: receipt.receivedAt,
        classification: bucket === "sav" ? (receipt.classification ?? null) : null,
        classificationPending: bucket === "sav" && Boolean(receipt.classificationJob),
      });
    }
    return { page, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

export const permissions = query({
  args: { shopId: v.id("shops") },
  returns: v.object({ canCorrect: v.boolean() }),
  handler: async (ctx, { shopId }) => {
    const { membership } = await requireShopMembership(ctx, shopId);
    return { canCorrect: membership.role !== "viewer" };
  },
});

export const reclassify = mutation({
  args: {
    receiptId: v.id("emailReceipts"),
    bucket: v.union(v.literal("sav"), v.literal("review"), v.literal("other")),
  },
  returns: v.null(),
  handler: async (ctx, { receiptId, bucket }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt || receipt.expiresAt <= Date.now()) throw new ConvexError("EmailUnavailable");
    const { membership, profile } = await requireShopMembership(ctx, receipt.shopId);
    if (membership.role === "viewer") throw new ConvexError("Forbidden");
    if (receipt.status !== "processed" || !receipt.triage)
      throw new ConvexError("EmailNotClassified");
    if (receipt.triage.bucket === "setup") throw new ConvexError("ConnectionEmail");
    const message = await ctx.db
      .query("supportMessages")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
      .unique();
    const route = await ctx.db.get(receipt.routeId);
    if (!message || !route) throw new ConvexError("EmailUnavailable");
    const now = Date.now();
    await cancelAutomaticReply(ctx, receiptId);
    if (bucket === "sav" && !message.conversationId) {
      const conversationId = await getOrCreateConversationId(ctx, {
        route,
        replyAddress: receipt.envelopeTo,
        customerEmail: message.from.address,
        subject: message.subject ?? null,
        inReplyTo: message.inReplyTo ?? null,
        references: message.references,
        now,
        receivedAt: message.receivedAt,
      });
      await ctx.db.patch(message._id, { conversationId, updatedAt: now });
      const conversation = await ctx.db.get(conversationId);
      await ctx.db.patch(conversationId, {
        status: "open",
        lastMessageAt: Math.max(conversation?.lastMessageAt ?? 0, message.receivedAt),
        updatedAt: now,
      });
    } else if (bucket !== "sav" && message.conversationId) {
      const conversationId = message.conversationId;
      await ctx.db.patch(message._id, { conversationId: undefined, updatedAt: now });
      const remaining = await ctx.db
        .query("supportMessages")
        .withIndex("by_conversationId_and_receivedAt", (q) =>
          q.eq("conversationId", conversationId),
        )
        .order("desc")
        .first();
      if (!remaining) await ctx.db.delete(conversationId);
      else
        await ctx.db.patch(conversationId, {
          lastMessageAt: remaining.receivedAt,
          subject: remaining.subject,
          customerEmail: remaining.from.address,
          updatedAt: now,
        });
    }
    await ctx.db.patch(receiptId, {
      triage: { bucket, reason: "manual", source: "manual", version: TRIAGE_VERSION },
      triageUpdatedAt: now,
      triageUpdatedBy: profile._id,
    });
    if (bucket === "sav" && !receipt.classification) await queueClassification(ctx, receiptId);
    else if (bucket !== "sav" && receipt.classificationJob)
      await ctx.db.patch(receiptId, { classificationJob: undefined });
    if (bucket === "sav") await routeSupportReply(ctx, receiptId);
    else if (receipt.humanReview) await ctx.db.patch(receiptId, { humanReview: undefined });
    return null;
  },
});
