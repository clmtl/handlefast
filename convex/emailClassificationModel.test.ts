import { afterEach, expect, test, vi } from "vitest";
import { classifySupportEmail } from "./lib/emailClassificationModel";

afterEach(() => vi.unstubAllGlobals());

test("classification uses one stateless structured request with bounded output and no tools", async () => {
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
                category: "refund",
                priority: "normal",
                reasonCode: "refund_request",
                confidence: 0.97,
                needsReview: false,
              }),
              annotations: [],
            },
          ],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const value = await classifySupportEmail(
    {} as never,
    "synthetic-key",
    "Refund please",
    "test",
    false,
  );
  expect(value).toMatchObject({
    category: "refund",
    priority: "normal",
    source: "ai",
    needsReview: false,
    reason: "Le client demande un remboursement ou des nouvelles de son remboursement.",
  });
  expect(body).toMatchObject({
    model: "gpt-6-luna",
    reasoning: { effort: "low" },
    store: false,
    max_output_tokens: 1024,
    text: { format: { type: "json_schema", strict: true } },
  });
  expect(body.tools).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("provider errors do not retry or invoke other providers", async () => {
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
    classifySupportEmail({} as never, "synthetic-key", "Test", "test", false),
  ).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
