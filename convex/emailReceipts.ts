import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  emailExpiresAt,
  MAX_EMAIL_BYTES,
  MAX_PROCESSING_ATTEMPTS,
  PROCESSING_LEASE_MS,
  RAW_EMAIL_CONTENT_TYPE,
} from "./lib/emailPolicy";
import { receiptDoc } from "./lib/emailReceiptValidators";
import { normalizeEmailAddress } from "./lib/inboundEmailRoutes";

export const reserve = internalMutation({
  args: {
    envelopeFrom: v.string(),
    envelopeTo: v.string(),
    sha256: v.string(),
    rawSize: v.number(),
  },
  returns: v.union(
    v.object({ status: v.literal("rejected") }),
    v.object({ status: v.literal("accepted"), receiptId: v.id("emailReceipts") }),
    v.object({
      status: v.literal("upload"),
      receiptId: v.id("emailReceipts"),
      uploadUrl: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.rawSize) ||
      args.rawSize < 1 ||
      args.rawSize > MAX_EMAIL_BYTES ||
      !/^[A-Za-z0-9+/]{43}=$/.test(args.sha256) ||
      args.envelopeFrom.length > 320 ||
      args.envelopeTo.length > 320
    ) {
      throw new ConvexError("InvalidEmailUpload");
    }
    const envelopeTo = normalizeEmailAddress(args.envelopeTo);
    const route = await ctx.db
      .query("inboundEmailRoutes")
      .withIndex("by_address", (q) => q.eq("address", envelopeTo))
      .unique();
    const shop = route ? await ctx.db.get(route.shopId) : null;
    if (route?.status !== "active" || !shop || shop.status === "disabled")
      return { status: "rejected" as const };
    const now = Date.now();
    const key = `${envelopeTo}:${args.sha256}`;
    const existing = await ctx.db
      .query("emailReceipts")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (existing) {
      if (existing.expiresAt <= now) return { status: "rejected" as const };
      if (existing.rawStorageId) return { status: "accepted" as const, receiptId: existing._id };
      return {
        status: "upload" as const,
        receiptId: existing._id,
        uploadUrl: await ctx.storage.generateUploadUrl(),
      };
    }
    const receiptId = await ctx.db.insert("emailReceipts", {
      ...args,
      envelopeTo,
      envelopeFrom: normalizeEmailAddress(args.envelopeFrom),
      key,
      shopId: shop._id,
      routeId: route._id,
      organizationId: shop.organizationId,
      status: "uploading",
      receivedAt: now,
      expiresAt: emailExpiresAt(now),
      attempts: 0,
      nextAttemptAt: now,
      updatedAt: now,
    });
    return {
      status: "upload" as const,
      receiptId,
      uploadUrl: await ctx.storage.generateUploadUrl(),
    };
  },
});

export const completeUpload = internalMutation({
  args: { receiptId: v.id("emailReceipts"), storageId: v.id("_storage") },
  returns: v.object({ status: v.literal("accepted") }),
  handler: async (ctx, { receiptId, storageId }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt || receipt.expiresAt <= Date.now()) throw new ConvexError("EmailUploadExpired");
    const file = await ctx.db.system.get(storageId);
    if (
      !file ||
      file.size !== receipt.rawSize ||
      file.sha256 !== receipt.sha256 ||
      file.contentType !== RAW_EMAIL_CONTENT_TYPE
    )
      throw new ConvexError("EmailUploadMismatch");
    const otherOwner = await ctx.db
      .query("emailReceipts")
      .withIndex("by_rawStorageId", (q) => q.eq("rawStorageId", storageId))
      .first();
    if (otherOwner && otherOwner._id !== receiptId) throw new ConvexError("EmailUploadAlreadyUsed");
    if (receipt.rawStorageId) {
      if (receipt.rawStorageId !== storageId) await ctx.storage.delete(storageId);
      return { status: "accepted" as const };
    }
    await ctx.db.patch(receiptId, {
      rawStorageId: storageId,
      status: "queued",
      nextAttemptAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.emailProcessing.process, { receiptId });
    await ctx.scheduler.runAt(receipt.expiresAt, internal.emailRetention.expireReceipt, {
      receiptId,
    });
    return { status: "accepted" as const };
  },
});

export const claim = internalMutation({
  args: { receiptId: v.id("emailReceipts") },
  returns: v.union(v.null(), receiptDoc),
  handler: async (ctx, { receiptId }) => {
    const receipt = await ctx.db.get(receiptId);
    const now = Date.now();
    if (
      !receipt?.rawStorageId ||
      receipt.expiresAt <= now ||
      receipt.status === "processed" ||
      receipt.status === "paused" ||
      receipt.nextAttemptAt > now ||
      receipt.attempts >= MAX_PROCESSING_ATTEMPTS
    )
      return null;
    const route = await ctx.db.get(receipt.routeId);
    const shop = await ctx.db.get(receipt.shopId);
    if (route?.status !== "active" || !shop || shop.status === "disabled") {
      await ctx.db.patch(receiptId, {
        status: "paused",
        error: "ReceptionDisabled",
        updatedAt: now,
      });
      return null;
    }
    await ctx.db.patch(receiptId, {
      status: "processing",
      attempts: receipt.attempts + 1,
      nextAttemptAt: now + PROCESSING_LEASE_MS,
      error: undefined,
      updatedAt: now,
    });
    return {
      ...receipt,
      attempts: receipt.attempts + 1,
      status: "processing" as const,
      nextAttemptAt: now + PROCESSING_LEASE_MS,
      updatedAt: now,
    };
  },
});

export const recordFailure = internalMutation({
  args: { receiptId: v.id("emailReceipts"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { receiptId, attempt }) => {
    const receipt = await ctx.db.get(receiptId);
    if (receipt?.status !== "processing" || receipt.attempts !== attempt) return null;
    const delay = Math.min(60 * 60 * 1000, 60_000 * 2 ** attempt);
    await ctx.db.patch(receiptId, {
      status: "failed",
      error: "ProcessingFailed",
      nextAttemptAt: attempt < MAX_PROCESSING_ATTEMPTS ? Date.now() + delay : receipt.expiresAt,
      updatedAt: Date.now(),
    });
    if (attempt < MAX_PROCESSING_ATTEMPTS)
      await ctx.scheduler.runAfter(delay, internal.emailProcessing.process, { receiptId });
    return null;
  },
});

export const recover = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const status of ["queued", "processing", "failed"] as const) {
      const due = await ctx.db
        .query("emailReceipts")
        .withIndex("by_status_and_nextAttemptAt", (q) =>
          q.eq("status", status).lte("nextAttemptAt", Date.now()),
        )
        .take(25);
      for (const receipt of due) {
        if (receipt.attempts < MAX_PROCESSING_ATTEMPTS && receipt.expiresAt > Date.now()) {
          await ctx.scheduler.runAfter(0, internal.emailProcessing.process, {
            receiptId: receipt._id,
          });
        } else if (receipt.status === "processing") {
          await ctx.db.patch(receipt._id, {
            status: "failed",
            error: "ProcessingFailed",
            nextAttemptAt: receipt.expiresAt,
            updatedAt: Date.now(),
          });
        }
      }
    }
    return null;
  },
});

export const getInternal = internalQuery({
  args: { receiptId: v.id("emailReceipts") },
  returns: v.union(v.null(), receiptDoc),
  handler: (ctx, { receiptId }) => ctx.db.get(receiptId),
});
