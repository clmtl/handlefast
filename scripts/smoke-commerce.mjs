// Local-only integration check. --live-device issues then cancels a Shopify device authorization; never approves it or creates an app.
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
const live = process.argv.includes("--live-device");
const sessionId = run(
  live ? "shopifyGuidedActions:start" : "shopifyGuided:reserve",
  { shopId: workspace.shopId, domain: "https://admin.shopify.com/store/handlefast-smoke" },
  identity,
);
const sessionView = run("shopifyGuided:get", { sessionId }, identity);
assert.equal(sessionView.domain, "handlefast-smoke.myshopify.com");
assert.equal(sessionView.status, live ? "pending" : "initializing");
assert.equal("secret" in sessionView, false);
if (live) {
  assert.equal(new URL(sessionView.verificationUrl).origin, "https://accounts.shopify.com");
  assert.ok(sessionView.userCode);
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, sessionView.nextPollAt - Date.now()) + 10),
  );
  run("shopifyGuidedActions:poll", { sessionId }, identity);
  assert.equal(run("shopifyGuided:get", { sessionId }, identity).status, "pending");
}
run("shopifyGuided:cancel", { sessionId }, identity);
const cancelled = run("shopifyGuided:get", { sessionId }, identity);
assert.equal(cancelled.status, "error");
assert.equal(cancelled.secret, undefined);
console.log(
  live
    ? "Local browser-flow smoke passed: real Shopify device authorization issued, encrypted and cancelled. No approval or merchant-app creation performed."
    : "Local browser-flow smoke passed: organization-bound authenticated session, sanitized public state and cancellation. No provider calls made.",
);
