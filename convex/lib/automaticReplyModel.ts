import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@convex-dev/agent";
import { z } from "zod";
import { components } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { AUTO_REPLY_MODEL, plannerInstructions } from "./automaticReplyPolicy";

export async function planAutomaticReply(
  ctx: ActionCtx,
  key: string,
  prompt: string,
  receiptId: string,
) {
  const agent = new Agent(components.agent, {
    name: "Automatic SAV reply planner",
    instructions: plannerInstructions,
    languageModel: createOpenAI({ apiKey: key }).responses(AUTO_REPLY_MODEL),
  });
  const result = await agent.generateObject(
    ctx,
    { userId: receiptId },
    {
      prompt,
      schema: z.object({
        intent: z.enum(["tracking", "reference", "details", "resolved", "handoff"]),
        language: z.enum(["fr", "en", "es", "other"]),
        confidence: z.number().min(0).max(1),
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
  return result.object;
}
