"use node";

import { v } from "convex/values";
import { buildCloudflareEmailRoutingPayload } from "../src/lib/cloudflare-email-routing";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

export const process = internalAction({
  args: { receiptId: v.id("emailReceipts") },
  returns: v.null(),
  handler: async (ctx, { receiptId }): Promise<null> => {
    const receipt = await ctx.runMutation(internal.emailReceipts.claim, { receiptId });
    if (!receipt?.rawStorageId) return null;
    try {
      const raw = await ctx.storage.get(receipt.rawStorageId);
      if (!raw) throw new Error("MissingOriginalEmail");
      const payload = await buildCloudflareEmailRoutingPayload({
        from: receipt.envelopeFrom,
        to: receipt.envelopeTo,
        headers: new Headers(),
        raw: raw.stream(),
        rawSize: raw.size,
      });
      await ctx.runMutation(internal.inboundEmails.ingestFromWorker, {
        ...payload,
        deliveryKey: receipt.key,
        receivedAt: receipt.receivedAt,
        receiptId,
        processingAttempt: receipt.attempts,
      });
    } catch {
      // Keep the original for retry; do not put customer content in error logs.
      await ctx.runMutation(internal.emailReceipts.recordFailure, {
        receiptId,
        attempt: receipt.attempts,
      });
    }
    return null;
  },
});
