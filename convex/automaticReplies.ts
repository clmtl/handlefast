import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { env, internalMutation, type MutationCtx, mutation, query } from "./_generated/server";
import { ensureHumanReview } from "./humanReviews";
import { requireShopMembership } from "./lib/authorization";
import {
  AUTO_REPLY_COOLDOWN,
  AUTO_REPLY_LEASE,
  AUTO_REPLY_WINDOW,
  activeAutoReply,
  autoReplyStatus,
  emailPayload,
  matchesRule,
  planValidator,
  renderAutomaticReply,
  suppressAutoResponse,
  validMailbox,
  validMessageId,
} from "./lib/automaticReplyPolicy";
import { orderReferences } from "./lib/commerceModel";
import { humanReviewContext } from "./lib/humanReviewContext";
import { cachedOrderContext } from "./orderContext";

async function inspect(ctx: MutationCtx, receipt: Doc<"emailReceipts">, revision: number) {
  if (
    receipt.status !== "processed" ||
    receipt.triage?.bucket !== "sav" ||
    receipt.expiresAt <= Date.now()
  )
    return { blocked: "email_unavailable" } as const;
  const shop = await ctx.db.get(receipt.shopId),
    route = await ctx.db.get(receipt.routeId);
  const settings = await ctx.db
    .query("shopSettings")
    .withIndex("by_shopId", (q) => q.eq("shopId", receipt.shopId))
    .unique();
  if (
    !settings?.autoReplyEnabled ||
    (settings.autoReplyRevision ?? 0) !== revision ||
    !receipt.autoReplyEligibility?.eligible ||
    receipt.autoReplyEligibility.revision !== revision
  )
    return { blocked: "policy_changed" } as const;
  if (
    !shop ||
    shop.status === "disabled" ||
    route?.status !== "active" ||
    route.shopId !== receipt.shopId
  )
    return { blocked: "reception_disabled" } as const;
  if (!env.RESEND_API_KEY || !env.OPENAI_API_KEY)
    return { blocked: "provider_unavailable" } as const;
  const classification = receipt.classification;
  if (
    classification?.source !== "ai" ||
    classification.needsReview ||
    !Number.isFinite(classification.confidence) ||
    (classification.confidence ?? 0) < 0.9 ||
    (classification.confidence ?? 0) > 1 ||
    !matchesRule(settings.autoReplyRules, classification)
  )
    return { blocked: "classification_or_rule" } as const;
  if (receipt.classificationJob) return { blocked: "classification_pending" } as const;
  if (
    receipt.humanReview &&
    (receipt.humanReview.editedDraft !== undefined ||
      receipt.humanReview.updatedBy ||
      receipt.humanReview.status !== "open")
  )
    return { blocked: "human_takeover" } as const;
  const message = await ctx.db
    .query("supportMessages")
    .withIndex("by_receiptId", (q) => q.eq("receiptId", receipt._id))
    .unique();
  if (
    !message?.conversationId ||
    !validMessageId(message.messageId) ||
    !validMailbox(message.from.address) ||
    receipt.automaticReplySuppressed ||
    suppressAutoResponse(message.headers)
  )
    return { blocked: "automatic_or_invalid_message" } as const;
  const sender = message.from.address.toLowerCase();
  if (
    sender === route.address ||
    sender === shop.supportEmail?.toLowerCase() ||
    /(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster)@/i.test(sender) ||
    message.replyTo.some((to) => to.address.toLowerCase() !== sender)
  )
    return { blocked: "unsafe_recipient" } as const;
  const latest = await ctx.db
    .query("supportMessages")
    .withIndex("by_conversationId_and_direction_and_receivedAt", (q) =>
      q.eq("conversationId", message.conversationId).eq("direction", "inbound"),
    )
    .order("desc")
    .first();
  if (latest?._id !== message._id) return { blocked: "newer_message" } as const;
  const context = await humanReviewContext(ctx, receipt);
  if (context.orderSyncedAt !== null && context.orderSyncedAt < Date.now() - 24 * 3600_000)
    return { blocked: "stale_order" } as const;
  if (
    context.empty ||
    context.tooLarge ||
    context.warnings.some((w) =>
      [
        "identity_mismatch",
        "truncated_input",
        "attachments_not_read",
        "classification_uncertain",
      ].includes(w),
    )
  )
    return { blocked: "incomplete_context" } as const;
  return { blocked: null, shop, route, settings, message, classification, context };
}

