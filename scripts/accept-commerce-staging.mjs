// Staging-only acceptance runner. Never registers, retracks or changes a carrier.
// --step prepare|resume|renew|manual|check|push|quota|cleanup --deploy-env <file>
// --track-env <file> [--manifest /tmp/handlefast-commerce-acceptance.json]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
const step = options.get("--step") ?? "prepare";
const manifestPath = options.get("--manifest") ?? "/tmp/handlefast-commerce-acceptance.json";
function envFile(file) {
  assert.ok(file, "An explicit credentials file is required");
  const result = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z_0-9]*)=(.*)$/.exec(line.trim());
    if (match) result[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return result;
}
const { CONVEX_DEPLOYMENT: _, ...inherited } = process.env;
const deploymentEnv = { ...inherited, ...envFile(options.get("--deploy-env")) };
const trackKey = envFile(options.get("--track-env")).TRACK17_API_KEY;
assert.ok(deploymentEnv.CONVEX_DEPLOY_KEY && trackKey, "Missing credentials");
function cli(args) {
  const result = spawnSync(
    process.execPath,
    [path.resolve("node_modules/convex/bin/main.js"), ...args],
    {
      env: deploymentEnv,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    writeFileSync(`${manifestPath}.error.txt`, result.stderr, { mode: 0o600 });
    throw new Error(`Convex operation failed (${args[0]} ${args[1]}). See private error artifact.`);
  }
  return result.stdout.trim();
}
const site = cli(["env", "get", "SITE_URL"]);
assert.equal(
  site,
  "https://handlefast-staging.bk201li.workers.dev",
  "Refusing a non-staging target",
);
assert.ok(cli(["env", "get", "TRACK17_API_KEY"]) === trackKey, "17TRACK key differs from staging");
const http = "https://frugal-gecko-721.convex.site";
const writeManifest = (value) =>
  writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const parsed = (value) => (value ? JSON.parse(value) : null);
const query = (code, component) =>
  parsed(cli(["run", "--inline-query", code, ...(component ? ["--component", component] : [])]));
const run = (name, args, identity) =>
  parsed(
    cli([
      "run",
      name,
      JSON.stringify(args),
      ...(identity ? ["--identity", JSON.stringify(identity)] : []),
    ]),
  );
const table = (name, limit = 250, component) =>
  query(`await ctx.db.query(${JSON.stringify(name)}).order("desc").take(${limit})`, component);
const get = (id) => query(`await ctx.db.get(${JSON.stringify(id)})`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Deliberately no register/getRealTimeTrackInfo/retrack/change-carrier operation.
async function tracking(endpoint, body = []) {
  assert.ok(["getquota", "push"].includes(endpoint));
  const response = await fetch(`https://api.17track.net/track/v2.4/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "17token": trackKey },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(25000),
  });
  assert.equal(response.status, 200, "17TRACK HTTP error");
  const result = await response.json();
  assert.equal(result.code, 0, "17TRACK rejected the operation");
  return result.data;
}
async function quota() {
  const data = await tracking("getquota");
  return { total: data.quota_total, used: data.quota_used, remaining: data.quota_remain };
}
async function uploadFixture(context, label, from) {
  if (context.receipts[label]) return waitForFixture(context.receipts[label].id);
  const subject = `HF-QA Feature4 ${label} ${context.order.name} ${context.runId.slice(0, 8)}`;
  const raw = Buffer.from(
    [
      `From: HF-QA Client <${from}>`,
      `To: ${context.route.address}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
      `Message-ID: <hf-qa-commerce-${context.runId}-${label}@acceptance.handlefast.invalid>`,
      `X-HandleFast-Acceptance: ${context.runId}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      `Bonjour, où est ma commande ${context.order.name} ? Je n’ai pas reçu mon colis. Pouvez-vous vérifier la livraison et me communiquer son suivi ? Merci.`,
      "",
    ].join("\r\n"),
  );
  const secret = cli(["env", "get", "CLOUDFLARE_EMAIL_WEBHOOK_SECRET"]);
  assert.ok(secret);
  async function signed(payload) {
    const body = JSON.stringify(payload),
      timestamp = String(Date.now());
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    const result = await fetch(`${http}/webhooks/cloudflare/email-routing`, {
      method: "POST",
      body,
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "x-handlefast-timestamp": timestamp,
        "x-handlefast-signature": `sha256=${signature}`,
      },
    });
    assert.ok(result.ok, "Signed inbound upload failed");
    return result.json();
  }
  const reserved = await signed({
    operation: "reserve",
    envelopeFrom: from,
    envelopeTo: context.route.address,
    sha256: createHash("sha256").update(raw).digest("base64"),
    rawSize: raw.length,
  });
  assert.equal(reserved.status, "upload");
  // Save each ID immediately, so interrupted runs can still clean up.
  context.receipts[label] = { id: reserved.receiptId, subject };
  writeManifest(context);
  const upload = await fetch(reserved.uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/vnd.handlefast.email" },
    body: raw,
  });
  assert.ok(upload.ok);
  const { storageId } = await upload.json();
  await signed({ operation: "complete", receiptId: reserved.receiptId, storageId });
  await waitForFixture(reserved.receiptId);
}
async function waitForFixture(receiptId) {
  for (let retry = 0; retry < 30; retry++) {
    const receipt = run("emailReceipts:getInternal", { receiptId });
    if (receipt.status === "processed") {
      assert.equal(
        receipt.triage.bucket,
        "sav",
        "Synthetic SAV message did not reach the SAV inbox",
      );
      return;
    }
    assert.notEqual(receipt.status, "failed", "Inbound processing failed");
    await pause(1000);
  }
  throw new Error("Inbound processing timed out");
}

if (step === "prepare") {
  if (existsSync(manifestPath))
    assert.ok(
      JSON.parse(readFileSync(manifestPath, "utf8")).report.fixturesRemoved,
      "Clean up the previous run before preparing another",
    );
  const connections = table("shopifyConnections", 20);
  const connection = connections.find(
    (c) => c.domain === "8vvazz-uj.myshopify.com" && c.status === "active",
  );
  assert.ok(connection, "Expected connected staging merchant");
  const orders = table("shopifyOrders").filter(
    (o) => o.connectionId === connection._id && o.generation === connection.generation,
  );
  const parcels = table("orderShipments").filter(
    (p) => p.connectionId === connection._id && p.generation === connection.generation && p.active,
  );
  const eligible = (o) => parcels.filter((p) => p.orderId === o._id).every((p) => p.registered);
  const order = orders.find(
    (o) =>
      o.email &&
      eligible(o) &&
      orders.filter((other) => other.email === o.email).every(eligible) &&
      parcels.some(
        (p) =>
          p.orderId === o._id &&
          p.registered &&
          p.carrier &&
          p.status === "Delivered" &&
          p.events.length,
      ),
  );
  assert.ok(order, "Need an order with already registered parcels and cached history");
  const alternative = orders.find((o) => o._id !== order._id && eligible(o));
  assert.ok(alternative);
  const parcel = parcels.find(
    (p) =>
      p.orderId === order._id &&
      p.registered &&
      p.carrier &&
      p.status === "Delivered" &&
      p.events.length,
  );
  const owner = table("memberships", 100).find(
    (m) => m.organizationId === connection.organizationId && m.role === "owner",
  );
  const profile = get(owner.profileId);
  const sessions = table("session", 200, "betterAuth");
  const session = sessions.find((s) => s.userId === profile.authUserId && s.expiresAt > Date.now());
  assert.ok(session, "Need an existing authenticated owner session");
  const route = table("inboundEmailRoutes", 50).find(
    (r) => r.shopId === connection.shopId && r.status === "active",
  );
  assert.ok(route);
  const context = {
    runId: randomUUID(),
    connectionId: connection._id,
    shopId: connection.shopId,
    profileId: profile._id,
    generation: connection.generation,
    order,
    alternative,
    parcel,
    route,
    identity: {
      subject: profile.authUserId,
      tokenIdentifier: profile.authTokenIdentifier,
      issuer: profile.authTokenIdentifier.split("|")[0],
      sessionId: session._id,
    },
    receipts: {},
    report: { quotaBefore: await quota(), explicitRegistrations: 0 },
  };
  writeManifest(context);
} else if (step !== "resume") {
  const context = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (step === "renew") {
    const result = run("commerceAcceptance:renewShopifyAccess", {
      connectionId: context.connectionId,
    });
    assert.ok(result.renewed && result.shopMatches);
    assert.ok(result.expiresAt > Date.now() + 23 * 3600_000);
    context.report.shopifyRenewal = {
      ...result,
      lifetimeHours: Math.round((result.expiresAt - Date.now()) / 3600_000),
    };
    writeManifest(context);
    console.log(
      JSON.stringify({
        shopifyRenewal: true,
        tokenLifetimeHours: context.report.shopifyRenewal.lifetimeHours,
        trackingCalls: 0,
      }),
    );
  } else if (step === "manual") {
    const receiptId = context.receipts["identite-differente"].id;
    const view = run("orderContext:forEmail", { receiptId }, context.identity);
    assert.equal(view.mode, "manual");
    assert.equal(view.selected?._id, context.alternative._id);
    assert.equal(view.identityMatches, false);
    const audit = query(
      `await ctx.db.query("orderLinks").withIndex("by_receiptId", q=>q.eq("receiptId", ${JSON.stringify(receiptId)})).unique()`,
    );
    assert.equal(audit.profileId, context.profileId);
    context.report.manualCorrection = true;
    context.report.actorRecorded = true;
    context.report.wrongSenderWarning = true;
    writeManifest(context);
    console.log("Manual correction and actor audit verified.");
  } else if (step === "check") {
    const automatic = run(
      "orderContext:forEmail",
      { receiptId: context.receipts.automatique.id },
      context.identity,
    );
    assert.equal(automatic.mode, "automatic");
    assert.equal(automatic.selected?._id, context.order._id);
    const mismatch = run(
      "orderContext:forEmail",
      { receiptId: context.receipts["identite-differente"].id },
      context.identity,
    );
    assert.equal(mismatch.mode, "none");
    assert.equal(mismatch.selected, null);
    context.report.removeAndRestore = true;
    writeManifest(context);
    console.log("Association removal and automatic restoration verified.");
  } else if (step === "push") {
    assert.ok(
      !context.report.pushRequested,
      "Only one provider push is permitted per acceptance run",
    );
    const parcel = get(context.parcel._id);
    assert.ok(
      parcel.registered &&
        parcel.carrier === context.parcel.carrier &&
        parcel.number === context.parcel.number,
    );
    assert.ok(
      parcel.nextAttemptAt > Date.now() + 3600_000,
      "Wait for existing parcel polling to settle first",
    );
    const before = parcel.syncedAt;
    context.report.pushRequested = true;
    writeManifest(context);
    const pushed = await tracking("push", [{ number: parcel.number, carrier: parcel.carrier }]);
    assert.equal(pushed.accepted.length, 1);
    assert.equal(pushed.rejected.length, 0);
    for (let retry = 0; retry < 12; retry++) {
      const updated = get(parcel._id);
      if (updated.syncedAt > before) {
        context.report.realProviderPush = true;
        context.report.pushHistoryEvents = updated.events.length;
        writeManifest(context);
        console.log(
          JSON.stringify({
            realProviderPush: true,
            events: updated.events.length,
            explicitRegistrations: 0,
          }),
        );
        break;
      }
      await pause(3000);
    }
    assert.equal(
      context.report.realProviderPush,
      true,
      "Provider push is queued but not yet observed; do not send another",
    );
  } else if (step === "quota") {
    context.report.quotaAfter = await quota();
    context.report.quotaDelta = context.report.quotaAfter.used - context.report.quotaBefore.used;
    writeManifest(context);
    console.log(
      JSON.stringify({
        before: context.report.quotaBefore,
        after: context.report.quotaAfter,
        delta: context.report.quotaDelta,
      }),
    );
    assert.equal(
      context.report.quotaDelta,
      0,
      "Quota changed; investigate background registrations before more tests",
    );
  } else if (step === "cleanup") {
    const receiptIds = Object.values(context.receipts).map((r) => r.id);
    run("commerceAcceptance:expireFixtures", { runId: context.runId, receiptIds });
    for (let retry = 0; retry < 10; retry++) {
      if (receiptIds.every((id) => get(id) === null)) break;
      await pause(500);
    }
    assert.ok(receiptIds.every((id) => get(id) === null));
    context.report.fixturesRemoved = true;
    writeManifest(context);
    console.log("Both synthetic emails and linked test data removed.");
  } else throw new Error("Unknown acceptance step");
}

if (step === "prepare" || step === "resume") {
  const context = JSON.parse(readFileSync(manifestPath, "utf8"));
  const { order, alternative } = context;
  await uploadFixture(context, "automatique", order.email);
  await uploadFixture(context, "identite-differente", "qa-acceptance@handlefast.invalid");
  const automatic = run(
    "orderContext:forEmail",
    { receiptId: context.receipts.automatique.id },
    context.identity,
  );
  assert.equal(automatic.selected?._id, order._id);
  assert.equal(automatic.mode, "automatic");
  assert.equal(automatic.identityMatches, true);
  assert.ok(automatic.shipments.some((p) => p.events.length));
  const mismatch = run(
    "orderContext:forEmail",
    { receiptId: context.receipts["identite-differente"].id },
    context.identity,
  );
  assert.equal(mismatch.selected, null);
  assert.equal(mismatch.mode, "none");
  context.report.automaticAssociation = true;
  context.report.wrongSenderNotAssociated = true;
  writeManifest(context);
  console.log(
    JSON.stringify({
      ready: true,
      subjects: Object.values(context.receipts).map((r) => r.subject),
      order: order.name,
      alternative: alternative.name,
      quotaBefore: context.report.quotaBefore,
    }),
  );
}
