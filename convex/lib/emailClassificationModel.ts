import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@convex-dev/agent";
import { z } from "zod";
import { components } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import {
  classificationInstructions,
  classificationReasons,
  guardClassification,
} from "./emailClassificationPolicy";
import { TRIAGE_MODEL } from "./emailTriagePolicy";

export async function classifySupportEmail(
  ctx: ActionCtx,
  key: string,
  prompt: string,
  receiptId: string,
  truncated: boolean,
) {
  const agent = new Agent(components.agent, {
    name: "SAV category and importance",
    languageModel: createOpenAI({ apiKey: key }).responses(TRIAGE_MODEL),
    instructions: classificationInstructions,
  });
  const result = await agent.generateObject(
    ctx,
    { userId: receiptId },
    {
      prompt,
      schema: z.object({
        category: z.enum([
          "order_status",
          "delivery_issue",
          "damaged_item",
          "wrong_or_missing_item",
          "return_exchange",
          "refund",
          "cancellation_change",
          "payment_issue",
          "warranty",
          "other",
        ]),
        priority: z.enum(["low", "normal", "high", "urgent"]),
        reasonCode: z.enum(
          Object.keys(classificationReasons) as [
            keyof typeof classificationReasons,
            ...(keyof typeof classificationReasons)[],
          ],
        ),
        confidence: z.number().min(0).max(1),
        needsReview: z.boolean(),
      }),
      maxOutputTokens: 1024,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(30_000),
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
  return guardClassification(result.object, truncated);
}
