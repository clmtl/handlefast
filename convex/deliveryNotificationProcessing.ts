import { v } from "convex/values";
import { internal } from "./_generated/api";
import { env, internalAction } from "./_generated/server";
import { deliverEmail } from "./lib/emailTransport";

export const send = internalAction({
  args: { id: v.id("delayNotices") },
  returns: v.null(),
  handler: async (ctx, { id }): Promise<null> => {
    const input = await ctx.runMutation(internal.deliveryMonitoring.claimSend, { id });
    if (!input) return null;
    const result = await deliverEmail(
      input.payload,
      env.RESEND_API_KEY ?? "",
      `handlefast-delay/${id}`,
    );
    if ("id" in result)
      await ctx.runMutation(internal.deliveryMonitoring.sent, {
        id,
        token: input.token,
        providerId: result.id,
      });
    else
      await ctx.runMutation(internal.deliveryMonitoring.sendFailed, {
        id,
        token: input.token,
        ...result,
      });
    return null;
  },
});
