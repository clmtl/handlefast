"use node";

import { v } from "convex/values";
import { buildCloudflareEmailRoutingPayload } from "../src/lib/cloudflare-email-routing";
import { internal } from "./_generated/api";
import { env, internalAction } from "./_generated/server";
import { classifyWithLuna } from "./lib/emailTriageModel";
import {
  reviewDecision,
  TRIAGE_VERSION,
  type TriageDecision,
  triagePrompt,
} from "./lib/emailTriagePolicy";

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
      let triage: TriageDecision = receipt.triage ?? reviewDecision("unavailable");
      if (!receipt.triage) {
        const context = await ctx.runQuery(internal.emailTriage.context, {
          receiptId,
          now: Date.now(),
          subject: payload.subject ?? "",
          from: payload.from.address,
          to: payload.to.map((to) => to.address),
          references: [payload.inReplyTo, ...[...payload.references].reverse()].filter(
            (id): id is string => Boolean(id),
          ),
        });
        if (context.setup)
          triage = {
            bucket: "setup",
            reason: "connection",
            source: "rules",
            version: TRIAGE_VERSION,
          };
        else if (!payload.text?.trim() && !payload.html?.trim()) triage = reviewDecision("empty");
        else if (env.OPENAI_API_KEY) {
          const prompt = `${triagePrompt(payload)}\nPrevious message (untrusted context only): ${context.previous}`;
          if (new TextEncoder().encode(prompt).length > 24_000) triage = reviewDecision("too_long");
          else {
            try {
              triage = await classifyWithLuna(ctx, env.OPENAI_API_KEY, prompt, receiptId);
            } catch (error) {
              console.warn(
                "EmailTriageUnavailable",
                error instanceof Error ? error.name : "Unknown",
              );
              triage = reviewDecision("unavailable");
            }
            // Never discard content that was omitted from the bounded AI prompt.
            if (
              triage.bucket === "other" &&
              ((payload.text || payload.html || "").length > 5000 ||
                (payload.subject?.length ?? 0) > 500)
            )
              triage = reviewDecision("too_long");
          }
        }
      }
      await ctx.runMutation(internal.inboundEmails.ingestFromWorker, {
        ...payload,
        deliveryKey: receipt.key,
        receivedAt: receipt.receivedAt,
        receiptId,
        processingAttempt: receipt.attempts,
        triage,
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
