/// <reference types="vite/client" />

import betterAuthTest from "@convex-dev/better-auth/test";
import type { FunctionArgs, UserIdentity } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { emailExpiresAt, MAX_EMAIL_BYTES, RAW_EMAIL_CONTENT_TYPE } from "./lib/emailPolicy";
import { classifyWithLuna } from "./lib/emailTriageModel";
import { signWebhookBody } from "./lib/webhookSignatures";
import schema from "./schema";

// convex-test omits Blob.type in its storage mock (including 0.0.60).
// Restore the metadata that real Convex uploads persist; production code stays strict.
async function storeTestBlob(
  ctx: { storage: { store(blob: Blob): Promise<Id<"_storage">> }; db: unknown },
  blob: Blob,
) {
  const id = await ctx.storage.store(blob);
  const mockDb = ctx.db as unknown as {
    patch(id: Id<"_storage">, fields: { contentType: string }): Promise<void>;
  };
  await mockDb.patch(id, { contentType: blob.type });
  return id;
}

vi.mock("./lib/emailTriageModel", () => ({
  classifyWithLuna: vi.fn(async () => ({
    bucket: "sav",
    reason: "post_purchase",
    source: "ai",
    version: 1,
  })),
}));

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const issuer = "https://handlefast-test.convex.site";
type InboundWorkerPayload = FunctionArgs<typeof internal.inboundEmails.ingestFromWorker>;

function createTestBackend() {
  const t = convexTest({ schema, modules });
  betterAuthTest.register(t);
  return t;
}

