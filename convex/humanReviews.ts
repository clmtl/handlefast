import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, mutation, query } from "./_generated/server";
import { requireShopMembership } from "./lib/authorization";
import { activeAutoReply } from "./lib/automaticReplyPolicy";
import { categoryValidator, priorityValidator } from "./lib/emailClassificationPolicy";
import { humanReviewContext } from "./lib/humanReviewContext";
import {
  blockReason,
  humanReviewValidator,
  proposalValidator,
  REVIEW_TIMEOUT,
  reviewFallback,
  reviewStatus,
  warningValidator,
} from "./lib/humanReviewPolicy";

export async function ensureHumanReview(
  ctx: MutationCtx,
  receiptId: Id<"emailReceipts">,
  regenerate = false,
) {
  const receipt = await ctx.db.get(receiptId);
  if (
    receipt?.triage?.bucket !== "sav" ||
    receipt.status !== "processed" ||
    receipt.expiresAt <= Date.now()
  )
    return;
  const automatic = await ctx.db
    .query("automaticReplies")
    .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
    .unique();
  if (automatic && activeAutoReply.has(automatic.status)) return;
  const context = await humanReviewContext(ctx, receipt);
  const now = Date.now();
  let review = receipt.humanReview ?? {
    status: "open" as const,
    reason: context.reason,
    createdAt: now,
    updatedAt: now,
  };
  if (review.job && review.job.requestedAt + REVIEW_TIMEOUT > now) return;
  // Keep the alert visible while category/importance is prepared; its completion calls us again.
  if (!receipt.classificationJob && (!review.proposal || regenerate)) {
    const token = crypto.randomUUID();
    review = { ...review, reason: context.reason, job: { token, requestedAt: now } };
    await ctx.scheduler.runAfter(0, internal.humanReviewProcessing.process, { receiptId, token });
    await ctx.scheduler.runAfter(REVIEW_TIMEOUT, internal.humanReviews.expireJob, {
      receiptId,
      token,
    });
  }
  await ctx.db.patch(receiptId, { humanReview: review });
}

async function editableReview(ctx: MutationCtx, receiptId: Id<"emailReceipts">) {
  const receipt = await ctx.db.get(receiptId);
  if (!receipt || receipt.expiresAt <= Date.now()) throw new ConvexError("EmailUnavailable");
  const auth = await requireShopMembership(ctx, receipt.shopId);
  if (auth.membership.role === "viewer") throw new ConvexError("Forbidden");
  if (receipt.triage?.bucket !== "sav" || receipt.status !== "processed")
    throw new ConvexError("NotSupportEmail");
  const automatic = await ctx.db
    .query("automaticReplies")
    .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
    .unique();
  if (automatic && activeAutoReply.has(automatic.status))
    throw new ConvexError("AutomaticReplyActive");
  return { ...auth, receipt };
}

export const request = mutation({
  args: { receiptId: v.id("emailReceipts") },
  returns: v.null(),
  handler: async (ctx, { receiptId }) => {
    const { profile } = await editableReview(ctx, receiptId);
    await ensureHumanReview(ctx, receiptId, true);
    const receipt = await ctx.db.get(receiptId);
    if (receipt?.humanReview)
      await ctx.db.patch(receiptId, {
        humanReview: { ...receipt.humanReview, updatedBy: profile._id, updatedAt: Date.now() },
      });
    return null;
  },
});

export const setStatus = mutation({
  args: { receiptId: v.id("emailReceipts"), status: reviewStatus },
  returns: v.null(),
  handler: async (ctx, { receiptId, status }) => {
    const { receipt, profile } = await editableReview(ctx, receiptId);
    if (!receipt.humanReview) throw new ConvexError("ReviewUnavailable");
    await ctx.db.patch(receiptId, {
      humanReview: {
        ...receipt.humanReview,
        status,
        updatedAt: Date.now(),
        updatedBy: profile._id,
      },
    });
    return null;
  },
});

