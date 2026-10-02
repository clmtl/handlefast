import { afterEach, describe, expect, test, vi } from "vitest";
import { verifyWebhookSignature } from "../convex/lib/webhookSignatures";

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
  const body = "From: client@example.com\r\nMessage-ID: <worker-test@example.com>\r\n\r\nHello";
  const raw = new Response(body).body;
  if (!raw) throw new Error("Expected email body");
  return {
    from: "client@example.com",
    to: "shop@in.handlefast.io",
    headers: new Headers(),
    raw,
    rawSize: new TextEncoder().encode(body).byteLength,
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("email Worker delivery outcomes", () => {
  test.each([
    "received",
    "duplicate",
  ])("accepts %s and sends a valid signed payload", async (status) => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status }), { status: 202 }));
    vi.stubGlobal("fetch", request);
    const email = message();
    await worker.email(email, workerEnv);
    expect(email.setReject).not.toHaveBeenCalled();
    const [url, options] = request.mock.calls[0];
    expect(String(url)).toBe("https://example.convex.site/webhooks/cloudflare/email-routing");
    expect(
      await verifyWebhookSignature(
        new Headers(options.headers),
        options.body,
        workerEnv.CLOUDFLARE_EMAIL_WEBHOOK_SECRET,
      ),
    ).toEqual({ ok: true });
  });

  test("explicitly rejects an address that cannot receive mail", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ status: "unmatched" }), { status: 202 })),
    );
    const email = message();
    await worker.email(email, workerEnv);
    expect(email.setReject).toHaveBeenCalledWith("This HandleFast address is not accepting email.");
  });

  test.each([
    {},
    { status: "failed" },
    null,
  ])("does not acknowledge an invalid ingestion result: %j", async (result) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 202 })),
    );
    await expect(worker.email(message(), workerEnv)).rejects.toThrow();
  });

  test("propagates a backend outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 500 })));
    await expect(worker.email(message(), workerEnv)).rejects.toThrow(
      "Convex email ingestion failed: 500",
    );
  });

  test("rejects oversize messages before fetching", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const email = message();
    email.rawSize = 5 * 1024 * 1024 + 1;
    await worker.email(email, workerEnv);
    expect(email.setReject).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });
});