async function createAuthenticatedClient(t: ReturnType<typeof createTestBackend>, seed: string) {
  const now = Date.now();
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: `User ${seed}`,
        email: `${seed}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  })) as { _id: string; email: string; name: string };

  const session = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        token: `session-${seed}`,
        userId: user._id,
        expiresAt: now + 60 * 60 * 1000,
        createdAt: now,
        updatedAt: now,
      },
    },
  })) as { _id: string };

  const tokenIdentifier = `${issuer}|${user._id}`;
  const identity = {
    issuer,
    subject: user._id,
    tokenIdentifier,
    sessionId: session._id,
    email: user.email,
    name: user.name,
  } as Partial<UserIdentity> & { sessionId: string };

  return {
    authUserId: user._id,
    client: t.withIdentity(identity),
    tokenIdentifier,
  };
}

async function createWorkspace(t: ReturnType<typeof createTestBackend>, seed: string) {
  const auth = await createAuthenticatedClient(t, seed);
  const result = await auth.client.mutation(api.onboarding.bootstrap, {
    organizationName: `${seed} Organization`,
    shopName: `${seed} Shop`,
  });

  if (!result.shopId) {
    throw new Error("Expected workspace bootstrap to include a shop id");
  }

  return {
    ...auth,
    ...result,
    shopId: result.shopId,
  };
}

function inboundPayload(
  routeAddress: string,
  overrides: Partial<InboundWorkerPayload> = {},
): InboundWorkerPayload {
  const receivedAt = Date.parse("2026-06-28T12:00:00.000Z");
  return {
    provider: "cloudflare_email_routing" as const,
    deliveryKey: `cloudflare_email_routing:${routeAddress}:message-1`,
    envelopeFrom: "customer@example.com",
    envelopeTo: routeAddress,
    from: { address: "customer@example.com", name: "Customer" },
    to: [{ address: routeAddress }],
    cc: [],
    replyTo: [],
    subject: "Where is my order?",
    text: "Hello, I need help with my order.",
    html: "<p>Hello, I need help with my order.</p>",
    snippet: "Hello, I need help with my order.",
    headers: [
      { name: "message-id", value: "<message-1@example.com>" },
      { name: "subject", value: "Where is my order?" },
    ],
    messageId: "<message-1@example.com>",
    references: [],
    attachments: [],
    receivedAt,
    rawSize: 2048,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(classifyWithLuna).mockResolvedValue({
    bucket: "sav",
    reason: "post_purchase",
    source: "ai",
    version: 1,
  });
  vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const rawMime = [
  "From: Client <client@example.com>",
  "To: support@example.com",
  "Subject: Photo of my order",
  "Message-ID: <storage-test@example.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="test-boundary"',
  "",
  "--test-boundary",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "My order arrived damaged.",
  "--test-boundary",
  'Content-Type: text/plain; name="proof.txt"',
  'Content-Disposition: attachment; filename="proof.txt"',
  "Content-Transfer-Encoding: base64",
  "",
  "aGVsbG8=",
  "--test-boundary--",
  "",
].join("\r\n");

async function prepare(raw = rawMime, t = createTestBackend(), seed = "storage") {
  const workspace = await createWorkspace(t, seed);
  const route = await workspace.client.query(api.inboundEmailRoutes.getForShop, {
    shopId: workspace.shopId,
  });
  if (!route) throw new Error("Expected route");
  const blob = new Blob([raw], { type: RAW_EMAIL_CONTENT_TYPE });
  const sha256 = btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())),
    ),
  );
  const input = {
    envelopeFrom: "client@example.com",
    envelopeTo: route.address,
    sha256,
    rawSize: blob.size,
  };
  const reservation = await t.mutation(internal.emailReceipts.reserve, input);
  if (reservation.status !== "upload") throw new Error("Expected upload reservation");
  const storageId = await t.run((ctx) => storeTestBlob(ctx, blob));
  return { t, workspace, route, input, receiptId: reservation.receiptId, storageId, blob };
}

async function complete(f: Awaited<ReturnType<typeof prepare>>) {
  await f.t.mutation(internal.emailReceipts.completeUpload, {
    receiptId: f.receiptId,
    storageId: f.storageId,
  });
  await f.t.action(internal.emailProcessing.process, { receiptId: f.receiptId });
}

describe("durable email storage", () => {
  test("retention also deletes classified non-SAV content without a conversation", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const f = await prepare();
    await complete(f);
    await f.t.run((ctx) => ctx.db.patch(f.receiptId, { expiresAt: Date.now() - 1 }));
    await f.t.mutation(internal.emailRetention.expireReceipt, { receiptId: f.receiptId });
    expect(await f.t.run((ctx) => ctx.db.get(f.receiptId))).toBeNull();
    expect(await f.t.run((ctx) => ctx.db.query("supportMessages").first())).toBeNull();
    expect(await f.t.run((ctx) => ctx.db.query("emailAttachments").first())).toBeNull();
    expect(await f.t.run((ctx) => ctx.storage.get(f.storageId))).toBeNull();
  });
  test("AI failure preserves the original and routes to review without creating a SAV conversation", async () => {
    vi.mocked(classifyWithLuna).mockRejectedValueOnce(new Error("Synthetic provider failure"));
    const f = await prepare();
    await complete(f);
    expect(await f.t.run((ctx) => ctx.db.get(f.receiptId))).toMatchObject({
      status: "processed",
      rawStorageId: f.storageId,
      triage: { bucket: "review", reason: "unavailable" },
    });
    expect(await f.t.run((ctx) => ctx.db.query("supportConversations").first())).toBeNull();
  });

  test("budget exhaustion keeps incoming mail in review without calling the model", async () => {
    vi.stubEnv("EMAIL_TRIAGE_MONTHLY_BUDGET_USD", "0");
    vi.mocked(classifyWithLuna).mockClear();
    const f = await prepare();
    await complete(f);
    expect(await f.t.run((ctx) => ctx.db.get(f.receiptId))).toMatchObject({
      status: "processed",
      triage: { bucket: "review", reason: "budget" },
    });
    expect(classifyWithLuna).not.toHaveBeenCalled();
  });

  test("missing provider credentials leave received mail available for review", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const f = await prepare();
    await complete(f);
    expect(await f.t.run((ctx) => ctx.db.get(f.receiptId))).toMatchObject({
      status: "processed",
      triage: { bucket: "review", reason: "unavailable" },
    });
  });
  test("uses receipt time for a conversation first processed after an outage", async () => {
    const f = await prepare();
    const receivedAt = Date.now();
    vi.setSystemTime(receivedAt + 60 * 60 * 1000);
    await complete(f);
    const conversation = await f.t.run((ctx) => ctx.db.query("supportConversations").first());
    expect(conversation?.lastMessageAt).toBe(receivedAt);
  });

  test("preserves the entire MIME original and attachment bytes before processing", async () => {
    const f = await prepare();
    await complete(f);
    const receipt = await f.t.query(internal.emailReceipts.getInternal, { receiptId: f.receiptId });
    expect(receipt?.status).toBe("processed");
    expect(receipt?.expiresAt).toBe(Date.parse("2027-10-02T12:00:00Z"));
    expect(await f.t.run(async (ctx) => (await ctx.storage.get(f.storageId))?.text())).toBe(
      rawMime,
    );
    const list = await f.workspace.client.query(api.emailInbox.recent, {
      shopId: f.workspace.shopId,
    });
    expect(list).toMatchObject([
      { subject: "Photo of my order", hasOriginal: true, status: "processed" },
    ]);
    const attachments = await f.t.run((ctx) => ctx.db.query("emailAttachments").take(10));
    expect(attachments).toMatchObject([{ filename: "proof.txt", size: 5 }]);
    expect(
      await f.workspace.client.action(api.emailInbox.download, { receiptId: f.receiptId }),
    ).toBeTypeOf("string");
  });

  test("deduplicates retries and deletes a redundant raw upload", async () => {
    const f = await prepare();
    await complete(f);
    const duplicate = await f.t.mutation(internal.emailReceipts.reserve, f.input);
    expect(duplicate).toEqual({ status: "accepted", receiptId: f.receiptId });
    const duplicateFile = await f.t.run((ctx) => storeTestBlob(ctx, f.blob));
    await f.t.mutation(internal.emailReceipts.completeUpload, {
      receiptId: f.receiptId,
      storageId: duplicateFile,
    });
    expect(await f.t.run((ctx) => ctx.db.system.get(duplicateFile))).toBeNull();
    expect(await f.t.run((ctx) => ctx.db.query("supportMessages").take(10))).toHaveLength(1);
  });

  test("verifies content hash, size and media type before accepting an upload", async () => {
    const f = await prepare();
    const wrong = await f.t.run((ctx) =>
      storeTestBlob(ctx, new Blob(["wrong"], { type: RAW_EMAIL_CONTENT_TYPE })),
    );
    await expect(
      f.t.mutation(internal.emailReceipts.completeUpload, {
        receiptId: f.receiptId,
        storageId: wrong,
      }),
    ).rejects.toThrow("EmailUploadMismatch");
    expect(
      (await f.t.query(internal.emailReceipts.getInternal, { receiptId: f.receiptId }))?.status,
    ).toBe("uploading");
  });

  test("rejects the right bytes with the wrong media type", async () => {
    const f = await prepare();
    const wrongType = await f.t.run((ctx) =>
      storeTestBlob(ctx, new Blob([rawMime], { type: "text/plain" })),
    );
    await expect(
      f.t.mutation(internal.emailReceipts.completeUpload, {
        receiptId: f.receiptId,
        storageId: wrongType,
      }),
    ).rejects.toThrow("EmailUploadMismatch");
  });

  test("recovers an expired processing lease and rejects a stale worker", async () => {
    const f = await prepare();
    await f.t.mutation(internal.emailReceipts.completeUpload, {
      receiptId: f.receiptId,
      storageId: f.storageId,
    });
    const first = await f.t.mutation(internal.emailReceipts.claim, { receiptId: f.receiptId });
    expect(first?.attempts).toBe(1);
    expect(await f.t.mutation(internal.emailReceipts.claim, { receiptId: f.receiptId })).toBeNull();
    if (!first) throw new Error("Missing claim");
    vi.setSystemTime(first.nextAttemptAt);
    await f.t.mutation(internal.emailReceipts.recover, {});
    const second = await f.t.mutation(internal.emailReceipts.claim, { receiptId: f.receiptId });
    expect(second?.attempts).toBe(2);
    await expect(
      f.t.mutation(
        internal.inboundEmails.ingestFromWorker,
        inboundPayload(f.route.address, {
          deliveryKey: first.key,
          receiptId: f.receiptId,
          processingAttempt: 1,
        }),
      ),
    ).rejects.toThrow("StaleEmailProcessing");
    await f.t.mutation(internal.emailReceipts.recordFailure, {
      receiptId: f.receiptId,
      attempt: 1,
    });
    expect(
      (await f.t.query(internal.emailReceipts.getInternal, { receiptId: f.receiptId }))?.status,
    ).toBe("processing");
    await f.t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(f.route.address, {
        deliveryKey: first.key,
        receiptId: f.receiptId,
        processingAttempt: 2,
      }),
    );
    expect(
      (await f.t.query(internal.emailReceipts.getInternal, { receiptId: f.receiptId }))?.status,
    ).toBe("processed");
  });

  test("enforces the 25 MiB boundary on reservation", async () => {
    const f = await prepare();
    await expect(
      f.t.mutation(internal.emailReceipts.reserve, { ...f.input, rawSize: MAX_EMAIL_BYTES + 1 }),
    ).rejects.toThrow("InvalidEmailUpload");
    await expect(
      f.t.mutation(internal.emailReceipts.reserve, { ...f.input, rawSize: MAX_EMAIL_BYTES }),
    ).resolves.toMatchObject({ status: "upload" });
  });

  test("refuses unknown and disabled recipients before storing anything", async () => {
    const f = await prepare();
    expect(
      await f.t.mutation(internal.emailReceipts.reserve, {
        ...f.input,
        envelopeTo: "unknown@handlefast.io",
      }),
    ).toEqual({ status: "rejected" });
    await f.workspace.client.mutation(api.emailInbox.setEnabled, {
      shopId: f.workspace.shopId,
      enabled: false,
    });
    expect(await f.t.mutation(internal.emailReceipts.reserve, f.input)).toEqual({
      status: "rejected",
    });
    await f.t.mutation(internal.emailReceipts.completeUpload, {
      receiptId: f.receiptId,
      storageId: f.storageId,
    });
    await f.t.action(internal.emailProcessing.process, { receiptId: f.receiptId });
    expect(
      (await f.t.query(internal.emailReceipts.getInternal, { receiptId: f.receiptId }))?.status,
    ).toBe("paused");
    await f.workspace.client.mutation(api.emailInbox.setEnabled, {
      shopId: f.workspace.shopId,
      enabled: true,
    });
    await f.workspace.client.mutation(api.emailInbox.retry, { receiptId: f.receiptId });
    await f.t.action(internal.emailProcessing.process, { receiptId: f.receiptId });
    expect(
      (await f.t.query(internal.emailReceipts.getInternal, { receiptId: f.receiptId }))?.status,
    ).toBe("processed");
  });

  test("retains malformed originals and limits automatic retries", async () => {
    const f = await prepare(`Subject: ${"x".repeat(140_000)}\r\n\r\nbody`);
    await complete(f);
    let receipt = await f.t.query(internal.emailReceipts.getInternal, { receiptId: f.receiptId });
    expect(receipt?.status).toBe("failed");
    for (let index = 1; index < 5; index++) {
      if (!receipt) throw new Error("Missing receipt");
      vi.setSystemTime(receipt.nextAttemptAt);
      await f.t.action(internal.emailProcessing.process, { receiptId: f.receiptId });
      receipt = await f.t.query(internal.emailReceipts.getInternal, { receiptId: f.receiptId });
    }
    expect(receipt?.attempts).toBe(5);
    expect(receipt?.nextAttemptAt).toBe(receipt?.expiresAt);
    expect(await f.t.run((ctx) => ctx.db.system.get(f.storageId))).not.toBeNull();
    await f.workspace.client.mutation(api.emailInbox.retry, { receiptId: f.receiptId });
    expect(
      (await f.t.query(internal.emailReceipts.getInternal, { receiptId: f.receiptId }))?.attempts,
    ).toBe(0);
  });

  test("recovers a stored original if the completion request was lost", async () => {
    const f = await prepare();
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000 + 1);
    await f.t.mutation(internal.emailRetention.reconcileUploads, {});
    expect(
      (await f.t.query(internal.emailReceipts.getInternal, { receiptId: f.receiptId }))
        ?.rawStorageId,
    ).toBe(f.storageId);
    await f.t.action(internal.emailProcessing.process, { receiptId: f.receiptId });
    expect(
      (await f.t.query(internal.emailReceipts.getInternal, { receiptId: f.receiptId }))?.status,
    ).toBe("processed");
  });

  test("cleans orphan email uploads but leaves unrelated storage alone", async () => {
    const t = createTestBackend();
    const orphan = await t.run((ctx) =>
      storeTestBlob(ctx, new Blob(["orphan"], { type: RAW_EMAIL_CONTENT_TYPE })),
    );
    const unrelated = await t.run((ctx) =>
      storeTestBlob(ctx, new Blob(["keep"], { type: "text/plain" })),
    );
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000 + 1);
    await t.mutation(internal.emailRetention.reconcileUploads, {});
    expect(await t.run((ctx) => ctx.db.system.get(orphan))).toBeNull();
    expect(await t.run((ctx) => ctx.db.system.get(unrelated))).not.toBeNull();
  });

  test("deletes the original, messages, attachments, delivery and empty conversation after 12 months", async () => {
    const f = await prepare();
    await complete(f);
    vi.setSystemTime(emailExpiresAt(Date.now()));
    await f.t.mutation(internal.emailRetention.expireReceipt, { receiptId: f.receiptId });
    expect(await f.t.run((ctx) => ctx.db.system.get(f.storageId))).toBeNull();
    for (const table of [
      "emailReceipts",
      "supportMessages",
      "emailAttachments",
      "supportConversations",
      "inboundEmailDeliveries",
    ] as const) {
      expect(await f.t.run((ctx) => ctx.db.query(table).take(5))).toEqual([]);
    }
  });

  test("keeps a newer reply while removing expired conversation content", async () => {
    const f = await prepare();
    await complete(f);
    const newer = await f.t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(f.route.address, {
        deliveryKey: "newer-reply",
        messageId: "<newer@example.com>",
        inReplyTo: "<storage-test@example.com>",
        subject: "A newer subject",
      }),
    );
    if (newer.status !== "received") throw new Error("Expected reply");
    await f.t.run((ctx) =>
      ctx.db.patch(newer.supportMessageId, { expiresAt: emailExpiresAt(Date.now()) + 86400000 }),
    );
    vi.setSystemTime(emailExpiresAt(Date.now()));
    await f.t.mutation(internal.emailRetention.expireReceipt, { receiptId: f.receiptId });
    expect(await f.t.run((ctx) => ctx.db.query("supportMessages").take(5))).toHaveLength(1);
    expect(await f.t.run((ctx) => ctx.db.get(newer.conversationId))).toMatchObject({
      subject: "A newer subject",
    });
  });

  test("clamps leap-day retention to twelve calendar months", () => {
    expect(emailExpiresAt(Date.parse("2024-02-29T12:00:00Z"))).toBe(
      Date.parse("2025-02-28T12:00:00Z"),
    );
  });

  test("retention keeps the most recently received reply even when an older reply was processed later", async () => {
    const f = await prepare();
    const start = Date.now();
    await complete(f);
    vi.setSystemTime(start + 2 * 86400000);
    const newest = await f.t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(f.route.address, {
        deliveryKey: "newest-received",
        messageId: "<newest@example.com>",
        inReplyTo: "<storage-test@example.com>",
        subject: "Most recently received",
      }),
    );
    vi.setSystemTime(start + 3 * 86400000);
    const delayed = await f.t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(f.route.address, {
        deliveryKey: "delayed-reply",
        messageId: "<delayed@example.com>",
        inReplyTo: "<storage-test@example.com>",
        subject: "Older reply processed later",
      }),
    );
    if (newest.status !== "received" || delayed.status !== "received")
      throw new Error("Expected replies");
    await f.t.run((ctx) =>
      ctx.db.patch(delayed.supportMessageId, {
        receivedAt: start + 86400000,
        expiresAt: emailExpiresAt(start + 86400000),
      }),
    );
    vi.setSystemTime(emailExpiresAt(start));
    await f.t.mutation(internal.emailRetention.expireReceipt, { receiptId: f.receiptId });
    expect(await f.t.run((ctx) => ctx.db.get(newest.conversationId))).toMatchObject({
      subject: "Most recently received",
      lastMessageAt: start + 2 * 86400000,
    });
  });

  test("stops reading an oversized webhook stream without Content-Length", async () => {
    vi.stubEnv("SITE_URL", "http://localhost:3000");
    const t = createTestBackend();
    let chunksRead = 0;
    const cancel = vi.fn();
    const body = new ReadableStream(
      {
        pull(controller) {
          chunksRead += 1;
          controller.enqueue(new Uint8Array(8192));
          if (chunksRead === 20) controller.close();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
    const response = await t.fetch("/webhooks/cloudflare/email-routing", init);
    expect(response.status).toBe(413);
    expect(chunksRead).toBeLessThan(20);
    expect(cancel).toHaveBeenCalledOnce();
  });

  test("forbids cross-shop reads, downloads, retries and connection changes", async () => {
    const f = await prepare();
    await complete(f);
    const other = await createWorkspace(f.t, "other");
    await expect(
      other.client.query(api.emailInbox.recent, { shopId: f.workspace.shopId }),
    ).rejects.toThrow("Forbidden");
    await expect(
      other.client.action(api.emailInbox.download, { receiptId: f.receiptId }),
    ).rejects.toThrow("Forbidden");
    await expect(
      other.client.mutation(api.emailInbox.retry, { receiptId: f.receiptId }),
    ).rejects.toThrow("Forbidden");
    await expect(
      other.client.mutation(api.emailInbox.setEnabled, {
        shopId: f.workspace.shopId,
        enabled: false,
      }),
    ).rejects.toThrow("Forbidden");
  });

  test("verifies forwarding only for the challenge sent to the configured support address", async () => {
    const f = await prepare();
    const subject = await f.workspace.client.mutation(api.emailInbox.beginTest, {
      shopId: f.workspace.shopId,
      supportEmail: "support@example.com",
    });
    await f.t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(f.route.address, { subject }),
    );
    expect(
      (await f.workspace.client.query(api.emailInbox.connection, { shopId: f.workspace.shopId }))
        .verified,
    ).toBe(false);
    await f.t.mutation(
      internal.inboundEmails.ingestFromWorker,
      inboundPayload(f.route.address, {
        subject,
        deliveryKey: "correct-test",
        messageId: "<correct@example.com>",
        to: [{ address: "support@example.com" }],
      }),
    );
    expect(
      (await f.workspace.client.query(api.emailInbox.connection, { shopId: f.workspace.shopId }))
        .verified,
    ).toBe(true);
    await f.workspace.client.mutation(api.emailInbox.setEnabled, {
      shopId: f.workspace.shopId,
      enabled: false,
    });
    expect(
      (await f.workspace.client.query(api.emailInbox.connection, { shopId: f.workspace.shopId }))
        .verified,
    ).toBe(false);
  });

  test("authenticates the real HTTP upload handshake and rejects legacy payloads", async () => {
    vi.stubEnv("CLOUDFLARE_EMAIL_WEBHOOK_SECRET", "http-test");
    vi.stubEnv("SITE_URL", "http://localhost:3000");
    const f = await prepare();
    async function post(value: unknown, signed = true) {
      const body = JSON.stringify(value),
        timestamp = String(Date.now());
      return f.t.fetch("/webhooks/cloudflare/email-routing", {
        method: "POST",
        body,
        headers: {
          "x-handlefast-timestamp": timestamp,
          "x-handlefast-signature": signed
            ? await signWebhookBody("http-test", timestamp, body)
            : "invalid",
        },
      });
    }
    expect((await post({ operation: "reserve", ...f.input })).status).toBe(200);
    expect((await post({ operation: "reserve", ...f.input }, false)).status).toBe(401);
    expect((await post({ operation: "complete" })).status).toBe(400);
    expect((await post(inboundPayload(f.route.address))).status).toBe(400);
  });
});
