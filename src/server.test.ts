import { afterEach, describe, expect, test, vi } from "vitest";
import { verifyWebhookSignature } from "../convex/lib/webhookSignatures";
import { MAX_EMAIL_BYTES, RAW_EMAIL_CONTENT_TYPE } from "../convex/lib/emailPolicy";
vi.mock("@sentry/cloudflare", () => ({
  withSentry: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: vi.fn() } }));
import worker from "./server";
const workerEnv = {
  CONVEX_SITE_URL: "https://example.convex.site",
  CLOUDFLARE_EMAIL_WEBHOOK_SECRET: "worker-test-secret",
};
function message() {
  const body = "From: client@example.com\r\nMessage-ID: <test@example.com>\r\n\r\nHello";
  const raw = new Response(body).body;
  if (!raw) throw new Error("Expected body");
  return {
    from: "client@example.com",
    to: "shop@handlefast.io",
    headers: new Headers(),
    raw,
    rawSize: new TextEncoder().encode(body).byteLength,
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.unstubAllGlobals());
describe("durable Worker upload", () => {
  test("uploads the complete original and acknowledges only after commit", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          status: "upload",
          receiptId: "receipt",
          uploadUrl: "https://upload.example.invalid",
        }),
      )
      .mockResolvedValueOnce(json({ storageId: "file" }))
      .mockResolvedValueOnce(json({ status: "accepted" }));
    vi.stubGlobal("fetch", request);
    const email = message();
    await worker.email(email, workerEnv);
    expect(request).toHaveBeenCalledTimes(3);
    expect(email.setReject).not.toHaveBeenCalled();
    for (const index of [0, 2]) {
      const [, options] = request.mock.calls[index];
      expect(
        await verifyWebhookSignature(
          new Headers(options.headers),
          options.body,
          workerEnv.CLOUDFLARE_EMAIL_WEBHOOK_SECRET,
        ),
      ).toEqual({ ok: true });
    }
    const [, uploaded] = request.mock.calls[1];
    expect(uploaded.headers["Content-Type"]).toBe(RAW_EMAIL_CONTENT_TYPE);
    expect(new TextDecoder().decode(uploaded.body)).toContain("Hello");
    expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({
      operation: "complete",
      receiptId: "receipt",
      storageId: "file",
    });
  });
  test("deduplicates a previously stored original without re-uploading", async () => {
    const request = vi.fn().mockResolvedValue(json({ status: "accepted", receiptId: "receipt" }));
    vi.stubGlobal("fetch", request);
    await worker.email(message(), workerEnv);
    expect(request).toHaveBeenCalledTimes(1);
  });
  test("explicitly rejects an inactive address", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ status: "rejected" })));
    const email = message();
    await worker.email(email, workerEnv);
    expect(email.setReject).toHaveBeenCalledOnce();
  });
  test.each([
    {},
    null,
    { status: "failed" },
  ])("does not acknowledge invalid reservation %j", async (result) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(result)));
    await expect(worker.email(message(), workerEnv)).rejects.toThrow();
  });
  test.each([0, 1, 2])("propagates failures in upload step %i", async (failingStep) => {
    const responses = [
      json({ status: "upload", receiptId: "receipt", uploadUrl: "https://upload.example.invalid" }),
      json({ storageId: "file" }),
      json({ status: "accepted" }),
    ];
    responses[failingStep] = json({}, 500);
    const request = vi.fn();
    for (const response of responses) request.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", request);
    await expect(worker.email(message(), workerEnv)).rejects.toThrow();
  });
  test("rejects over 25 MiB before uploading", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const email = message();
    email.rawSize = MAX_EMAIL_BYTES + 1;
    await worker.email(email, workerEnv);
    expect(email.setReject).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });
});
