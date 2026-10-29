import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { validMailbox } from "./automaticReplyPolicy";
import { orderName, orderReferences } from "./commerceModel";
import { DAY, type DeliveryReason, deliveryDeadline } from "./deliveryPolicy";

export async function ensureDeliveryPromise(ctx: MutationCtx, order: Doc<"shopifyOrders">) {
  const existing = await ctx.db
    .query("delayNotices")
    .withIndex("by_shopId_and_orderGid", (q) =>
      q.eq("shopId", order.shopId).eq("orderGid", order.gid),
    )
    .unique();
  if (existing) {
    if (existing.orderId !== order._id) await ctx.db.patch(existing._id, { orderId: order._id });
    return existing._id;
  }
  if (order.placedAt <= Date.now() - 365 * DAY) return null;
  const policy = await ctx.db
    .query("deliveryPolicies")
    .withIndex("by_shopId", (q) => q.eq("shopId", order.shopId))
    .unique();
  if (!policy) return null;
  const version = await ctx.db
    .query("deliveryPolicyVersions")
    .withIndex("by_shopId_and_effectiveAt", (q) =>
      q.eq("shopId", order.shopId).lte("effectiveAt", order.placedAt),
    )
    .order("desc")
    .first();
  const rules = version ?? policy;
  const promise = {
    maxDays: rules.maxDays,
    calendar: rules.calendar,
    timezone: rules.timezone,
    holidays: rules.holidays,
  };
  return ctx.db.insert("delayNotices", {
    shopId: order.shopId,
    orderId: order._id,
    orderGid: order.gid,
    orderName: order.name,
    email: order.email,
    placedAt: order.placedAt,
    promise,
    deadlineAt: deliveryDeadline(order.placedAt, promise),
    estimated: !version,
    expiresAt: order.placedAt + 365 * DAY,
    status: "none",
    reason: "not_due",
    attention: false,
    wasOverdue: false,
    evaluatedMode: "simulation",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    attempts: 0,
  });
}

async function customerContact(
  ctx: MutationCtx | QueryCtx,
  order: Doc<"shopifyOrders">,
): Promise<DeliveryReason | null> {
  // A forwarded envelope may hide the original sender until parsing. Pause while intake is incomplete.
  for (const status of ["uploading", "queued", "processing", "failed", "paused"] as const) {
    const pending = await ctx.db
      .query("emailReceipts")
      .withIndex("by_shopId_and_status_and_receivedAt", (q) =>
        q.eq("shopId", order.shopId).eq("status", status).gte("receivedAt", order.placedAt),
      )
      .order("desc")
      .first();
    if (pending && pending.expiresAt > Date.now()) return "pending_email";
  }
  const messages = await ctx.db
    .query("supportMessages")
    .withIndex("by_shopId_and_from_address_and_receivedAt", (q) =>
      q
        .eq("shopId", order.shopId)
        .eq("from.address", order.email ?? "")
        .gte("receivedAt", order.placedAt),
    )
    .order("desc")
    .take(51);
  if (messages.length > 50) return "ambiguous_contact";
  let ambiguous = false;
  for (const message of messages) {
    if (message.direction !== "inbound" || (message.expiresAt ?? 0) <= Date.now()) continue;
    const receipt = message.receiptId ? await ctx.db.get(message.receiptId) : null;
    if (receipt && ["other", "setup"].includes(receipt.triage?.bucket ?? "")) continue;
    const conversation = message.conversationId ? await ctx.db.get(message.conversationId) : null;
    if (conversation?.orderGid) {
      if (conversation.orderGid === order.gid) return "contacted";
      continue;
    }
    const receiptId = message.receiptId;
    const link = receiptId
      ? await ctx.db
          .query("orderLinks")
          .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
          .unique()
      : null;
    if (link?.orderId) {
      const linked = await ctx.db.get(link.orderId);
      if (linked?.shopId === order.shopId && linked.email === order.email) {
        if (linked.gid === order.gid) return "contacted";
        continue;
      }
    }
    const references = orderReferences(
      `${message.subject ?? ""}\n${message.text ?? message.snippet ?? ""}`,
    );
    if (references.includes(orderName(order.name))) return "contacted";
    // Explicit references to other orders are not a contact about this one; no reference remains ambiguous.
    if (!references.length || message.attachmentCount || (message.text?.length ?? 0) >= 12000)
      ambiguous = true;
    else {
      const others = await ctx.db
        .query("shopifyOrders")
        .withIndex("by_shopId_and_generation_and_email", (q) =>
          q.eq("shopId", order.shopId).eq("generation", order.generation).eq("email", order.email),
        )
        .take(26);
      if (
        others.length > 25 ||
        !references.every((ref) =>
          others.some((other) => other.gid !== order.gid && orderName(other.name) === ref),
        )
      )
        ambiguous = true;
    }
  }
  return ambiguous ? "ambiguous_contact" : null;
}

