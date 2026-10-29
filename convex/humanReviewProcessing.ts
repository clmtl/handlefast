import { v } from "convex/values";
import { internal } from "./_generated/api";
import { env, internalAction } from "./_generated/server";
import { prepareHumanReview } from "./lib/humanReviewModel";
import { type Proposal, reviewFallback } from "./lib/humanReviewPolicy";

export const process = internalAction({
  args: { receiptId: v.id("emailReceipts"), token: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const input = await ctx.runMutation(internal.humanReviews.claim, args);
    if (!input) return null;
    let proposal: Proposal = reviewFallback();
    if (input.empty)
      proposal = reviewFallback(
        "Email vide ou pièces jointes seules : lire l’original pour comprendre la demande.",
      );
    else if (input.tooLarge)
      proposal = reviewFallback(
        "Contenu trop volumineux : lire l’original pour traiter la demande.",
      );
    else if (env.OPENAI_API_KEY) {
      try {
        proposal = await prepareHumanReview(
          ctx,
          env.OPENAI_API_KEY,
          input.prompt,
          args.receiptId,
          input.warnings,
        );
      } catch {
        console.warn("HumanReviewUnavailable");
      }
    }
    if (proposal.source === "fallback") proposal = { ...proposal, warnings: input.warnings };
    await ctx.runMutation(internal.humanReviews.complete, {
      ...args,
      contextKey: input.contextKey,
      proposal,
    });
    return null;
  },
});