export const saveDraft = mutation({
  args: { receiptId: v.id("emailReceipts"), draft: v.string() },
  returns: v.null(),
  handler: async (ctx, { receiptId, draft }) => {
    const { receipt, profile } = await editableReview(ctx, receiptId);
    if (!receipt.humanReview) throw new ConvexError("ReviewUnavailable");
    if (draft.length > 6000) throw new ConvexError("DraftTooLong");
    await ctx.db.patch(receiptId, {
      humanReview: {
        ...receipt.humanReview,
        editedDraft: draft.trim(),
        draftUpdatedAt: Date.now(),
        draftUpdatedBy: profile._id,
      },
    });
    return null;
  },
});

export const get = query({
  args: { receiptId: v.id("emailReceipts") },
  returns: v.union(
    v.null(),
    v.object({
      review: v.union(humanReviewValidator, v.null()),
      canManage: v.boolean(),
      stale: v.boolean(),
      reason: blockReason,
    }),
  ),
  handler: async (ctx, { receiptId }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt || receipt.expiresAt <= Date.now()) return null;
    const { membership } = await requireShopMembership(ctx, receipt.shopId);
    if (receipt.triage?.bucket !== "sav" || receipt.status !== "processed") return null;
    const automatic = await ctx.db
      .query("automaticReplies")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
      .unique();
    if (automatic && activeAutoReply.has(automatic.status)) return null;
    const context = await humanReviewContext(ctx, receipt);
    return {
      review: receipt.humanReview ?? null,
      canManage: membership.role !== "viewer",
      stale: Boolean(
        receipt.humanReview?.proposal && receipt.humanReview.contextKey !== context.contextKey,
      ),
      reason: context.reason,
    };
  },
});

export const overview = query({
  args: { shopId: v.id("shops"), asOf: v.number() },
  returns: v.object({
    open: v.number(),
    inProgress: v.number(),
    openMore: v.boolean(),
    inProgressMore: v.boolean(),
  }),
  handler: async (ctx, { shopId, asOf }) => {
    await requireShopMembership(ctx, shopId);
    const now = Math.max(asOf, Date.now());
    const [open, progress] = await Promise.all(
      ["open", "in_progress"].map((status) =>
        ctx.db
          .query("emailReceipts")
          .withIndex("by_shop_bucket_reviewStatus_receivedAt", (q) =>
            q
              .eq("shopId", shopId)
              .eq("triage.bucket", "sav")
              .eq("humanReview.status", status as "open" | "in_progress"),
          )
          .order("desc")
          .take(51),
      ),
    );
    const countOpen = open.filter((r) => r.expiresAt > now).length,
      countProgress = progress.filter((r) => r.expiresAt > now).length;
    return {
      open: Math.min(50, countOpen),
      inProgress: Math.min(50, countProgress),
      openMore: countOpen > 50,
      inProgressMore: countProgress > 50,
    };
  },
});

