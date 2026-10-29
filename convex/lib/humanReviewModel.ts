import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@convex-dev/agent";
import { z } from "zod";
import { components } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import {
  normalizeProposal,
  REVIEW_MODEL,
  type ReviewWarning,
  reviewInstructions,
} from "./humanReviewPolicy";

export async function prepareHumanReview(
  ctx: ActionCtx,
  key: string,
  prompt: string,
  receiptId: string,
  warnings: ReviewWarning[],
) {
  const agent = new Agent(components.agent, {
    name: "Human SAV assistance",
    languageModel: createOpenAI({ apiKey: key }).responses(REVIEW_MODEL),
    instructions: reviewInstructions,
  });
  const result = await agent.generateObject(
    ctx,
    { userId: receiptId },
    {
      prompt,
      schema: z.object({
        resumeEnFrancais: z
          .string()
          .max(800)
          .describe("Résumé factuel EN FRANÇAIS pour l’agent de la boutique."),
        solutionEnFrancais: z
          .string()
          .max(1600)
          .describe(
            "Proposition de traitement EN FRANÇAIS, sans action déjà effectuée ni promesse non vérifiée.",
          ),
        brouillonLangueClient: z
          .string()
          .max(4000)
          .describe("Brouillon à valider dans la langue du client ; vide si contexte insuffisant."),
        informationsManquantesEnFrancais: z.array(z.string().max(200)).max(8),
        confidence: z.number().min(0).max(1),
      }),
      maxOutputTokens: 3000,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(45_000),
      providerOptions: {
        openai: {
          forceReasoning: true,
          reasoningEffort: "low",
          store: false,
          serviceTier: "default",
        },
      },
    },
    {
      storageOptions: { saveMessages: "none" },
      contextOptions: {
        recentMessages: 0,
        searchOptions: { limit: 0, textSearch: false, vectorSearch: false },
      },
    },
  );
  return normalizeProposal(
    {
      summary: result.object.resumeEnFrancais,
      solution: result.object.solutionEnFrancais,
      draftReply: result.object.brouillonLangueClient,
      missingInformation: result.object.informationsManquantesEnFrancais,
      confidence: result.object.confidence,
    },
    warnings,
  );
}
