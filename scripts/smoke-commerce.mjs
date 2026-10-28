// Local-only integration check: creates synthetic fixtures, never sends email.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const config = readFileSync(".env.local", "utf8");
assert.match(config, /^CONVEX_DEPLOYMENT=anonymous:/m, "Use an anonymous local Convex deployment");
const site = config.match(/^VITE_CONVEX_SITE_URL=(.+)$/m)?.[1];
assert.ok(site && ["localhost", "127.0.0.1"].includes(new URL(site).hostname));
const cli = "./node_modules/.bin/convex";
function run(name, args, options = []) {
  const output = execFileSync(cli, ["run", name, JSON.stringify(args), ...options], {
    encoding: "utf8",
  });
  return output.trim() ? JSON.parse(output) : null;
}
const now = Date.now();
const seed = randomUUID();
const user = run(
  "adapter:create",
  {
    input: {
      model: "user",
      data: {
        name: "Local commerce smoke",
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
  { organizationName: "Local commerce smoke", shopName: "Synthetic commerce shop" },
  identity,
);
const pairing = run(
  "shopifyConnection:begin",
  { shopId: workspace.shopId, domain: "handlefast-smoke.myshopify.com" },
  identity,
);
assert.match(pairing.code, /^[a-f0-9]{64}$/);
const response = await fetch(`${site}/integrations/shopify/bootstrap`, {
  method: "POST",
  headers: { Authorization: `Bearer ${pairing.code}` },
});
assert.equal(response.status, 200);
const bootstrap = await response.json();
assert.equal(bootstrap.domain, "handlefast-smoke.myshopify.com");
assert.equal(bootstrap.organizationName, "Local commerce smoke");
assert.equal("shopId" in bootstrap, false);
const invalid = await fetch(`${site}/integrations/shopify/bootstrap`, {
  method: "POST",
  headers: { Authorization: `Bearer ${"0".repeat(64)}` },
});
assert.equal(invalid.status, 401);
await run("shopifyConnection:disconnect", { shopId: workspace.shopId }, identity);
const cancelled = await fetch(`${site}/integrations/shopify/bootstrap`, {
  method: "POST",
  headers: { Authorization: `Bearer ${pairing.code}` },
});
assert.equal(cancelled.status, 401);
console.log(
  "Local commerce smoke passed: authenticated pairing, organization binding, invalid code, cancellation. No Shopify or 17TRACK call made.",
);
