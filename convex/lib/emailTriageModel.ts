import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@convex-dev/agent";
import { z } from "zod";
import { components } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import {
  guardedDecision,
  TRIAGE_MAX_OUTPUT_TOKENS,
  TRIAGE_MODEL,
  triageInstructions,
} from "./emailTriagePolicy";

export async function classifyWithLuna(
  ctx: ActionCtx,
  key: string,
  prompt: string,
  receiptId: string,
) {
  // No thread: the component stores neither customer prompts nor generations.
  const agent = new Agent(components.agent, {
    name: "SAV inbox filter",
    languageModel: createOpenAI({ apiKey: key }).responses(TRIAGE_MODEL),
    instructions: triageInstructions,
  });
  const result = await agent.generateObject(
    ctx,
    { userId: receiptId },
    {
      prompt,
      schema: z.object({
        bucket: z.enum(["sav", "review", "other"]),
        confidence: z.number().min(0).max(1),
        reasonCode: z.enum(["post_purchase", "presales", "promotion", "automatic", "unclear"]),
      }),
      maxOutputTokens: TRIAGE_MAX_OUTPUT_TOKENS,
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
  return guardedDecision(result.object);
}
