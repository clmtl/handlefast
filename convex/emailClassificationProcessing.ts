import { v } from "convex/values";
import { internal } from "./_generated/api";
import { env, internalAction } from "./_generated/server";
import { classifySupportEmail } from "./lib/emailClassificationModel";
import { type Classification, classificationFallback } from "./lib/emailClassificationPolicy";

export const process = internalAction({
  args: { receiptId: v.id("emailReceipts"), token: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const input = await ctx.runMutation(internal.emailClassification.claim, args);
    if (!input) return null;
    let classification: Classification = classificationFallback();
    if (input.empty)
      classification = classificationFallback(
        "Message vide ou pièces jointes seules : classement à vérifier.",
      );
    else if (input.tooLarge)
      classification = classificationFallback("Message trop long : classement à vérifier.");
    else if (env.OPENAI_API_KEY) {
      try {
        classification = await classifySupportEmail(
          ctx,
          env.OPENAI_API_KEY,
          input.prompt,
          args.receiptId,
          input.truncated,
        );
      } catch {
        console.warn("EmailClassificationUnavailable");
      }
    }
    await ctx.runMutation(internal.emailClassification.complete, { ...args, classification });
    return null;
  },
});
