import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { env, internalMutation, type MutationCtx, mutation, query } from "./_generated/server";
import { assertCanManageOrganization, requireShopMembership } from "./lib/authorization";
import { emailPayload } from "./lib/automaticReplyPolicy";
import { ensureDeliveryPromise, inspectDelivery } from "./lib/deliveryContext";
import {
  DAY,
  delayEmail,
  deliveryConfig,
  deliveryMode,
  deliveryReason,
  NOTICE_LEASE,
  NOTICE_WINDOW,
  nextDeliveryRun,
  noticeStatus,
  validDeliveryConfig,
} from "./lib/deliveryPolicy";

async function startScan(ctx: MutationCtx, policy: Doc<"deliveryPolicies">, simulation: boolean) {
  if (policy.scanToken && (policy.scanStartedAt ?? 0) > Date.now() - 5 * 60_000) return;
  const token = crypto.randomUUID();
  await ctx.db.patch(policy._id, {
    scanToken: token,
    scanStartedAt: Date.now(),
    nextRunAt: Date.now() + 5 * 60_000,
  });
  await ctx.scheduler.runAfter(0, internal.deliveryMonitoring.scanPage, {
    shopId: policy.shopId,
    token,
    revision: policy.revision,
    simulation,
    cursor: null,
  });
}
export const get = query({
  args: { shopId: v.id("shops") },
  returns: v.object({
    config: v.union(
      v.null(),
      v.object({
        ...deliveryConfig,
        mode: deliveryMode,
        liveFrom: v.union(v.number(), v.null()),
        lastSimulationAt: v.union(v.number(), v.null()),
        lastScanAt: v.union(v.number(), v.null()),
        nextRunAt: v.number(),
        scanning: v.boolean(),
        previewReady: v.boolean(),
      }),
    ),
    canManage: v.boolean(),
    configured: v.boolean(),
  }),
  handler: async (ctx, { shopId }) => {
    const { membership } = await requireShopMembership(ctx, shopId);
    const p = await ctx.db
      .query("deliveryPolicies")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .unique();
    return {
      config: p
        ? {
            maxDays: p.maxDays,
            calendar: p.calendar,
            timezone: p.timezone,
            holidays: p.holidays,
            hour: p.hour,
            locale: p.locale,
            mode: p.mode,
            liveFrom: p.liveFrom ?? null,
            lastSimulationAt: p.lastSimulationAt ?? null,
            lastScanAt: p.lastScanAt ?? null,
            nextRunAt: p.nextRunAt,
            scanning: Boolean(p.scanToken),
            previewReady: Boolean(
              p.lastSimulationAt &&
                p.lastSimulationAt > Date.now() - DAY &&
                p.simulatedVersionId === p.versionId,
            ),
          }
        : null,
      canManage: ["owner", "admin"].includes(membership.role),
      configured: Boolean(env.RESEND_API_KEY),
    };
  },
});
export const save = mutation({
  args: { shopId: v.id("shops"), mode: deliveryMode, ...deliveryConfig },
  returns: v.null(),
  handler: async (ctx, { shopId, mode, ...config }) => {
    const { membership, profile, shop } = await requireShopMembership(ctx, shopId);
    assertCanManageOrganization(membership);
    config.holidays = [...config.holidays].sort();
    if (!validDeliveryConfig(config)) throw new ConvexError("InvalidDeliveryPolicy");
    const existing = await ctx.db
      .query("deliveryPolicies")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .unique();
    const same =
      existing &&
      Object.entries(config).every(
        ([key, value]) =>
          JSON.stringify(existing[key as keyof typeof config]) === JSON.stringify(value),
      );
    if (mode === "live") {
      const connection = await ctx.db
        .query("shopifyConnections")
        .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
        .unique();
      const route = await ctx.db
        .query("inboundEmailRoutes")
        .withIndex("by_shopId_and_status", (q) => q.eq("shopId", shopId).eq("status", "active"))
        .first();
      if (
        !env.RESEND_API_KEY ||
        shop.status === "disabled" ||
        connection?.status !== "active" ||
        !route
      )
        throw new ConvexError("DeliveryServiceUnavailable");
      if (
        !same ||
        !existing?.lastSimulationAt ||
        existing.lastSimulationAt < Date.now() - DAY ||
        existing.simulatedVersionId !== existing.versionId
      )
        throw new ConvexError("SimulateBeforeLive");
    }
    if (same && existing.mode === mode) return null;
    const versionId = same
      ? existing.versionId
      : await ctx.db.insert("deliveryPolicyVersions", {
          shopId,
          ...config,
          effectiveAt: Date.now(),
        });
    const values = {
      shopId,
      ...config,
      mode,
      versionId,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: Date.now(),
      updatedBy: profile._id,
      nextRunAt: nextDeliveryRun(Date.now(), config.timezone, config.hour),
      scanToken: undefined,
      scanStartedAt: undefined,
      liveFrom:
        mode === "live" ? (existing?.mode === "live" ? existing.liveFrom : Date.now()) : undefined,
    };
    const id = existing ? existing._id : await ctx.db.insert("deliveryPolicies", values);
    if (existing) await ctx.db.patch(id, values);
    const saved = await ctx.db.get(id);
    // Saving never sends a backlog: show a simulation first, including after a mode change.
    if (saved && mode !== "off") await startScan(ctx, saved, true);
    return null;
  },
});
export const simulate = mutation({
  args: { shopId: v.id("shops") },
  returns: v.null(),
  handler: async (ctx, { shopId }) => {
    const { membership } = await requireShopMembership(ctx, shopId);
    assertCanManageOrganization(membership);
    const policy = await ctx.db
      .query("deliveryPolicies")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .unique();
    if (!policy) throw new ConvexError("ConfigureDeliveryPolicyFirst");
    await startScan(ctx, policy, true);
    return null;
  },
});
export const list = query({
  args: { shopId: v.id("shops"), history: v.boolean(), paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(
      v.object({
        id: v.id("delayNotices"),
        orderName: v.string(),
        email: v.union(v.string(), v.null()),
        deadlineAt: v.number(),
        timezone: v.string(),
        estimated: v.boolean(),
        status: noticeStatus,
        reason: deliveryReason,
        simulation: v.boolean(),
        updatedAt: v.number(),
        sentAt: v.union(v.number(), v.null()),
        text: v.string(),
        canCancel: v.boolean(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { shopId, history, paginationOpts }) => {
    const { membership } = await requireShopMembership(ctx, shopId);
    const policy = await ctx.db
      .query("deliveryPolicies")
      .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
      .unique();
    const result = await (history
      ? ctx.db
          .query("delayNotices")
          .withIndex("by_shopId_and_wasOverdue_and_updatedAt", (q) =>
            q.eq("shopId", shopId).eq("wasOverdue", true),
          )
      : ctx.db
          .query("delayNotices")
          .withIndex("by_shopId_and_attention_and_updatedAt", (q) =>
            q.eq("shopId", shopId).eq("attention", true),
          )
    )
      .order("desc")
      .paginate({ ...paginationOpts, numItems: Math.min(25, paginationOpts.numItems) });
    const page = [];
    const shop = await ctx.db.get(shopId);
    for (const row of result.page) {
      if (row.expiresAt <= Date.now()) continue;
      page.push({
        id: row._id,
        orderName: row.orderName,
        email: (row.attempts > 0 ? row.payload?.to[0] : row.email) ?? null,
        deadlineAt: row.deadlineAt,
        timezone: row.promise.timezone,
        estimated: row.estimated,
        status: row.status,
        reason: row.reason,
        simulation: row.evaluatedMode === "simulation",
        updatedAt: row.updatedAt,
        sentAt: row.sentAt ?? null,
        text:
          row.payload?.text ??
          delayEmail(policy?.locale ?? "fr", row.orderName, shop?.name ?? "").text,
        canCancel: membership.role !== "viewer" && ["queued", "retrying"].includes(row.status),
      });
    }
    return { page, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

export const scanPage = internalMutation({
  args: {
    shopId: v.id("shops"),
    token: v.string(),
    revision: v.number(),
    simulation: v.boolean(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const policy = await ctx.db
      .query("deliveryPolicies")
      .withIndex("by_shopId", (q) => q.eq("shopId", args.shopId))
      .unique();
    if (!policy || policy.scanToken !== args.token || policy.revision !== args.revision)
      return null;
    const result = await ctx.db
      .query("shopifyOrders")
      .withIndex("by_shopId_and_placedAt", (q) =>
        q.eq("shopId", args.shopId).gt("placedAt", Date.now() - 365 * DAY),
      )
      .paginate({ numItems: 10, cursor: args.cursor });
    const simulation = args.simulation || policy.mode !== "live";
    for (const order of result.page) {
      const id = await ensureDeliveryPromise(ctx, order),
        row = id ? await ctx.db.get(id) : null;
      if (!row) continue;
      const info = await inspectDelivery(ctx, row, policy);
      const reason =
        !simulation && (row.estimated || row.placedAt < (policy.liveFrom ?? Infinity))
          ? "historical"
          : info.reason;
      const overdue = row.deadlineAt < Date.now();
      const attention =
        overdue &&
        row.status !== "sent" &&
        (["uncertain", "failed"].includes(row.status) ||
          !["delivered", "cancelled", "refunded", "historical", "expired"].includes(reason));
      await ctx.db.patch(row._id, {
        orderName: order.name,
        email: order.email,
        updatedAt: Date.now(),
        reason: row.attempts > 0 && reason === "eligible" ? row.reason : reason,
        attention,
        wasOverdue: row.wasOverdue || overdue,
        evaluatedMode: simulation ? "simulation" : "live",
      });
      if (
        !simulation &&
        reason === "eligible" &&
        !row.cancelledBy &&
        row.attempts === 0 &&
        ["none", "cancelled"].includes(row.status) &&
        info.route &&
        info.shop &&
        order.email
      ) {
        const replyToken = row.replyToken ?? crypto.randomUUID(),
          mail = delayEmail(policy.locale, order.name, info.shop.name);
        const conversationId =
          row.conversationId && (await ctx.db.get(row.conversationId))
            ? row.conversationId
            : await ctx.db.insert("supportConversations", {
                organizationId: info.shop.organizationId,
                shopId: row.shopId,
                routeId: info.route._id,
                customerEmail: order.email,
                orderGid: order.gid,
                subject: mail.subject,
                status: "pending",
                lastMessageAt: Date.now(),
                autoReplyReservedAt: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
        const payload = {
          from: `HandleFast <${info.route.address}>`,
          to: [order.email],
          reply_to: `hf_delay_${replyToken}@${info.route.domain}`,
          subject: mail.subject,
          text: mail.text,
          headers: {
            "Auto-Submitted": "auto-generated",
            "X-Auto-Response-Suppress": "All",
            "X-HandleFast-Auto-Reply": "1",
          },
        };
        await ctx.db.patch(row._id, {
          status: "queued",
          revision: policy.revision,
          replyToken,
          routeId: info.route._id,
          conversationId,
          payload,
          contextKey: info.contextKey,
          sendDeadline: Math.min(row.expiresAt, Date.now() + NOTICE_WINDOW),
          nextAttemptAt: Date.now(),
        });
        await ctx.scheduler.runAfter(0, internal.deliveryNotificationProcessing.send, {
          id: row._id,
        });
      }
    }
    if (!result.isDone) {
      await ctx.db.patch(policy._id, {
        scanStartedAt: Date.now(),
        nextRunAt: Date.now() + 5 * 60_000,
      });
      await ctx.scheduler.runAfter(0, internal.deliveryMonitoring.scanPage, {
        ...args,
        cursor: result.continueCursor,
      });
    } else
      await ctx.db.patch(policy._id, {
        scanToken: undefined,
        scanStartedAt: undefined,
        lastScanAt: Date.now(),
        nextRunAt: nextDeliveryRun(Date.now(), policy.timezone, policy.hour),
        ...(simulation
          ? { lastSimulationAt: Date.now(), simulatedVersionId: policy.versionId }
          : {}),
      });
    return null;
  },
});

async function stop(
  ctx: MutationCtx,
  row: Doc<"delayNotices">,
  reason: Doc<"delayNotices">["reason"],
) {
  await ctx.db.patch(row._id, {
    status: row.attempts > 0 ? "uncertain" : "cancelled",
    reason,
    attention: true,
    token: undefined,
    nextAttemptAt: undefined,
    updatedAt: Date.now(),
  });
}
export const cancel = mutation({
  args: { id: v.id("delayNotices") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row || row.expiresAt <= Date.now()) throw new ConvexError("NotificationUnavailable");
    const { membership, profile } = await requireShopMembership(ctx, row.shopId);
    if (membership.role === "viewer") throw new ConvexError("Forbidden");
    if (row.status === "sending" || row.status === "sent")
      throw new ConvexError("SendAlreadyStarted");
    if (["queued", "retrying"].includes(row.status)) {
      await stop(ctx, row, "human_takeover");
      await ctx.db.patch(id, { cancelledBy: profile._id });
    }
    return null;
  },
});
export const claimSend = internalMutation({
  args: { id: v.id("delayNotices") },
  returns: v.union(v.null(), v.object({ token: v.string(), payload: emailPayload })),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (
      !row ||
      !["queued", "retrying"].includes(row.status) ||
      (row.nextAttemptAt ?? Infinity) > Date.now() ||
      !row.payload
    )
      return null;
    const policy = await ctx.db
      .query("deliveryPolicies")
      .withIndex("by_shopId", (q) => q.eq("shopId", row.shopId))
      .unique();
    if (
      policy?.mode !== "live" ||
      policy.revision !== row.revision ||
      row.estimated ||
      row.placedAt < (policy.liveFrom ?? Infinity) ||
      row.cancelledBy
    ) {
      await stop(ctx, row, "policy_changed");
      return null;
    }
    if (
      !env.RESEND_API_KEY ||
      (row.sendDeadline ?? 0) <= Date.now() ||
      row.expiresAt <= Date.now() ||
      row.attempts >= 3
    ) {
      await stop(ctx, row, "expired");
      return null;
    }
    const info = await inspectDelivery(ctx, row, policy);
    if (info.reason !== "eligible" || info.contextKey !== row.contextKey) {
      await stop(ctx, row, info.reason !== "eligible" ? info.reason : "context_changed");
      return null;
    }
    const token = crypto.randomUUID();
    await ctx.db.patch(id, {
      status: "sending",
      token,
      attempts: row.attempts + 1,
      nextAttemptAt: Date.now() + NOTICE_LEASE,
      updatedAt: Date.now(),
    });
    return { token, payload: row.payload };
  },
});
export const sent = internalMutation({
  args: { id: v.id("delayNotices"), token: v.string(), providerId: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, token, providerId }) => {
    const row = await ctx.db.get(id);
    if (row?.status !== "sending" || row.token !== token) return null;
    await ctx.db.patch(id, {
      status: "sent",
      providerId,
      sentAt: Date.now(),
      attention: false,
      token: undefined,
      nextAttemptAt: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});
export const sendFailed = internalMutation({
  args: {
    id: v.id("delayNotices"),
    token: v.string(),
    retryable: v.boolean(),
    definite: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, { id, token, retryable, definite }) => {
    const row = await ctx.db.get(id);
    if (row?.status !== "sending" || row.token !== token) return null;
    const retry = retryable && row.attempts < 3 && Date.now() + 60_000 < (row.sendDeadline ?? 0),
      uncertain = Boolean(row.acceptanceUncertain || !definite);
    await ctx.db.patch(id, {
      status: retry ? "retrying" : uncertain ? "uncertain" : "failed",
      reason: retry ? "provider_retry" : uncertain ? "delivery_unknown" : "provider_rejected",
      attention: true,
      acceptanceUncertain: uncertain,
      token: undefined,
      nextAttemptAt: retry ? Date.now() + 60_000 : undefined,
      updatedAt: Date.now(),
    });
    if (retry)
      await ctx.scheduler.runAfter(60_000, internal.deliveryNotificationProcessing.send, { id });
    return null;
  },
});
export const recover = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const mode of ["simulation", "live"] as const) {
      const policies = await ctx.db
        .query("deliveryPolicies")
        .withIndex("by_mode_and_nextRunAt", (q) => q.eq("mode", mode).lte("nextRunAt", Date.now()))
        .take(10);
      for (const policy of policies) await startScan(ctx, policy, mode === "simulation");
    }
    for (const status of ["queued", "sending", "retrying"] as const) {
      const rows = await ctx.db
        .query("delayNotices")
        .withIndex("by_status_and_nextAttemptAt", (q) =>
          q.eq("status", status).lte("nextAttemptAt", Date.now()),
        )
        .take(10);
      for (const row of rows) {
        if ((row.sendDeadline ?? 0) <= Date.now()) {
          await stop(ctx, row, "expired");
          continue;
        }
        if (status === "sending")
          await ctx.db.patch(row._id, {
            status: "retrying",
            acceptanceUncertain: true,
            token: undefined,
            nextAttemptAt: Date.now(),
          });
        await ctx.scheduler.runAfter(0, internal.deliveryNotificationProcessing.send, {
          id: row._id,
        });
      }
    }
    const expired = await ctx.db
      .query("delayNotices")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now()))
      .take(25);
    for (const row of expired) {
      if (row.conversationId) {
        const message = await ctx.db
          .query("supportMessages")
          .withIndex("by_conversationId_and_receivedAt", (q) =>
            q.eq("conversationId", row.conversationId),
          )
          .first();
        if (!message && (await ctx.db.get(row.conversationId)))
          await ctx.db.delete(row.conversationId);
      }
      await ctx.db.delete(row._id);
    }
    return null;
  },
});