export async function inspectDelivery(
  ctx: MutationCtx | QueryCtx,
  notice: Doc<"delayNotices">,
  policy: Doc<"deliveryPolicies">,
) {
  const order = await ctx.db.get(notice.orderId),
    shop = await ctx.db.get(notice.shopId);
  let reason: DeliveryReason = "eligible";
  const connection = order ? await ctx.db.get(order.connectionId) : null;
  const route = await ctx.db
    .query("inboundEmailRoutes")
    .withIndex("by_shopId_and_status", (q) => q.eq("shopId", notice.shopId).eq("status", "active"))
    .first();
  if (
    !order ||
    order.shopId !== notice.shopId ||
    order.gid !== notice.orderGid ||
    connection?.shopId !== notice.shopId ||
    connection.status !== "active" ||
    connection.generation !== order.generation ||
    !shop ||
    shop.status === "disabled"
  )
    reason = "disconnected";
  else if (!route) reason = "reception";
  else if (notice.expiresAt <= Date.now()) reason = "expired";
  else if (order.cancelled) reason = "cancelled";
  else if (order.financialStatus === "REFUNDED") reason = "refunded";
  else if (order.financialStatus !== "PAID" || Number(order.refunded) !== 0) reason = "unpaid";
  else if (
    !order.email ||
    !validMailbox(order.email) ||
    order.email === route.address ||
    order.email === shop.supportEmail?.toLowerCase() ||
    /(?:no-?reply|mailer-daemon|postmaster)(?:[+._-][^@]*)?@/i.test(order.email)
  )
    reason = "recipient";
  else if (!connection.syncedAt || connection.syncedAt < Date.now() - DAY || connection.error)
    reason = "stale";
  const shipments = order
    ? await ctx.db
        .query("orderShipments")
        .withIndex("by_orderId", (q) => q.eq("orderId", order._id))
        .take(101)
    : [];
  const current = shipments.filter((s) => s.generation === order?.generation);
  if (reason === "eligible" && order) {
    if (
      order.detailsTruncated ||
      current.length > 100 ||
      !["UNFULFILLED", "PARTIALLY_FULFILLED", "FULFILLED"].includes(order.fulfillmentStatus)
    )
      reason = "tracking_issue";
    else if (
      current.some(
        (s) =>
          !s.registered ||
          ![
            "InfoReceived",
            "InTransit",
            "AvailableForPickup",
            "OutForDelivery",
            "Delivered",
          ].includes(s.status) ||
          s.error,
      ) ||
      (!current.length && order.fulfillmentStatus !== "UNFULFILLED")
    )
      reason = "tracking_issue";
    else if (
      current.some(
        (s) => !s.syncedAt || (s.status !== "Delivered" && s.syncedAt < Date.now() - 12 * 3600_000),
      )
    )
      reason = "stale";
    else if (
      order.fulfillmentStatus === "FULFILLED" &&
      current.length &&
      current.every((s) => s.status === "Delivered")
    )
      reason = "delivered";
    else if (Date.now() <= notice.deadlineAt) reason = "not_due";
    else reason = (await customerContact(ctx, order)) ?? "eligible";
  }
  const contextKey = JSON.stringify({
    order: order
      ? [
          order.gid,
          order.email,
          order.name,
          order.sourceUpdatedAt,
          order.generation,
          order.financialStatus,
          order.fulfillmentStatus,
          order.cancelled,
          order.refunded,
        ]
      : null,
    shipments: current.map((s) => [s._id, s.status, s.eventAt ?? null, s.error ?? null]),
    route: route?._id ?? null,
    deadline: notice.deadlineAt,
    locale: policy.locale,
    reason,
  });
  return { reason, contextKey, order, shop, route };
}
