import { v } from "convex/values";
import { internal } from "./_generated/api";
import { env, internalAction } from "./_generated/server";
import { planAutomaticReply } from "./lib/automaticReplyModel";
import { deliverEmail } from "./lib/emailTransport";

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
    const result = await deliverEmail(
      input.payload,
      env.RESEND_API_KEY ?? "",
      `handlefast-auto/${id}`,
    );
    if ("id" in result)
      await ctx.runMutation(internal.automaticReplies.sent, {
        id,
        token: input.token,
        providerId: result.id,
      });
    else
      await ctx.runMutation(internal.automaticReplies.sendFailed, {
        id,
        token: input.token,
        ...result,
      });
    return null;
  },
});
