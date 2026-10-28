// Local-only integration check: creates synthetic fixtures, never sends email.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const config = readFileSync(".env.local", "utf8");
assert.match(config, /^CONVEX_DEPLOYMENT=anonymous:/m, "Use an anonymous local Convex deployment");
const site = config.match(/^VITE_CONVEX_SITE_URL=(.+)$/m)?.[1];
assert.ok(site && ["localhost", "127.0.0.1"].includes(new URL(site).hostname));
const cli = "./node_modules/.bin/convex";
function run(name, args, options = []) {
  return JSON.parse(
    execFileSync(cli, ["run", name, JSON.stringify(args), ...options], { encoding: "utf8" }),
  );
}
const now = Date.now();
const seed = randomUUID();
const user = run(
  "adapter:create",
  {
    input: {
      model: "user",
      data: {
        name: "Local email smoke",
        email: `smoke-${seed}@example.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  },
  ["--component", "betterAuth"],
);
const session = run(
  "adapter:create",
  {
    input: {
      model: "session",
      data: {
        token: seed,
        userId: user._id,
        expiresAt: now + 3600000,
        createdAt: now,
        updatedAt: now,
      },
    },
  },
  ["--component", "betterAuth"],
);
const identity = [
  "--identity",
  JSON.stringify({
    subject: user._id,
    issuer: site,
    tokenIdentifier: `${site}|${user._id}`,
    sessionId: session._id,
  }),
];
const workspace = run(
  "onboarding:bootstrap",
  { organizationName: "Local email smoke", shopName: "Synthetic email shop" },
  identity,
);
const route = run("inboundEmailRoutes:getForShop", { shopId: workspace.shopId }, identity);
// Retain an existing local secret; never print it.
let secret;
try {
  secret = execFileSync(cli, ["env", "get", "CLOUDFLARE_EMAIL_WEBHOOK_SECRET"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
} catch {}
if (!secret) {
  secret = randomUUID();
  execFileSync(cli, ["env", "set", "CLOUDFLARE_EMAIL_WEBHOOK_SECRET"], {
    input: secret,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
async function signed(payload) {
  const body = JSON.stringify(payload),
    timestamp = String(Date.now());
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const response = await fetch(`${site}/webhooks/cloudflare/email-routing`, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "x-handlefast-timestamp": timestamp,
      "x-handlefast-signature": `sha256=${signature}`,
    },
  });
  assert.ok(response.ok, `Webhook HTTP ${response.status}`);
  return response.json();
}
const subject = run(
  "emailInbox:beginTest",
  { shopId: workspace.shopId, supportEmail: "support@example.com" },
  identity,
);
for (const size of [1024, 25 * 1024 * 1024]) {
  const prefix = `From: client@example.com\r\nTo: support@example.com\r\nSubject: ${subject}\r\nMessage-ID: <${randomUUID()}@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="smoke"\r\n\r\n--smoke\r\nContent-Type: text/plain\r\n\r\nSynthetic test.\r\n--smoke\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="proof.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n`;
  const suffix = "\r\n--smoke--\r\n";
  const padding = size - Buffer.byteLength(prefix + suffix);
  const raw = Buffer.from(
    prefix +
      `${"YWFh".repeat(19)}\r\n`.repeat(Math.floor(padding / 78)) +
      "YWFh".repeat(Math.floor((padding % 78) / 4)) +
      " ".repeat((padding % 78) % 4) +
      suffix,
  );
  assert.equal(raw.length, size);
  const input = {
    operation: "reserve",
    envelopeFrom: "client@example.com",
    envelopeTo: route.address,
    sha256: createHash("sha256").update(raw).digest("base64"),
    rawSize: size,
  };
  const reserved = await signed(input);
  assert.equal(reserved.status, "upload");
  const uploaded = await fetch(reserved.uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/vnd.handlefast.email" },
    body: raw,
  });
  assert.ok(uploaded.ok);
  const { storageId } = await uploaded.json();
  assert.equal(
    (await signed({ operation: "complete", receiptId: reserved.receiptId, storageId })).status,
    "accepted",
  );
  let receipt;
  for (let retry = 0; retry < 60; retry++) {
    receipt = run("emailReceipts:getInternal", { receiptId: reserved.receiptId });
    if (receipt.status === "processed" || receipt.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(receipt.status, "processed");
  const downloadUrl = run("emailInbox:download", { receiptId: reserved.receiptId }, identity);
  const restored = Buffer.from(await (await fetch(downloadUrl)).arrayBuffer());
  assert.deepEqual(restored, raw);
  assert.equal((await signed(input)).status, "accepted");
  console.log(
    `PASS ${size} bytes: signed upload, scheduled parsing, authorized download, exact original, duplicate detection`,
  );
}
assert.equal(run("emailInbox:connection", { shopId: workspace.shopId }, identity).verified, true);
console.log("PASS forwarding challenge verified; synthetic fixtures retained locally");
