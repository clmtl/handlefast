import { v } from "convex/values";
import { internal } from "./_generated/api";
import { env, internalAction } from "./_generated/server";
import { planAutomaticReply } from "./lib/automaticReplyModel";

export const prepare = internalAction({
  args: { id: v.id("automaticReplies") },
  returns: v.null(),
  handler: async (ctx, { id }): Promise<null> => {
    const input = await ctx.runMutation(internal.automaticReplies.claimPreparation, { id });
    if (!input) return null;
    try {
      if (!env.OPENAI_API_KEY) throw new Error("ModelUnavailable");
      const plan = await planAutomaticReply(ctx, env.OPENAI_API_KEY, input.prompt, input.receiptId);
      await ctx.runMutation(internal.automaticReplies.prepared, {
        id,
        token: input.token,
        contextKey: input.contextKey,
        plan,
      });
    } catch {
      await ctx.runMutation(internal.automaticReplies.preparationFailed, {
        id,
        token: input.token,
      });
    }
    return null;
  },
});
export const send = internalAction({
  args: { id: v.id("automaticReplies") },
  returns: v.null(),
  handler: async (ctx, { id }): Promise<null> => {
    const input = await ctx.runMutation(internal.automaticReplies.claimSend, { id });
    if (!input) return null;
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `handlefast-auto/${id}`,
        },
        body: JSON.stringify(input.payload),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (response.ok) {
        const data = (await response.json()) as { id?: unknown };
        if (typeof data.id !== "string" || !data.id) throw new Error("InvalidProviderResponse");
        await ctx.runMutation(internal.automaticReplies.sent, {
          id,
          token: input.token,
          providerId: data.id,
        });
      } else {
        const error = (await response.json().catch(() => null)) as { name?: string } | null;
        const concurrent =
          response.status === 409 && error?.name === "concurrent_idempotent_requests";
        await ctx.runMutation(internal.automaticReplies.sendFailed, {
          id,
          token: input.token,
          retryable: response.status >= 500 || response.status === 429 || concurrent,
          definite: response.status < 500 && !concurrent,
        });
      }
    } catch {
      await ctx.runMutation(internal.automaticReplies.sendFailed, {
        id,
        token: input.token,
        retryable: true,
        definite: false,
      });
    }
    return null;
  },
});
