import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { cachedOrderContext } from "../orderContext";
import { matchesRule } from "./automaticReplyPolicy";
import { type ReviewWarning, replyBlockReason } from "./humanReviewPolicy";

export async function humanReviewContext(
  ctx: MutationCtx | QueryCtx,
  receipt: Doc<"emailReceipts">,
) {
  const message = await ctx.db
    .query("supportMessages")
    .withIndex("by_receiptId", (q) => q.eq("receiptId", receipt._id))
    .unique();
  const settings = await ctx.db
    .query("shopSettings")
    .withIndex("by_shopId", (q) => q.eq("shopId", receipt.shopId))
    .unique();
  const cached = message ? await cachedOrderContext(ctx, receipt, message) : null;
  const selected = cached?.identityMatches ? cached.selected : null;
  const usable = selected && selected.placedAt > Date.now() - 365 * 86_400_000 ? selected : null;
  const activeShipments = cached?.shipments.filter((shipment) => shipment.active) ?? [];
  const shipments = usable ? activeShipments.slice(0, 5) : [];
  const body = message?.text?.trim() || message?.html?.replace(/<[^>]*>/g, " ").trim() || "";
  const warnings: ReviewWarning[] = [];
  if (!usable)
    warnings.push(
      cached?.selected && !cached.identityMatches ? "identity_mismatch" : "missing_order",
    );
  if (!receipt.classification || receipt.classification.needsReview)
    warnings.push("classification_uncertain");
  if ((message?.attachmentCount ?? 0) > 0) warnings.push("attachments_not_read");
  if (
    body.length > 6000 ||
    (message?.subject?.length ?? 0) > 500 ||
    usable?.detailsTruncated ||
    activeShipments.length > 5
  )
    warnings.push("truncated_input");
  if (
    usable &&
    (!shipments.length ||
      shipments.some(
        (s) =>
          !s.syncedAt ||
          s.error ||
          (!["Delivered", "Returned"].includes(s.status) &&
            s.syncedAt < Date.now() - 12 * 3600_000),
      ))
  )
    warnings.push("stale_tracking");
  let previous = "";
  if (message)
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
  const automatic = await ctx.db
    .query("automaticReplies")
    .withIndex("by_receiptId", (q) => q.eq("receiptId", receipt._id))
    .unique();
  const reason =
    automatic && ["failed", "uncertain", "cancelled"].includes(automatic.status)
      ? ("automatic_unavailable" as const)
      : replyBlockReason(
          settings?.autoReplyEnabled ?? false,
          receipt.classification,
          matchesRule(settings?.autoReplyRules, receipt.classification),
        );
  // Capture only the chosen order, never broad candidates or private delivery addresses.
  const prompt = JSON.stringify({
    email: { subject: message?.subject?.slice(0, 500) ?? "", body: body.slice(0, 6000), previous },
    classification: receipt.classification
      ? {
          category: receipt.classification.category,
          priority: receipt.classification.priority,
          needsReview: receipt.classification.needsReview,
        }
      : null,
    cachedOrder: usable
      ? {
          name: usable.name,
          financialStatus: usable.financialStatus,
          fulfillmentStatus: usable.fulfillmentStatus,
          cancelled: usable.cancelled,
          total: usable.total,
          refunded: usable.refunded,
          currency: usable.currency,
          syncedAt: new Date(usable.syncedAt).toISOString(),
          items: usable.items
            .slice(0, 5)
            .map((item) => ({ title: item.title.slice(0, 200), quantity: item.quantity })),
          shipments: shipments.map((s) => ({
            status: s.status,
            syncedAt: s.syncedAt ?? null,
            lastEvent: s.events[0]?.description.slice(0, 300) ?? null,
          })),
        }
      : null,
    warnings,
  });
  const contextKey = JSON.stringify({
    classification: receipt.classification ?? null,
    classificationUpdatedAt: receipt.classificationUpdatedAt ?? null,
    reason,
    order: usable ? [usable._id, usable.sourceUpdatedAt, usable.generation] : null,
    // A changed/suppressed/manual association invalidates even an otherwise identical order.
    selected: cached?.selected?._id ?? null,
    mode: cached?.mode ?? null,
    identityMatches: cached?.identityMatches ?? null,
    shipments: shipments.map((s) => [
      s._id,
      s.status,
      s.eventAt ?? null,
      s.error ?? null,
      s.events[0]?.description ?? null,
    ]),
    warnings,
  });
  return {
    prompt,
    contextKey,
    reason,
    warnings,
    empty: !body,
    tooLarge: new TextEncoder().encode(prompt).length > 32_000,
    orderSyncedAt: usable?.syncedAt ?? null,
  };
}