export async function routeSupportReply(
  ctx: MutationCtx,
  receiptId: Id<"emailReceipts">,
  initial = false,
): Promise<void> {
  let receipt = await ctx.db.get(receiptId);
  if (receipt?.triage?.bucket !== "sav" || receipt.expiresAt <= Date.now()) return;
  if (initial && !receipt.autoReplyEligibility) {
    const shopId = receipt.shopId;
    const settings = await ctx.db
      .query("shopSettings")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .unique();
    await ctx.db.patch(receiptId, {
      autoReplyEligibility: {
        revision: settings?.autoReplyRevision ?? 0,
        eligible: Boolean(
          settings?.autoReplyEnabled &&
            settings.autoReplyRules?.length &&
            settings.autoReplyActivatedAt &&
            receipt.receivedAt >= settings.autoReplyActivatedAt,
        ),
      },
    });
    receipt = await ctx.db.get(receiptId);
    if (!receipt) return;
  }
  const existing = await ctx.db
    .query("automaticReplies")
    .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
    .unique();
  if (existing) {
    if (!activeAutoReply.has(existing.status)) await ensureHumanReview(ctx, receiptId);
    return;
  }
  if (receipt.autoReplyEligibility?.eligible && !receipt.classificationJob) {
    const info = await inspect(ctx, receipt, receipt.autoReplyEligibility.revision);
    if (info.blocked === null) {
      const conversation = info.message.conversationId
        ? await ctx.db.get(info.message.conversationId)
        : null;
      if (
        conversation &&
        (conversation.autoReplyReservedAt ?? 0) <= Date.now() - AUTO_REPLY_COOLDOWN &&
        receipt.receivedAt + AUTO_REPLY_WINDOW > Date.now()
      ) {
        const id = await ctx.db.insert("automaticReplies", {
          receiptId,
          shopId: receipt.shopId,
          conversationId: conversation._id,
          status: "queued",
          replyToken: crypto.randomUUID(),
          revision: receipt.autoReplyEligibility.revision,
          createdAt: Date.now(),
          expiresAt: Math.min(receipt.expiresAt, receipt.receivedAt + AUTO_REPLY_WINDOW),
          nextAttemptAt: Date.now(),
          attempts: 0,
        });
        await ctx.db.patch(conversation._id, { autoReplyReservedAt: Date.now() });
        await ctx.db.patch(receiptId, { humanReview: undefined });
        await ctx.scheduler.runAfter(0, internal.automaticReplyProcessing.prepare, { id });
        return;
      }
    }
  }
  await ensureHumanReview(ctx, receiptId);
}

async function stop(ctx: MutationCtx, row: Doc<"automaticReplies">, reason: string) {
  if (row.status === "sent") return;
  await ctx.db.patch(row._id, {
    status: row.attempts > 0 ? "uncertain" : "cancelled",
    reason,
    token: undefined,
    nextAttemptAt: Date.now(),
  });
  await ensureHumanReview(ctx, row.receiptId);
}
export async function cancelAutomaticReply(ctx: MutationCtx, receiptId: Id<"emailReceipts">) {
  const row = await ctx.db
    .query("automaticReplies")
    .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
    .unique();
  if (row && activeAutoReply.has(row.status) && row.status !== "sent")
    await stop(ctx, row, "human_takeover");
}

export const cancel = mutation({
  args: { receiptId: v.id("emailReceipts") },
  returns: v.null(),
  handler: async (ctx, { receiptId }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt || receipt.expiresAt <= Date.now()) throw new ConvexError("EmailUnavailable");
    const { membership } = await requireShopMembership(ctx, receipt.shopId);
    if (membership.role === "viewer") throw new ConvexError("Forbidden");
    const row = await ctx.db
      .query("automaticReplies")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
      .unique();
    if (row?.status === "sending" || row?.status === "sent")
      throw new ConvexError("SendAlreadyStarted");
    if (row && activeAutoReply.has(row.status)) await stop(ctx, row, "human_takeover");
    return null;
  },
});

