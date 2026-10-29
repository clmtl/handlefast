// Temporary staging packaging fallback when Cloudflare's assets-upload-session returns 500.
// Run after `npm run build:staging`, then deploy the printed config with Wrangler.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("dist/server");
const config = JSON.parse(await readFile(path.join(root, "wrangler.json"), "utf8"));
if (
  config.name !== "handlefast-staging" ||
  config.vars?.CONVEX_SITE_URL !== "https://frugal-gecko-721.convex.site" ||
  config.main !== "index.js"
)
  throw new Error("Build must target the existing HandleFast staging deployment");
const client = path.resolve(root, config.assets.directory);
const types = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const assets = {};
async function collect(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name.startsWith(".")) continue;
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await collect(file);
    else if (item.isFile()) {
      const type = types[path.extname(file)];
      if (!type) throw new Error(`Unsupported public asset: ${file}`);
      const bytes = await readFile(file);
      assets[`/${path.relative(client, file).split(path.sep).join("/")}`] = {
        body: bytes.toString("base64"),
        type,
        etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
      };
    }
  }
}
await collect(client);
if (Object.keys(assets).length === 0) throw new Error("No public assets found");
await writeFile(
  path.join(root, "staging-static-assets.js"),
  `export default ${JSON.stringify(assets)};\n`,
);
await writeFile(
  path.join(root, "staging-entry.js"),
  `import main from './index.js';
import assets from './staging-static-assets.js';
import { Buffer } from 'node:buffer';
export default {
  ...main,
  fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    const asset = Object.hasOwn(assets, pathname) ? assets[pathname] : undefined;
    if (!asset) return main.fetch(request, env, ctx);
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response(null, {status: 405, headers: {Allow: 'GET, HEAD'}});
    const headers = {
      'Content-Type': asset.type,
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
      'ETag': asset.etag,
      'X-Content-Type-Options': 'nosniff',
    };
    if (request.headers.get('If-None-Match') === asset.etag)
      return new Response(null, {status: 304, headers});
    return new Response(request.method === 'HEAD' ? null : Buffer.from(asset.body, 'base64'), {headers});
  }
};\n`,
);
config.main = "staging-entry.js";
delete config.assets;
delete config.legacy_env;
await writeFile(path.join(root, "wrangler.staging-fallback.json"), JSON.stringify(config, null, 2));
console.log(
  `Packaged ${Object.keys(assets).length} public assets. Staging config: dist/server/wrangler.staging-fallback.json`,
);
