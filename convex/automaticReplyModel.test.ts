import { afterEach, expect, test, vi } from "vitest";
import { planAutomaticReply } from "./lib/automaticReplyModel";

afterEach(() => vi.unstubAllGlobals());

test("automatic reply planning always requests gpt-6-luna, strict bounded output, no tools/history or remote storage", async () => {
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
                intent: "reference",
                language: "fr",
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
  const result = await planAutomaticReply(
    {} as never,
    "synthetic-key",
    "Untrusted email content",
    "receipt",
  );
  expect(result).toMatchObject({ intent: "reference", language: "fr", confidence: 0.95 });
  expect(request).toMatchObject({
    model: "gpt-6-luna",
    reasoning: { effort: "low" },
    store: false,
    max_output_tokens: 1024,
    text: { format: { type: "json_schema", strict: true } },
  });
  expect(request.tools).toBeUndefined();
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
    planAutomaticReply({} as never, "synthetic-key", "Test", "receipt"),
  ).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
