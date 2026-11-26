import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, mutation, query } from "./_generated/server";
import { cancelAutomaticReply, routeSupportReply } from "./automaticReplies";
import { requireShopMembership } from "./lib/authorization";
import {
  CLASSIFICATION_TIMEOUT_MS,
  CLASSIFICATION_VERSION,
  type Classification,
  categoryValidator,
  classificationFallback,
  classificationPrompt,
  classificationValidator,
  priorityValidator,
} from "./lib/emailClassificationPolicy";

// Scheduling is transactional with ingestion; no Shopify/17TRACK operation is involved.
export async function queueClassification(ctx: MutationCtx, receiptId: Id<"emailReceipts">) {
  const receipt = await ctx.db.get(receiptId);
  if (
    receipt?.triage?.bucket !== "sav" ||
    receipt.status !== "processed" ||
    receipt.expiresAt <= Date.now()
  )
    return;
  if (
    receipt.classificationJob &&
    receipt.classificationJob.requestedAt + CLASSIFICATION_TIMEOUT_MS > Date.now()
  )
    return;
  const token = crypto.randomUUID();
  await ctx.db.patch(receiptId, { classificationJob: { token, requestedAt: Date.now() } });
  await ctx.scheduler.runAfter(0, internal.emailClassificationProcessing.process, {
    receiptId,
    token,
  });
  await ctx.scheduler.runAfter(CLASSIFICATION_TIMEOUT_MS, internal.emailClassification.expireJob, {
    receiptId,
    token,
  });
}

async function editableReceipt(ctx: MutationCtx, receiptId: Id<"emailReceipts">) {
  const receipt = await ctx.db.get(receiptId);
  if (!receipt || receipt.expiresAt <= Date.now()) throw new ConvexError("EmailUnavailable");
  const auth = await requireShopMembership(ctx, receipt.shopId);
  if (auth.membership.role === "viewer") throw new ConvexError("Forbidden");
  if (receipt.status !== "processed" || receipt.triage?.bucket !== "sav")
    throw new ConvexError("NotSupportEmail");
  return { ...auth, receipt };
}

export const request = mutation({
  args: { receiptId: v.id("emailReceipts") },
  returns: v.null(),
  handler: async (ctx, { receiptId }) => {
    const { receipt } = await editableReceipt(ctx, receiptId);
    // A manual correction is authoritative until explicitly changed by a person.
    if (receipt.classification?.source !== "manual") await queueClassification(ctx, receiptId);
    return null;
  },
});

export const correct = mutation({
  args: {
    receiptId: v.id("emailReceipts"),
    category: categoryValidator,
    priority: priorityValidator,
  },
  returns: v.null(),
  handler: async (ctx, { receiptId, category, priority }) => {
    const { profile } = await editableReceipt(ctx, receiptId);
    await cancelAutomaticReply(ctx, receiptId);
    await ctx.db.patch(receiptId, {
      classification: {
        category,
        priority,
        reason: "Classement corrigé manuellement.",
        needsReview: false,
        source: "manual",
        version: CLASSIFICATION_VERSION,
      },
      classificationUpdatedAt: Date.now(),
      classificationUpdatedBy: profile._id,
    });
    await routeSupportReply(ctx, receiptId);
    return null;
  },
});

export const get = query({
  args: { receiptId: v.id("emailReceipts") },
  returns: v.union(
    v.null(),
    v.object({
      classification: v.union(classificationValidator, v.null()),
      pending: v.boolean(),
      canCorrect: v.boolean(),
    }),
  ),
  handler: async (ctx, { receiptId }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt || receipt.expiresAt <= Date.now()) return null;
    const { membership } = await requireShopMembership(ctx, receipt.shopId);
    if (receipt.triage?.bucket !== "sav" || receipt.status !== "processed") return null;
    return {
      classification: receipt.classification ?? null,
      pending: Boolean(receipt.classificationJob),
      canCorrect: membership.role !== "viewer",
    };
  },
});

export const claim = internalMutation({
  args: { receiptId: v.id("emailReceipts"), token: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      prompt: v.string(),
      empty: v.boolean(),
      truncated: v.boolean(),
      tooLarge: v.boolean(),
    }),
  ),
  handler: async (ctx, { receiptId, token }) => {
    const receipt = await ctx.db.get(receiptId);
    const job = receipt?.classificationJob;
    if (
      !receipt ||
      !job ||
      job.token !== token ||
      job.startedAt ||
      receipt.expiresAt <= Date.now() ||
      receipt.status !== "processed" ||
      receipt.triage?.bucket !== "sav" ||
      job.requestedAt + CLASSIFICATION_TIMEOUT_MS <= Date.now()
    )
      return null;
    const message = await ctx.db
      .query("supportMessages")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
      .unique();
    if (!message) return null;
    await ctx.db.patch(receiptId, { classificationJob: { ...job, startedAt: Date.now() } });
    let previous = "";
    for (const reference of [message.inReplyTo, ...[...message.references].reverse()]
      .filter((id): id is string => Boolean(id))
      .slice(0, 20)) {
      const earlier = await ctx.db
        .query("supportMessages")
        .withIndex("by_shopId_and_messageId", (q) =>
          q.eq("shopId", receipt.shopId).eq("messageId", reference),
        )
        .first();
      if (
        earlier &&
        earlier._id !== message._id &&
        earlier.from.address === message.from.address &&
        (earlier.expiresAt ?? 0) > Date.now()
      ) {
        previous = `${earlier.subject ?? ""}\n${earlier.text ?? earlier.snippet ?? ""}`.slice(
          0,
          1500,
        );
        break;
      }
    }
    return classificationPrompt(message, previous);
  },
});

async function saveAutomatic(
  ctx: MutationCtx,
  receipt: Doc<"emailReceipts">,
  value: Classification,
) {
  await ctx.db.patch(receipt._id, {
    classificationJob: undefined,
    automaticClassification: receipt.automaticClassification ?? value,
    ...(receipt.classification?.source === "manual"
      ? {}
      : {
          classification: value,
          classificationUpdatedAt: Date.now(),
          classificationUpdatedBy: undefined,
        }),
  });
  await routeSupportReply(ctx, receipt._id);
}

export const complete = internalMutation({
  args: {
    receiptId: v.id("emailReceipts"),
    token: v.string(),
    classification: classificationValidator,
  },
  returns: v.null(),
  handler: async (ctx, { receiptId, token, classification }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt || receipt.classificationJob?.token !== token) return null;
    if (receipt.expiresAt <= Date.now() || receipt.triage?.bucket !== "sav") {
      await ctx.db.patch(receiptId, { classificationJob: undefined });
      return null;
    }
    await saveAutomatic(ctx, receipt, classification);
    return null;
  },
});

export const expireJob = internalMutation({
  args: { receiptId: v.id("emailReceipts"), token: v.string() },
  returns: v.null(),
  handler: async (ctx, { receiptId, token }) => {
    const receipt = await ctx.db.get(receiptId);
    if (
      !receipt ||
      receipt.classificationJob?.token !== token ||
      receipt.classificationJob.requestedAt + CLASSIFICATION_TIMEOUT_MS > Date.now()
    )
      return null;
    if (receipt.expiresAt <= Date.now() || receipt.triage?.bucket !== "sav")
      await ctx.db.patch(receiptId, { classificationJob: undefined });
    else
      await saveAutomatic(
        ctx,
        receipt,
        classificationFallback("Analyse interrompue : classement à vérifier."),
      );
    return null;
  },
});
