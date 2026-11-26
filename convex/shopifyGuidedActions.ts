import { ConvexError, v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, action } from "./_generated/server";
import { SHOPIFY_API_VERSION } from "./lib/commerceModel";
import { ORDERS_QUERY, providerJson, SHOP_QUERY, shopifyGraphql } from "./lib/commerceProviders";
import { decrypt, encrypt, sha256 } from "./lib/commerceSecrets";
import {
  beginDeviceAuthorization,
  createApp,
  GuidedShopifyError,
  getStoreOrganization,
  listOrganizations,
  pollDeviceAuthorization,
  recoverCreatedApp,
} from "./lib/shopifyGuidedClient";
import { parseOAuthCallback, verifyOAuthCallback } from "./lib/shopifyOAuth";

const refs = internal.shopifyGuided;
const context = (id: Id<"shopifyGuidedSessions">) => `shopify-guided:${id}`;
async function fail(
  ctx: ActionCtx,
  sessionId: Id<"shopifyGuidedSessions">,
  lease: string,
  error: unknown,
) {
  await ctx.runMutation(refs.failed, {
    sessionId,
    lease,
    code: error instanceof GuidedShopifyError ? error.code : "SHOPIFY_REQUEST_FAILED",
  });
}
export const start = action({
  args: { shopId: v.id("shops"), domain: v.string() },
  returns: v.id("shopifyGuidedSessions"),
  handler: async (ctx, args): Promise<Id<"shopifyGuidedSessions">> => {
    const sessionId = await ctx.runMutation(refs.reserve, args),
      lease = crypto.randomUUID();
    if (!(await ctx.runMutation(refs.claim, { sessionId, lease, phase: "initializing" })))
      return sessionId;
    try {
      const device = await beginDeviceAuthorization();
      await ctx.runMutation(refs.initialized, {
        sessionId,
        lease,
        secret: await encrypt(
          JSON.stringify({ deviceCode: device.deviceCode }),
          context(sessionId),
        ),
        userCode: device.userCode,
        verificationUrl: device.verificationUrl,
        expiresIn: device.expiresIn,
        intervalMs: device.interval * 1000,
      });
    } catch (error) {
      await fail(ctx, sessionId, lease, error);
    }
    return sessionId;
  },
});
export const poll = action({
  args: { sessionId: v.id("shopifyGuidedSessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const lease = crypto.randomUUID();
    if (!(await ctx.runMutation(refs.claim, { sessionId, lease, phase: "pending" }))) return null;
    try {
      const session = await ctx.runQuery(refs.readSession, { sessionId });
      if (!session.secret) throw new GuidedShopifyError("SHOPIFY_AUTH_EXPIRED");
      const { deviceCode } = z
        .object({ deviceCode: z.string() })
        .parse(JSON.parse(await decrypt(session.secret, context(sessionId))));
      const result = await pollDeviceAuthorization(deviceCode);
      if (result.status !== "authorized")
        await ctx.runMutation(refs.polled, {
          sessionId,
          lease,
          slowDown: result.status === "slow_down",
        });
      else
        await ctx.runMutation(refs.polled, {
          sessionId,
          lease,
          secret: await encrypt(
            JSON.stringify({
              managementToken: result.managementToken,
              businessToken: result.businessToken,
            }),
            context(sessionId),
          ),
        });
    } catch (error) {
      await fail(ctx, sessionId, lease, error);
    }
    return null;
  },
});
export const provision = action({
  args: { sessionId: v.id("shopifyGuidedSessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const lease = crypto.randomUUID();
    if (!(await ctx.runMutation(refs.claim, { sessionId, lease, phase: "provisioning" })))
      return null;
    try {
      const session = await ctx.runQuery(refs.readSession, { sessionId });
      if (!session.secret) throw new GuidedShopifyError("SHOPIFY_AUTH_EXPIRED");
      const tokens = z
        .object({ managementToken: z.string(), businessToken: z.string() })
        .parse(JSON.parse(await decrypt(session.secret, context(sessionId))));
      const organization = await getStoreOrganization(tokens.businessToken, session.domain);
      const allowed = await listOrganizations(tokens.businessToken);
      if (!allowed.some((org) => org.id === organization.id))
        throw new GuidedShopifyError("SHOPIFY_STORE_ORGANIZATION_UNAVAILABLE");
      const operation = await ctx.runMutation(refs.beginOperation, {
        sessionId,
        lease,
        shopifyOrganizationId: organization.id,
      });
      const app = operation.create
        ? await createApp(
            tokens.managementToken,
            organization.id,
            session.origin,
            SHOPIFY_API_VERSION,
            operation.appName,
          )
        : await recoverCreatedApp(
            tokens.managementToken,
            organization.id,
            operation.appName,
            operation.clientId,
          );
      await ctx.runMutation(refs.recordApp, { sessionId, lease, clientId: app.clientId });
      const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      await ctx.runMutation(refs.handoff, {
        sessionId,
        lease,
        clientId: app.clientId,
        secret: await encrypt(
          JSON.stringify({ clientId: app.clientId, clientSecret: app.apiSecretKey }),
          context(sessionId),
        ),
        state,
        oauthHash: await sha256(state),
      });
    } catch (error) {
      await fail(ctx, sessionId, lease, error);
    }
    return null;
  },
});
export const callback = action({
  args: { query: v.string() },
  returns: v.id("shops"),
  handler: async (ctx, args): Promise<Id<"shops">> => {
    const query = parseOAuthCallback(args.query),
      oauthHash = await sha256(query.state);
    const session = await ctx.runQuery(refs.callbackSession, { oauthHash });
    if (!session.secret || query.shop !== session.domain)
      throw new ConvexError("ShopifyInvalidCallback");
    const credentials = z
      .object({ clientId: z.string(), clientSecret: z.string() })
      .parse(JSON.parse(await decrypt(session.secret, context(session._id))));
    if (!(await verifyOAuthCallback(args.query, credentials.clientSecret)))
      throw new ConvexError("ShopifyInvalidCallback");
    const lease = crypto.randomUUID();
    if (
      !(await ctx.runMutation(refs.claim, { sessionId: session._id, lease, phase: "installing" }))
    )
      throw new ConvexError("ShopifyConnectionInProgress");
    try {
      const token = z
        .object({
          access_token: z.string().min(1).max(4096),
          scope: z.string(),
          expires_in: z.number().positive().optional(),
        })
        .parse(
          await providerJson(`https://${session.domain}/admin/oauth/access_token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_id: credentials.clientId,
              client_secret: credentials.clientSecret,
              code: query.code,
            }),
          }),
        );
      const scopes = token.scope.split(",").map((s) => s.trim());
      if (!scopes.includes("read_orders") || scopes.some((s) => s.startsWith("write_")))
        throw new Error("InvalidShopifyScopes");
      const data = z
        .object({ shop: z.object({ id: z.string(), myshopifyDomain: z.string() }) })
        .parse(await shopifyGraphql(session.domain, token.access_token, SHOP_QUERY));
      if (data.shop.myshopifyDomain !== session.domain) throw new Error("InvalidShopifyDomain");
      await shopifyGraphql(session.domain, token.access_token, ORDERS_QUERY, {
        query: "status:any",
        after: null,
      });
      return await ctx.runMutation(refs.complete, {
        sessionId: session._id,
        lease,
        oauthHash,
        clientId: credentials.clientId,
        shopifyShopId: data.shop.id,
        secret: await encrypt(credentials.clientSecret, `shopify:${session.shopId}`),
        token: await encrypt(token.access_token, `shopify:${session.shopId}`),
        tokenExpiresAt: Date.now() + Math.min(token.expires_in ?? 3600, 86400) * 1000,
        scopes,
      });
    } catch {
      await ctx.runMutation(refs.failed, {
        sessionId: session._id,
        lease,
        code: "SHOPIFY_INSTALL_FAILED",
      });
      throw new ConvexError("ShopifyInstallationFailed");
    }
  },
});
