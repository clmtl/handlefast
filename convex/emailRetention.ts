import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { emailExpiresAt, RAW_EMAIL_CONTENT_TYPE } from "./lib/emailPolicy";

async function removeMessage(ctx: MutationCtx, messageId: Id<"supportMessages">) {
  const message = await ctx.db.get(messageId);
  if (!message) return;
  const attachments = await ctx.db
    .query("emailAttachments")
    .withIndex("by_messageId", (q) => q.eq("messageId", messageId))
    .take(100);
  for (const attachment of attachments) {
    if (attachment.storageId) await ctx.storage.delete(attachment.storageId);
    await ctx.db.delete(attachment._id);
  }
  const remaining = await ctx.db
    .query("emailAttachments")
    .withIndex("by_messageId", (q) => q.eq("messageId", messageId))
    .first();
  if (remaining) return;
  await ctx.db.delete(messageId);
  await ctx.db.delete(message.deliveryId);
  if (!message.conversationId) return;
  const sibling = await ctx.db
    .query("supportMessages")
    .withIndex("by_conversationId_and_receivedAt", (q) =>
      q.eq("conversationId", message.conversationId),
    )
    .order("desc")
    .first();
  if (!sibling) await ctx.db.delete(message.conversationId);
  else
    await ctx.db.patch(message.conversationId, {
      subject: sibling.subject,
      customerEmail: sibling.from.address,
      lastMessageAt: sibling.receivedAt,
      updatedAt: Date.now(),
    });
}

export const expireReceipt = internalMutation({
  args: { receiptId: v.id("emailReceipts") },
  returns: v.null(),
  handler: async (ctx, { receiptId }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt || receipt.expiresAt > Date.now()) return null;
    const messages = await ctx.db
      .query("supportMessages")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
      .take(10);
    for (const message of messages) await removeMessage(ctx, message._id);
    const remaining = await ctx.db
      .query("supportMessages")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
      .first();
    if (remaining) {
      await ctx.scheduler.runAfter(0, internal.emailRetention.expireReceipt, { receiptId });
      return null;
    }
    const delivery = await ctx.db
      .query("inboundEmailDeliveries")
      .withIndex("by_deliveryKey", (q) => q.eq("deliveryKey", receipt.key))
      .unique();
    if (delivery) await ctx.db.delete(delivery._id);
    if (receipt.rawStorageId) await ctx.storage.delete(receipt.rawStorageId);
    const orderLink = await ctx.db
      .query("orderLinks")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
      .unique();
    if (orderLink) await ctx.db.delete(orderLink._id);
    await ctx.db.delete(receiptId);
    return null;
  },
});

export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const receipts = await ctx.db
      .query("emailReceipts")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(25);
    for (const receipt of receipts)
      await ctx.scheduler.runAfter(0, internal.emailRetention.expireReceipt, {
        receiptId: receipt._id,
      });
    // Also remove legacy messages, which predate durable receipts.
    const expired = await ctx.db
      .query("supportMessages")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(25);
    for (const message of expired) {
      if (!message.receiptId) {
        const expiresAt = message.expiresAt ?? emailExpiresAt(message._creationTime);
        if (expiresAt <= now) await removeMessage(ctx, message._id);
        else if (message.expiresAt === undefined) await ctx.db.patch(message._id, { expiresAt });
      }
    }
    const tests = await ctx.db
      .query("emailConnectionTests")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(100);
    for (const test of tests) await ctx.db.delete(test._id);
    // Old unmatched deliveries have no message; their sender metadata also expires.
    for (const status of ["unmatched", "failed"] as const) {
      const deliveries = await ctx.db
        .query("inboundEmailDeliveries")
        .withIndex("by_status_and_createdAt", (q) =>
          q.eq("status", status).lte("createdAt", now - 365 * 86400000),
        )
        .take(25);
      for (const delivery of deliveries)
        if (!delivery.receiptId && emailExpiresAt(delivery.createdAt) <= now)
          await ctx.db.delete(delivery._id);
    }
    if (receipts.length === 25 || expired.length === 25 || tests.length === 100)
      await ctx.scheduler.runAfter(1000, internal.emailRetention.sweep, {});
    return null;
  },
});

export const reconcileUploads = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const state = await ctx.db
      .query("emailMaintenance")
      .withIndex("by_key", (q) => q.eq("key", "storage-cursor"))
      .unique();
    const page = await ctx.db.system
      .query("_storage")
      .paginate({ numItems: 100, cursor: state?.cursor ?? null });
    for (const file of page.page) {
      // Only this subsystem uses this media type. Leave every other stored file alone.
      if (
        file.contentType !== RAW_EMAIL_CONTENT_TYPE ||
        file._creationTime > Date.now() - 2 * 60 * 60 * 1000
      )
        continue;
      const owner = await ctx.db
        .query("emailReceipts")
        .withIndex("by_rawStorageId", (q) => q.eq("rawStorageId", file._id))
        .first();
      if (owner) continue;
      const candidates = await ctx.db
        .query("emailReceipts")
        .withIndex("by_sha256_and_status", (q) =>
          q.eq("sha256", file.sha256).eq("status", "uploading"),
        )
        .take(25);
      const pending = candidates.find(
        (receipt) =>
          !receipt.rawStorageId && receipt.rawSize === file.size && receipt.expiresAt > Date.now(),
      );
      if (pending) {
        // The Worker may have crashed after upload but before the completion request.
        await ctx.db.patch(pending._id, {
          rawStorageId: file._id,
          status: "queued",
          updatedAt: Date.now(),
          nextAttemptAt: Date.now(),
        });
        await ctx.scheduler.runAfter(0, internal.emailProcessing.process, {
          receiptId: pending._id,
        });
        await ctx.scheduler.runAt(pending.expiresAt, internal.emailRetention.expireReceipt, {
          receiptId: pending._id,
        });
      } else {
        await ctx.storage.delete(file._id);
      }
    }
    const cursor = page.isDone ? null : page.continueCursor;
    if (state) await ctx.db.patch(state._id, { cursor });
    else await ctx.db.insert("emailMaintenance", { key: "storage-cursor", cursor });
    return null;
  },
});
