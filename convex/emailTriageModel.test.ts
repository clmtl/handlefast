import { afterEach, expect, test, vi } from "vitest";
import { classifyWithLuna } from "./lib/emailTriageModel";

afterEach(() => vi.unstubAllGlobals());

test("stateless Luna classification requests structured output, low reasoning and no remote persistence", async () => {
  let body: Record<string, unknown> = {};
  const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
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
                bucket: "sav",
                confidence: 0.99,
                reasonCode: "post_purchase",
              }),
              annotations: [],
            },
          ],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const result = await classifyWithLuna(
    {} as never,
    "synthetic-key",
    "My order arrived broken",
    "synthetic-receipt",
  );
  expect(result).toMatchObject({ bucket: "sav", model: "gpt-6-luna", source: "ai" });
  expect(body).toMatchObject({
    model: "gpt-6-luna",
    reasoning: { effort: "low" },
    store: false,
    max_output_tokens: 1024,
    text: { format: { type: "json_schema", strict: true } },
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("provider failures do not cause automatic SDK retries", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json(
      {
        error: {
          message: "Synthetic rate limit",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      },
      { status: 429 },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    classifyWithLuna({} as never, "synthetic-key", "Test", "synthetic-receipt"),
  ).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