export const forEmail = query({
  args: { receiptId: v.id("emailReceipts") },
  returns: v.union(
    v.null(),
    v.object({
      status: autoReplyStatus,
      text: v.union(v.string(), v.null()),
      to: v.union(v.string(), v.null()),
      sentAt: v.union(v.number(), v.null()),
      reason: v.union(v.string(), v.null()),
      canCancel: v.boolean(),
    }),
  ),
  handler: async (ctx, { receiptId }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt || receipt.expiresAt <= Date.now()) return null;
    const { membership } = await requireShopMembership(ctx, receipt.shopId);
    const row = await ctx.db
      .query("automaticReplies")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
      .unique();
    if (!row) return null;
    return {
      status: row.status,
      text: row.payload?.text ?? null,
      to: row.payload?.to[0] ?? null,
      sentAt: row.sentAt ?? null,
      reason: row.reason ?? null,
      canCancel:
        membership.role !== "viewer" &&
        ["queued", "generating", "ready", "retrying"].includes(row.status),
    };
  },
});

export const claimPreparation = internalMutation({
  args: { id: v.id("automaticReplies") },
  returns: v.union(
    v.null(),
    v.object({
      token: v.string(),
      receiptId: v.id("emailReceipts"),
      prompt: v.string(),
      contextKey: v.string(),
    }),
  ),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (row?.status !== "queued") return null;
    const receipt = await ctx.db.get(row.receiptId);
    if (!receipt) return null;
    const info = await inspect(ctx, receipt, row.revision);
    if (info.blocked !== null || row.expiresAt <= Date.now()) {
      await stop(ctx, row, info.blocked ?? "expired");
      return null;
    }
    const token = crypto.randomUUID();
    await ctx.db.patch(id, {
      status: "generating",
      token,
      nextAttemptAt: Date.now() + AUTO_REPLY_LEASE,
    });
    return {
      token,
      receiptId: receipt._id,
      prompt: info.context.prompt,
      contextKey: info.context.contextKey,
    };
  },
});

export const prepared = internalMutation({
  args: {
    id: v.id("automaticReplies"),
    token: v.string(),
    contextKey: v.string(),
    plan: planValidator,
  },
  returns: v.null(),
  handler: async (ctx, { id, token, contextKey, plan }) => {
    const row = await ctx.db.get(id);
    if (row?.status !== "generating" || row.token !== token) return null;
    const receipt = await ctx.db.get(row.receiptId);
    if (!receipt) return null;
    const info = await inspect(ctx, receipt, row.revision);
    if (info.blocked !== null || row.expiresAt <= Date.now()) {
      await stop(ctx, row, info.blocked ?? "expired");
      return null;
    }
    if (info.context.contextKey !== contextKey) {
      await stop(ctx, row, "context_changed");
      return null;
    }
    const cached = await cachedOrderContext(ctx, receipt, info.message),
      order = cached?.identityMatches ? cached.selected : null;
    const preparing = Boolean(
      order && order.fulfillmentStatus === "UNFULFILLED" && !cached?.shipments.length,
    );
    if (
      plan.intent === "tracking" &&
      ((info.context.warnings.includes("stale_tracking") && !preparing) ||
        !order ||
        order.syncedAt < Date.now() - 24 * 3600_000 ||
        order.cancelled)
    ) {
      await stop(ctx, row, "tracking_unavailable");
      return null;
    }
    const text = renderAutomaticReply(plan, info.classification.category, {
      orderName: order?.name,
      statuses: cached?.shipments.filter((s) => s.active).map((s) => s.status) ?? [],
      preparing,
      missingOrder: !order,
      hasReference:
        orderReferences(`${info.message.subject ?? ""}\n${info.message.text ?? ""}`).length > 0,
      shopName: info.shop.name,
    });
    if (!text) {
      await stop(ctx, row, "human_required");
      return null;
    }
    const references = [...info.message.references, info.message.messageId]
      .filter(validMessageId)
      .slice(-20)
      .join(" ");
    if (!row.replyToken) {
      await stop(ctx, row, "invalid_reply_address");
      return null;
    }
    const replyAddress = `hf_reply_${row.replyToken}@${info.route.domain}`;
    const payload = {
      from: `HandleFast <${info.route.address}>`,
      to: [info.message.from.address],
      reply_to: replyAddress,
      subject: `Re: ${(info.message.subject ?? "Votre demande")
        .replace(/[\r\n]/g, " ")
        .replace(/^re:\s*/i, "")
        .slice(0, 450)}`,
      text,
      headers: {
        "In-Reply-To": info.message.messageId ?? "",
        References: references,
        "Auto-Submitted": "auto-replied",
        "X-Auto-Response-Suppress": "All",
        "X-HandleFast-Auto-Reply": "1",
      },
    };
    await ctx.db.patch(id, {
      status: "ready",
      plan,
      payload,
      contextKey,
      token: undefined,
      nextAttemptAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.automaticReplyProcessing.send, { id });
    return null;
  },
});

export const preparationFailed = internalMutation({
  args: { id: v.id("automaticReplies"), token: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, token }) => {
    const row = await ctx.db.get(id);
    if (row?.status === "generating" && row.token === token) {
      await ctx.db.patch(id, {
        status: "failed",
        reason: "generation_unavailable",
        token: undefined,
      });
      await ensureHumanReview(ctx, row.receiptId);
    }
    return null;
  },
});

