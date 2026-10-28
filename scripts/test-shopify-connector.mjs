import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import {
  appConfiguration,
  installationUrl,
  parseArguments,
} from "../public/handlefast-shopify-connect.mjs";

test("connector restricts pairing endpoints and builds a read-only client app", () => {
  const code = "a".repeat(64);
  assert.equal(
    parseArguments(["--endpoint", "https://test.convex.site", "--code", code]).endpoint,
    "https://test.convex.site",
  );
  for (const endpoint of [
    "https://evil.test",
    "https://test.convex.site.evil.test",
    "https://user:pass@test.convex.site",
    "https://test.convex.site/path",
  ])
    assert.throws(() => parseArguments(["--endpoint", endpoint, "--code", code]));
  const config = appConfiguration("b".repeat(32), {
    siteUrl: "https://handlefast.example",
    webhookUrl: "https://test.convex.site/webhooks/shopify",
    apiVersion: "2026-10",
  });
  assert.match(config, /scopes = "read_orders"/);
  assert.doesNotMatch(config, /write_|app_store/);
  const url = new URL(installationUrl("1234", "b".repeat(32)));
  assert.equal(url.searchParams.get("organization_id"), "1234");
  assert.equal(
    url.searchParams.get("redirect"),
    `/oauth/redirect_from_developer_dashboard?client_id=${"b".repeat(32)}`,
  );
});

test("runs the whole client flow with a fake Shopify CLI, keeps secrets off stdout and binds completion without any organization argument", {
  timeout: 15000,
}, async () => {
  const folder = await mkdtemp(join(tmpdir(), "handlefast-connector-test-"));
  const bin = join(folder, "bin"),
    log = join(folder, "commands.jsonl");
  await mkdir(bin);
  const fakeCli = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const original = process.argv.slice(2);
const args = original.slice(original.indexOf('shopify') + 1);
appendFileSync(process.env.CONNECTOR_TEST_LOG, JSON.stringify(original) + '\\n');
const path = args[args.indexOf('--path') + 1];
if (args[1] === 'init') { mkdirSync(path, {recursive:true}); writeFileSync(join(path, 'shopify.app.toml'), 'client_id = "${"b".repeat(32)}"\\n'); }
else if (args[1] === 'info') console.log(JSON.stringify(args.includes('--web-env') ? {SHOPIFY_API_KEY:'${"b".repeat(32)}', SHOPIFY_API_SECRET:'synthetic-private-secret'} : {organization:{id:'1234'}}));
else if (args[1] === 'deploy') { const config = readFileSync(join(path,'shopify.app.toml'),'utf8'); if (!config.includes('scopes = "read_orders"')) process.exit(1); }
`;
  await writeFile(join(bin, "npx"), fakeCli);
  await chmod(join(bin, "npx"), 0o755);
  for (const command of ["open", "xdg-open"]) {
    await writeFile(join(bin, command), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, command), 0o755);
  }
  let completion;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(req.headers.authorization, `Bearer ${"a".repeat(64)}`);
    res.setHeader("Content-Type", "application/json");
    if (req.url.endsWith("bootstrap"))
      res.end(
        JSON.stringify({
          domain: "client.myshopify.com",
          organizationName: "Client organization",
          name: "Client shop",
          siteUrl: "https://handlefast.example",
          webhookUrl: "https://test.convex.site/webhooks/shopify",
          apiVersion: "2026-10",
        }),
      );
    else {
      completion = JSON.parse(body);
      res.end(JSON.stringify({ connected: true }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(
      process.execPath,
      [
        resolve("public/handlefast-shopify-connect.mjs"),
        "--endpoint",
        endpoint,
        "--code",
        "a".repeat(64),
      ],
      {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONNECTOR_TEST_LOG: log },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      consent = false,
      install = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!consent && stdout.includes("[o/N]")) {
        consent = true;
        child.stdin.write("o\n");
      }
      if (!install && stdout.includes("appuyez sur Entrée")) {
        install = true;
        child.stdin.write("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => child.kill(), 10000);
    const code = await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(timeout);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Boutique connectée/);
    assert.doesNotMatch(stdout + stderr, /synthetic-private-secret/);
    assert.deepEqual(completion, {
      clientId: "b".repeat(32),
      clientSecret: "synthetic-private-secret",
    });
    const commands = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(commands.length, 5);
    assert.deepEqual(commands[0].slice(0, 5), [
      "--yes",
      "--package",
      "@shopify/cli@5.0.0",
      "--",
      "shopify",
    ]);
    const path = commands[0][commands[0].indexOf("--path") + 1];
    await assert.rejects(access(dirname(path)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});
