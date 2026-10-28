import { z } from "zod";
import { internal } from "./_generated/api";
import { env, httpAction } from "./_generated/server";
import { shopDomain } from "./lib/commerceModel";
import {
  exchangeCredentials,
  normalizeTracking,
  ORDERS_QUERY,
  SHOP_QUERY,
  shopifyGraphql,
} from "./lib/commerceProviders";
import { decrypt, encrypt, equalSignature, sha256, verifyShopify } from "./lib/commerceSecrets";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
export async function boundedBody(req: Request, max: number) {
  if (Number(req.headers.get("content-length")) > max) return null;
  const reader = req.body?.getReader();
  if (!reader) return "";
  let total = 0;
  let result = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return result + decoder.decode();
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
function pairingCode(req: Request) {
  const value = req.headers.get("authorization")?.replace(/^Bearer /, "");
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
export const bootstrap = httpAction(async (ctx, req) => {
  const code = pairingCode(req);
  if (!code) return json({ error: "InvalidPairing" }, 401);
  const pair = await ctx.runQuery(internal.shopifyConnection.pairing, {
    tokenHash: await sha256(code),
  });
  if (!pair) return json({ error: "PairingExpired" }, 401);
  return json({
    domain: pair.domain,
    name: pair.name,
    organizationName: pair.organizationName,
    expiresAt: pair.expiresAt,
    siteUrl: pair.siteUrl,
    apiVersion: pair.apiVersion,
    webhookUrl: `${new URL(req.url).origin}/webhooks/shopify`,
  });
});
export const complete = httpAction(async (ctx, req) => {
  const code = pairingCode(req);
  if (!code) return json({ error: "InvalidPairing" }, 401);
  const tokenHash = await sha256(code);
  const pair = await ctx.runQuery(internal.shopifyConnection.pairing, { tokenHash });
  if (!pair) return json({ error: "PairingExpired" }, 401);
  const body = await boundedBody(req, 16_384);
  if (body === null) return json({ error: "PayloadTooLarge" }, 413);
  try {
    const credentials = z
      .object({
        clientId: z.string().regex(/^[a-f0-9]{32}$/i),
        clientSecret: z.string().min(16).max(4096),
      })
      .strict()
      .parse(JSON.parse(body));
    const result = await exchangeCredentials(
      pair.domain,
      credentials.clientId,
      credentials.clientSecret,
    );
    const scopes = result.scope.split(",").map((s) => s.trim());
    if (!scopes.includes("read_orders") || scopes.some((s) => s.startsWith("write_")))
      return json({ error: "ReadOnlyOrdersPermissionRequired" }, 400);
    const data = z
      .object({ shop: z.object({ id: z.string(), myshopifyDomain: z.string() }) })
      .parse(await shopifyGraphql(pair.domain, result.access_token, SHOP_QUERY));
    if (shopDomain(data.shop.myshopifyDomain) !== pair.domain)
      return json({ error: "ShopDomainMismatch" }, 400);
    // Test protected customer/order fields before claiming the connection is usable.
    await shopifyGraphql(pair.domain, result.access_token, ORDERS_QUERY, {
      query: "status:any",
      after: null,
    });
    const context = `shopify:${pair.shopId}`;
    await ctx.runMutation(internal.shopifyConnection.finish, {
      tokenHash,
      domain: pair.domain,
      shopifyShopId: data.shop.id,
      clientId: credentials.clientId,
      secret: await encrypt(credentials.clientSecret, context),
      token: await encrypt(result.access_token, context),
      tokenExpiresAt: Date.now() + result.expires_in * 1000,
      scopes,
    });
    return json({ connected: true, domain: pair.domain });
  } catch {
    return json(
      {
        error: "ConnectionVerificationFailed",
        message:
          "Vérifiez l’installation sur la bonne boutique et l’accès aux commandes et données clients.",
      },
      400,
    );
  }
});
export const shopifyWebhook = httpAction(async (ctx, req) => {
  const domain = req.headers.get("x-shopify-shop-domain");
  if (!domain || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain))
    return json({ error: "InvalidShop" }, 400);
  const row = await ctx.runQuery(internal.shopifyConnection.byDomain, { domain });
  if (!row) return json({ error: "UnknownShop" }, 401);
  const body = await boundedBody(req, 512_000);
  if (body === null) return json({ error: "PayloadTooLarge" }, 413);
  const secret = await decrypt(row.secret, `shopify:${row.shopId}`);
  if (!(await verifyShopify(body, req.headers.get("x-shopify-hmac-sha256"), secret)))
    return json({ error: "InvalidSignature" }, 401);
  const topic = req.headers.get("x-shopify-topic");
  if (topic === "app/uninstalled")
    await ctx.runMutation(internal.shopifyConnection.uninstalled, {
      connectionId: row._id,
      generation: row.generation,
    });
  else if (
    [
      "orders/create",
      "orders/updated",
      "orders/cancelled",
      "refunds/create",
      "fulfillments/create",
      "fulfillments/update",
    ].includes(topic ?? "")
  )
    await ctx.runMutation(internal.shopifySync.start, { connectionId: row._id });
  return json({ received: true });
});
export const trackingWebhook = httpAction(async (ctx, req) => {
  if (!env.TRACK17_API_KEY) return json({ error: "TrackingNotConfigured" }, 503);
  const body = await boundedBody(req, 512_000);
  if (body === null) return json({ error: "PayloadTooLarge" }, 413);
  const sign = req.headers.get("sign")?.toLowerCase() ?? "";
  if (
    !/^[a-f0-9]{64}$/.test(sign) ||
    !equalSignature(await sha256(`${body}/${env.TRACK17_API_KEY}`), sign)
  )
    return json({ error: "InvalidSignature" }, 401);
  try {
    const payload = z.object({ event: z.string(), data: z.unknown() }).parse(JSON.parse(body));
    if (payload.event === "TRACKING_UPDATED") {
      const data = z.object({ accepted: z.array(z.unknown()).max(40) }).safeParse(payload.data);
      const updates = (data.success ? data.data.accepted : [payload.data]).map(normalizeTracking);
      for (const update of updates)
        await ctx.runMutation(internal.orderTracking.apply, { update, cursor: null });
    }
    return json({ received: true });
  } catch {
    return json({ error: "InvalidTrackingPayload" }, 400);
  }
});
