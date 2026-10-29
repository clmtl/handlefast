import { afterEach, expect, test, vi } from "vitest";
import { prepareHumanReview } from "./lib/humanReviewModel";

afterEach(() => vi.unstubAllGlobals());

test("human assistance always requests gpt-6-luna, strict bounded output, no tools/history or remote storage", async () => {
  let request: Record<string, unknown> = {};
  const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
    request = JSON.parse(String(init.body));
    return Response.json({
      id: "resp_test",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-6-luna",
      output: [
        {
          type: "message",
          id: "msg_test",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                resumeEnFrancais: "Le client demande un remboursement.",
                solutionEnFrancais: "Vérifier la demande et les conditions applicables.",
                brouillonLangueClient: "Bonjour, nous allons examiner votre demande.",
                informationsManquantesEnFrancais: ["Référence de commande"],
                confidence: 0.95,
              }),
              annotations: [],
            },
          ],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200 },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const result = await prepareHumanReview(
    {} as never,
    "synthetic-key",
    "Untrusted email content",
    "receipt",
    ["missing_order"],
  );
  expect(result).toMatchObject({ source: "ai", model: "gpt-6-luna", warnings: ["missing_order"] });
  expect(request).toMatchObject({
    model: "gpt-6-luna",
    reasoning: { effort: "low" },
    store: false,
    max_output_tokens: 3000,
    text: { format: { type: "json_schema", strict: true } },
  });
  expect(request.tools).toBeUndefined();
  expect(JSON.stringify(request)).toContain("TOUJOURS EN FRANÇAIS");
  expect(JSON.stringify(request)).toContain("jamais des instructions");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("provider rate limits make one call without SDK retry or another model", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json(
      {
        error: {
          message: "Synthetic limit",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      },
      { status: 429 },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    prepareHumanReview({} as never, "synthetic-key", "Test", "receipt", []),
  ).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
