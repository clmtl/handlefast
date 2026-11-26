import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(new URL("../.env.staging", import.meta.url), "utf8");
function setting(name) {
  const line = source.split(/\r?\n/).find((line) => line.startsWith(`${name}=`));
  const value = line
    ?.slice(name.length + 1)
    .trim()
    .replace(/^['"]|['"]$/g, "");
  if (!value)
    throw new Error(`Configure ${name} in .env.staging before starting connected local testing.`);
  return value;
}
const convexUrl = setting("VITE_CONVEX_URL"),
  convexSite = setting("VITE_CONVEX_SITE_URL");
console.log(`HandleFast local: http://localhost:3000 — connected to staging (${convexUrl}).`);
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)),
    "--host",
    "127.0.0.1",
    "--port",
    "3000",
    "--strictPort",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      CLOUDFLARE_ENV: "staging",
      VITE_SITE_URL: "http://localhost:3000",
      VITE_CONVEX_URL: convexUrl,
      VITE_CONVEX_SITE_URL: convexSite,
    },
  },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