export const list = query({
  args: {
    shopId: v.id("shops"),
    status: reviewStatus,
    asOf: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(
      v.object({
        receiptId: v.id("emailReceipts"),
        subject: v.string(),
        from: v.string(),
        receivedAt: v.number(),
        summary: v.union(v.string(), v.null()),
        pending: v.boolean(),
        category: v.union(categoryValidator, v.null()),
        priority: v.union(priorityValidator, v.null()),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { shopId, status, asOf, paginationOpts }) => {
    await requireShopMembership(ctx, shopId);
    const result = await ctx.db
      .query("emailReceipts")
      .withIndex("by_shop_bucket_reviewStatus_receivedAt", (q) =>
        q.eq("shopId", shopId).eq("triage.bucket", "sav").eq("humanReview.status", status),
      )
      .order("desc")
      .paginate({ ...paginationOpts, numItems: Math.min(50, paginationOpts.numItems) });
    const page = [];
    for (const receipt of result.page) {
      if (receipt.expiresAt <= Math.max(asOf, Date.now())) continue;
      const message = await ctx.db
        .query("supportMessages")
        .withIndex("by_receiptId", (q) => q.eq("receiptId", receipt._id))
        .unique();
      page.push({
        receiptId: receipt._id,
        subject: message?.subject ?? "(sans objet)",
        from: message?.from.address ?? receipt.envelopeFrom,
        receivedAt: receipt.receivedAt,
        summary: receipt.humanReview?.proposal?.summary ?? null,
        pending: Boolean(receipt.humanReview?.job || receipt.classificationJob),
        category: receipt.classification?.category ?? null,
        priority: receipt.classification?.priority ?? null,
      });
    }
    return { page, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

export const claim = internalMutation({
  args: { receiptId: v.id("emailReceipts"), token: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      prompt: v.string(),
      contextKey: v.string(),
      empty: v.boolean(),
      tooLarge: v.boolean(),
      warnings: v.array(warningValidator),
    }),
  ),
  handler: async (ctx, { receiptId, token }) => {
    const receipt = await ctx.db.get(receiptId),
      job = receipt?.humanReview?.job;
    if (
      !receipt ||
      !job ||
      job.token !== token ||
      job.startedAt ||
      job.requestedAt + REVIEW_TIMEOUT <= Date.now() ||
      receipt.triage?.bucket !== "sav" ||
      receipt.expiresAt <= Date.now()
    )
      return null;
    const context = await humanReviewContext(ctx, receipt);
    await ctx.db.patch(receiptId, {
      humanReview: {
        ...receipt.humanReview,
        status: receipt.humanReview?.status ?? "open",
        reason: context.reason,
        createdAt: receipt.humanReview?.createdAt ?? Date.now(),
        updatedAt: receipt.humanReview?.updatedAt ?? Date.now(),
        job: { ...job, startedAt: Date.now() },
      },
    });
    return {
      prompt: context.prompt,
      contextKey: context.contextKey,
      empty: context.empty,
      tooLarge: context.tooLarge,
      warnings: context.warnings,
    };
  },
});

async function saveProposal(
  ctx: MutationCtx,
  receipt: Doc<"emailReceipts">,
  proposal: InferProposal,
  contextKey: string,
) {
  const review = receipt.humanReview;
  if (!review) return;
  const { job: _, ...rest } = review;
  await ctx.db.patch(receipt._id, {
    humanReview: { ...rest, proposal, contextKey, generatedAt: Date.now() },
  });
}
type InferProposal = NonNullable<NonNullable<Doc<"emailReceipts">["humanReview"]>["proposal"]>;

export const complete = internalMutation({
  args: {
    receiptId: v.id("emailReceipts"),
    token: v.string(),
    contextKey: v.string(),
    proposal: proposalValidator,
  },
  returns: v.null(),
  handler: async (ctx, { receiptId, token, contextKey, proposal }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt || receipt.humanReview?.job?.token !== token) return null;
    if (receipt.triage?.bucket !== "sav" || receipt.expiresAt <= Date.now()) {
      await ctx.db.patch(receiptId, { humanReview: undefined });
      return null;
    }
    const context = await humanReviewContext(ctx, receipt);
    await saveProposal(
      ctx,
      receipt,
      context.contextKey === contextKey
        ? proposal
        : reviewFallback(
            "Le contexte a changé pendant la préparation. Régénérer la proposition avant de l’utiliser.",
          ),
      contextKey,
    );
    return null;
  },
});

export const expireJob = internalMutation({
  args: { receiptId: v.id("emailReceipts"), token: v.string() },
  returns: v.null(),
  handler: async (ctx, { receiptId, token }) => {
    const receipt = await ctx.db.get(receiptId),
      job = receipt?.humanReview?.job;
    if (!receipt || !job || job.token !== token || job.requestedAt + REVIEW_TIMEOUT > Date.now())
      return null;
    if (receipt.triage?.bucket !== "sav" || receipt.expiresAt <= Date.now())
      await ctx.db.patch(receiptId, { humanReview: undefined });
    else {
      const context = await humanReviewContext(ctx, receipt);
      await saveProposal(
        ctx,
        receipt,
        reviewFallback("Préparation interrompue : la demande reste à traiter manuellement."),
        context.contextKey,
      );
    }
    return null;
  },
});
