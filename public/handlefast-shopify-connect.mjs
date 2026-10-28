#!/usr/bin/env node
import { spawn } from "node:child_process";
// Standalone client connector. Client secrets stay in memory and captured CLI output.
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

export const CLI_VERSION = "5.0.0";
export function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--endpoint", "--code"].includes(argv[i]) || !argv[i + 1])
      throw new Error(
        "Usage : node handlefast-shopify-connect.mjs --endpoint https://xxx.convex.site --code CODE",
      );
    options[argv[i].slice(2)] = argv[i + 1];
  }
  const endpoint = new URL(options.endpoint);
  const local = ["localhost", "127.0.0.1"].includes(endpoint.hostname);
  if (
    !(endpoint.protocol === "https:" && endpoint.hostname.endsWith(".convex.site")) &&
    !(local && endpoint.protocol === "http:")
  )
    throw new Error(
      "Le serveur doit être une adresse Convex HTTPS (ou localhost en développement).",
    );
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  )
    throw new Error("Adresse du serveur invalide.");
  if (!/^[a-f0-9]{64}$/.test(options.code ?? "")) throw new Error("Code de connexion invalide.");
  return { endpoint: endpoint.origin, code: options.code };
}
export function appConfiguration(clientId, settings) {
  const url = new URL(settings.siteUrl);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Adresse HandleFast invalide.");
  const quote = (s) => JSON.stringify(s);
  return `client_id = ${quote(clientId)}
name = "HandleFast Support"
application_url = ${quote(`${url.origin}/dashboard`)}
embedded = false

[access_scopes]
scopes = "read_orders"

[auth]
redirect_urls = [${quote(`${url.origin}/dashboard`)}]

[webhooks]
api_version = ${quote(settings.apiVersion)}

[[webhooks.subscriptions]]
topics = ["orders/create", "orders/updated", "orders/cancelled", "refunds/create", "fulfillments/create", "fulfillments/update", "app/uninstalled"]
uri = ${quote(settings.webhookUrl)}
`;
}
export function installationUrl(organizationId, clientId) {
  if (!/^[0-9]+$/.test(organizationId) || !/^[a-f0-9]{32}$/i.test(clientId))
    throw new Error("Identifiants Shopify invalides.");
  const url = new URL("https://admin.shopify.com/");
  url.searchParams.set("organization_id", organizationId);
  url.searchParams.set("no_redirect", "true");
  url.searchParams.set(
    "redirect",
    `/oauth/redirect_from_developer_dashboard?client_id=${clientId}`,
  );
  return url.href;
}
async function runShopify(args, capture = false) {
  const npmScript = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  if (process.platform === "win32" && !existsSync(npmScript))
    throw new Error("Réinstallez Node.js avec npm pour lancer Shopify CLI.");
  return new Promise((resolve, reject) => {
    // spawn without a shell: all values remain literal arguments.
    const child = spawn(
      process.platform === "win32" ? process.execPath : "npx",
      [
        ...(process.platform === "win32" ? [npmScript] : []),
        "--yes",
        "--package",
        `@shopify/cli@${CLI_VERSION}`,
        "--",
        "shopify",
        ...args,
      ],
      {
        shell: false,
        stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
        env: { ...process.env, SHOPIFY_CLI_NO_ANALYTICS: "1" },
      },
    );
    let output = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.length > 2_000_000) child.kill();
      });
      // CLI errors can contain credentials; deliberately do not print captured stderr.
      child.stderr.on("data", () => {});
    }
    child.on("error", () =>
      reject(new Error("Impossible de lancer Shopify CLI. Vérifiez Node.js et npm.")),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error("Shopify CLI n’a pas terminé. Relancez la connexion depuis HandleFast."),
          ),
    );
  });
}
async function findConfig(path, depth = 0) {
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.some((e) => e.name === "shopify.app.toml")) return join(path, "shopify.app.toml");
  if (depth < 3)
    for (const entry of entries)
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
        const result = await findConfig(join(path, entry.name), depth + 1);
        if (result) return result;
      }
  return null;
}
async function request(options, operation, body = {}) {
  const response = await fetch(`${options.endpoint}/integrations/shopify/${operation}`, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${options.code}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.message ??
        (result.error === "PairingExpired"
          ? "Le code a expiré. Générez une nouvelle commande dans HandleFast."
          : "La connexion n’a pas pu être vérifiée."),
    );
  return result;
}
async function openUrl(url) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  await new Promise((resolve) => {
    const child = spawn(command, [url], { shell: false, stdio: "ignore" });
    child.on("error", resolve);
    child.on("close", resolve);
  });
}
export async function main(argv) {
  if (argv.includes("--help")) {
    console.log(
      "Usage : node handlefast-shopify-connect.mjs --endpoint https://xxx.convex.site --code CODE\nNode.js 22.12+ requis. Shopify CLI créera une app dans votre organisation Shopify.",
    );
    return;
  }
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("Installez Node.js 22.12 ou plus récent.");
  const options = parseArguments(argv);
  const settings = await request(options, "bootstrap");
  console.log(`Connexion de ${settings.domain} à ${settings.organizationName} / ${settings.name}.`);
  console.log(
    "Shopify CLI va créer une app dans votre organisation Shopify. Choisissez celle qui possède cette boutique. Autorisation demandée : lecture des commandes.",
  );
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let folder;
  try {
    const consent = await terminal.question("Créer et configurer cette app ? [o/N] ");
    terminal.close();
    if (!/^(o|oui|y|yes)$/i.test(consent.trim())) return;
    folder = await mkdtemp(join(tmpdir(), "handlefast-shopify-"));
    await runShopify([
      "app",
      "init",
      "--template",
      "none",
      "--name",
      `HandleFast-${Date.now().toString(36)}`,
      "--path",
      join(folder, "app"),
    ]);
    const configPath = await findConfig(folder);
    if (!configPath) throw new Error("Configuration Shopify introuvable.");
    const project = dirname(configPath);
    const original = await readFile(configPath, "utf8");
    const clientId = original.match(/^client_id\s*=\s*"([a-f0-9]{32})"/im)?.[1];
    if (!clientId) throw new Error("Identifiant de l’app Shopify introuvable.");
    await writeFile(configPath, appConfiguration(clientId, settings), { mode: 0o600 });
    await runShopify(["app", "config", "validate", "--path", project]);
    await runShopify(["app", "deploy", "--path", project, "--allow-updates"]);
    const info = JSON.parse(
      await runShopify(["app", "info", "--path", project, "--json", "--no-input"], true),
    );
    const org = String(info.organization?.id ?? info.remoteApp?.organizationId ?? "");
    const install = installationUrl(org, clientId);
    console.log(`Installez l’app uniquement sur ${settings.domain} :\n${install}`);
    await openUrl(install);
    const installTerminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await installTerminal.question(
        "Après avoir approuvé l’installation dans Shopify, appuyez sur Entrée… ",
      );
    } finally {
      installTerminal.close();
    }
    const credentials = JSON.parse(
      await runShopify(
        ["app", "info", "--path", project, "--web-env", "--json", "--no-input"],
        true,
      ),
    );
    if (
      credentials.SHOPIFY_API_KEY !== clientId ||
      typeof credentials.SHOPIFY_API_SECRET !== "string"
    )
      throw new Error("Shopify CLI n’a pas fourni les identifiants de l’app.");
    await request(options, "complete", { clientId, clientSecret: credentials.SHOPIFY_API_SECRET });
    console.log(
      `Boutique connectée à ${settings.organizationName}. Vous pouvez revenir dans HandleFast.`,
    );
    await openUrl(`${new URL(settings.siteUrl).origin}/dashboard`);
  } finally {
    terminal.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