export const claimSend = internalMutation({
  args: { id: v.id("automaticReplies") },
  returns: v.union(v.null(), v.object({ token: v.string(), payload: emailPayload })),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (
      !row ||
      !["ready", "retrying"].includes(row.status) ||
      row.nextAttemptAt > Date.now() ||
      !row.payload
    )
      return null;
    const receipt = await ctx.db.get(row.receiptId);
    if (!receipt) return null;
    const info = await inspect(ctx, receipt, row.revision);
    if (
      info.blocked !== null ||
      info.context.contextKey !== row.contextKey ||
      row.expiresAt <= Date.now() ||
      row.attempts >= 3
    ) {
      await stop(ctx, row, info.blocked ?? "context_or_deadline_changed");
      return null;
    }
    const token = crypto.randomUUID();
    await ctx.db.patch(id, {
      status: "sending",
      token,
      attempts: row.attempts + 1,
      firstAttemptAt: row.firstAttemptAt ?? Date.now(),
      nextAttemptAt: Date.now() + AUTO_REPLY_LEASE,
    });
    return { token, payload: row.payload };
  },
});

export const sent = internalMutation({
  args: { id: v.id("automaticReplies"), token: v.string(), providerId: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, token, providerId }) => {
    const row = await ctx.db.get(id);
    if (!row || row.status === "sent") return null;
    if (row.token !== token) return null;
    await ctx.db.patch(id, {
      status: "sent",
      providerId,
      sentAt: Date.now(),
      token: undefined,
      reason: undefined,
    });
    const receipt = await ctx.db.get(row.receiptId);
    if (receipt) await ctx.db.patch(receipt._id, { humanReview: undefined });
    const conversation = await ctx.db.get(row.conversationId);
    if (conversation)
      await ctx.db.patch(conversation._id, { status: "pending", updatedAt: Date.now() });
    return null;
  },
});

export const sendFailed = internalMutation({
  args: {
    id: v.id("automaticReplies"),
    token: v.string(),
    retryable: v.boolean(),
    definite: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, { id, token, retryable, definite }) => {
    const row = await ctx.db.get(id);
    if (row?.status !== "sending" || row.token !== token) return null;
    const retry = retryable && row.attempts < 3 && Date.now() + 60_000 < row.expiresAt;
    const uncertain = Boolean(row.acceptanceUncertain || !definite);
    const status = retry ? "retrying" : uncertain ? "uncertain" : "failed";
    await ctx.db.patch(id, {
      status,
      token: undefined,
      acceptanceUncertain: uncertain,
      reason: retry ? "provider_retry" : uncertain ? "delivery_unknown" : "provider_rejected",
      nextAttemptAt: Date.now() + 60_000,
    });
    if (retry) await ctx.scheduler.runAfter(60_000, internal.automaticReplyProcessing.send, { id });
    else await ensureHumanReview(ctx, row.receiptId);
    return null;
  },
});

export const recover = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const status of ["queued", "generating", "ready", "sending", "retrying"] as const) {
      const rows = await ctx.db
        .query("automaticReplies")
        .withIndex("by_status_and_nextAttemptAt", (q) =>
          q.eq("status", status).lte("nextAttemptAt", Date.now()),
        )
        .take(10);
      for (const row of rows) {
        if (row.expiresAt <= Date.now() || status === "generating") {
          await stop(ctx, row, "processing_interrupted");
          continue;
        }
        if (status === "sending")
          await ctx.db.patch(row._id, {
            status: "retrying",
            acceptanceUncertain: true,
            token: undefined,
            nextAttemptAt: Date.now(),
          });
        await ctx.scheduler.runAfter(
          0,
          status === "queued"
            ? internal.automaticReplyProcessing.prepare
            : internal.automaticReplyProcessing.send,
          { id: row._id },
        );
      }
    }
    return null;
  },
});
