import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  env,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import { assertCanManageOrganization, requireShopMembership } from "./lib/authorization";
import { shopDomain } from "./lib/commerceModel";
import { guidedDoc, guidedPublic, SHOPIFY_APP_NAME_MAX_LENGTH } from "./lib/shopifyGuidedModel";
import { storeConnection } from "./shopifyConnection";

async function owned(ctx: QueryCtx | MutationCtx, id: Id<"shopifyGuidedSessions">) {
  const session = await ctx.db.get(id);
  if (!session) throw new ConvexError("ShopifySessionUnavailable");
  const { membership, profile, shop } = await requireShopMembership(ctx, session.shopId);
  assertCanManageOrganization(membership);
  if (
    session.profileId !== profile._id ||
    session.organizationId !== shop.organizationId ||
    shop.status === "disabled"
  )
    throw new ConvexError("Forbidden");
  return session;
}
export const reserve = internalMutation({
  args: { shopId: v.id("shops"), domain: v.string() },
  returns: v.id("shopifyGuidedSessions"),
  handler: async (ctx, args) => {
    const { membership, profile, shop } = await requireShopMembership(ctx, args.shopId);
    assertCanManageOrganization(membership);
    if (shop.status === "disabled") throw new ConvexError("ShopDisabled");
    if (!env.COMMERCE_ENCRYPTION_KEY) throw new ConvexError("CommerceEncryptionNotConfigured");
    const domain = shopDomain(args.domain);
    const connected = await ctx.db
      .query("shopifyConnections")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .unique();
    if (connected && connected.shopId !== shop._id) throw new ConvexError("ShopAlreadyConnected");
    const recent = await ctx.db
      .query("shopifyGuidedSessions")
      .withIndex("by_profileId", (q) => q.eq("profileId", profile._id))
      .order("desc")
      .take(5);
    const active = recent.find(
      (s) =>
        s.shopId === shop._id &&
        s.domain === domain &&
        s.expiresAt > Date.now() &&
        !["error", "connected"].includes(s.status),
    );
    if (active) return active._id;
    if (recent.length === 5 && recent[4]._creationTime > Date.now() - 60_000)
      throw new ConvexError("ShopifyRateLimited");
    const previous = await ctx.db
      .query("shopifyGuidedSessions")
      .withIndex("by_shopId", (q) => q.eq("shopId", shop._id))
      .order("desc")
      .take(50);
    if (
      previous.some(
        (s) =>
          ["provisioning", "installing"].includes(s.status) && (s.leaseUntil ?? 0) > Date.now(),
      )
    )
      throw new ConvexError("ShopifyConnectionInProgress");
    for (const s of previous)
      if (s.status !== "connected")
        await ctx.db.patch(s._id, {
          status: "error",
          secret: undefined,
          oauthHash: undefined,
          authorizationUrl: undefined,
          errorCode: "SHOPIFY_AUTH_CANCELLED",
        });
    const origin = new URL(env.SITE_URL).origin;
    const id = await ctx.db.insert("shopifyGuidedSessions", {
      shopId: shop._id,
      organizationId: shop.organizationId,
      profileId: profile._id,
      domain,
      origin,
      status: "initializing",
      expiresAt: Date.now() + 20 * 60_000,
      nextPollAt: 0,
      intervalMs: 5000,
    });
    await ctx.scheduler.runAfter(21 * 60_000, internal.shopifyGuided.expire, { sessionId: id });
    return id;
  },
});
export const get = query({
  args: { sessionId: v.id("shopifyGuidedSessions") },
  returns: v.union(v.null(), guidedPublic),
  handler: async (ctx, { sessionId }) => {
    const saved = await ctx.db.get(sessionId);
    if (!saved) return null;
    const { profile } = await requireShopMembership(ctx, saved.shopId);
    if (profile._id !== saved.profileId) return null;
    const s = await owned(ctx, sessionId);
    const expired = s.expiresAt <= Date.now();
    return {
      id: s._id,
      domain: s.domain,
      status: expired ? ("error" as const) : s.status,
      expiresAt: s.expiresAt,
      nextPollAt: s.nextPollAt,
      leaseUntil: s.leaseUntil,
      userCode: s.userCode,
      verificationUrl: expired ? undefined : s.verificationUrl,
      authorizationUrl: expired ? undefined : s.authorizationUrl,
      errorCode: expired ? "SHOPIFY_AUTH_EXPIRED" : s.errorCode,
    };
  },
});
export const readSession = internalQuery({
  args: { sessionId: v.id("shopifyGuidedSessions") },
  returns: guidedDoc,
  handler: async (ctx, args) => owned(ctx, args.sessionId),
});
export const claim = internalMutation({
  args: {
    sessionId: v.id("shopifyGuidedSessions"),
    lease: v.string(),
    phase: v.union(
      v.literal("initializing"),
      v.literal("pending"),
      v.literal("provisioning"),
      v.literal("installing"),
    ),
  },
  returns: v.boolean(),
  handler: async (ctx, { sessionId, lease, phase }) => {
    const s = await owned(ctx, sessionId),
      now = Date.now();
    const eligible =
      phase === "provisioning"
        ? ["authorized", "provisioning"]
        : phase === "installing"
          ? ["ready", "installing"]
          : [phase];
    if (
      s.expiresAt <= now ||
      !eligible.includes(s.status) ||
      (s.leaseUntil ?? 0) > now ||
      (phase === "pending" && s.nextPollAt > now)
    )
      return false;
    if (phase === "provisioning" && s.expiresAt - now < 150_000)
      throw new ConvexError("ShopifySessionExpired");
    await ctx.db.patch(s._id, {
      lease,
      leaseUntil: now + 180_000,
      nextPollAt: now + s.intervalMs,
      ...(["provisioning", "installing"].includes(phase) ? { status: phase } : {}),
      errorCode: undefined,
    });
    return true;
  },
});
export const initialized = internalMutation({
  args: {
    sessionId: v.id("shopifyGuidedSessions"),
    lease: v.string(),
    secret: v.string(),
    userCode: v.string(),
    verificationUrl: v.string(),
    expiresIn: v.number(),
    intervalMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const s = await owned(ctx, args.sessionId);
    if (s.lease !== args.lease || s.status !== "initializing" || s.expiresAt <= Date.now())
      return null;
    await ctx.db.patch(s._id, {
      status: "pending",
      secret: args.secret,
      userCode: args.userCode,
      verificationUrl: args.verificationUrl,
      expiresAt: Math.min(s.expiresAt, Date.now() + args.expiresIn * 1000),
      intervalMs: args.intervalMs,
      nextPollAt: Date.now() + args.intervalMs,
      lease: undefined,
      leaseUntil: undefined,
    });
    return null;
  },
});
export const polled = internalMutation({
  args: {
    sessionId: v.id("shopifyGuidedSessions"),
    lease: v.string(),
    secret: v.optional(v.string()),
    slowDown: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const s = await owned(ctx, args.sessionId);
    if (s.lease !== args.lease || s.status !== "pending" || s.expiresAt <= Date.now()) return null;
    const intervalMs = s.intervalMs + (args.slowDown ? 5000 : 0);
    await ctx.db.patch(s._id, {
      ...(args.secret ? { secret: args.secret, status: "authorized" as const } : {}),
      intervalMs,
      nextPollAt: Date.now() + intervalMs,
      lease: undefined,
      leaseUntil: undefined,
    });
    return null;
  },
});
export const beginOperation = internalMutation({
  args: {
    sessionId: v.id("shopifyGuidedSessions"),
    lease: v.string(),
    shopifyOrganizationId: v.string(),
  },
  returns: v.object({ appName: v.string(), clientId: v.optional(v.string()), create: v.boolean() }),
  handler: async (ctx, args) => {
    const s = await owned(ctx, args.sessionId);
    if (
      s.status !== "provisioning" ||
      s.lease !== args.lease ||
      (s.leaseUntil ?? 0) <= Date.now() ||
      s.expiresAt <= Date.now()
    )
      throw new ConvexError("ShopifySessionChanged");
    const previous = await ctx.db
      .query("shopifyGuidedOperations")
      .withIndex("by_domain", (q) => q.eq("domain", s.domain))
      .unique();
    if (
      previous &&
      (previous.shopId !== s.shopId ||
        previous.shopifyOrganizationId !== args.shopifyOrganizationId)
    )
      throw new ConvexError("ShopAlreadyConnected");
    if (previous && previous.leaseUntil > Date.now() && previous.lease !== args.lease)
      throw new ConvexError("ShopifyConnectionInProgress");
    // Keep names stable after an ambiguous attempt: the app may already exist.
    // A confirmed rejection can safely replace an invalid name from an older version.
    const appName =
      previous &&
      (previous.creationAttempted ||
        previous.clientId ||
        previous.appName.length <= SHOPIFY_APP_NAME_MAX_LENGTH)
        ? previous.appName
        : `HandleFast ${crypto.randomUUID().replaceAll("-", "")}`.slice(
            0,
            SHOPIFY_APP_NAME_MAX_LENGTH,
          );
    const data = {
      shopId: s.shopId,
      domain: s.domain,
      shopifyOrganizationId: args.shopifyOrganizationId,
      appName,
      creationAttempted: true,
      sessionId: s._id,
      lease: args.lease,
      leaseUntil: s.leaseUntil ?? 0,
    };
    const operationId = previous?._id ?? (await ctx.db.insert("shopifyGuidedOperations", data));
    if (previous) await ctx.db.patch(previous._id, data);
    await ctx.db.patch(s._id, { operationId });
    return { appName, clientId: previous?.clientId, create: !previous?.creationAttempted };
  },
});
async function checked(ctx: MutationCtx, sessionId: Id<"shopifyGuidedSessions">, lease: string) {
  const s = await owned(ctx, sessionId),
    op = s.operationId ? await ctx.db.get(s.operationId) : null;
  if (
    s.status !== "provisioning" ||
    s.lease !== lease ||
    s.expiresAt <= Date.now() ||
    !op ||
    op.sessionId !== s._id ||
    op.lease !== lease ||
    op.leaseUntil <= Date.now()
  )
    throw new ConvexError("ShopifySessionChanged");
  return { s, op };
}
export const recordApp = internalMutation({
  args: { sessionId: v.id("shopifyGuidedSessions"), lease: v.string(), clientId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { op } = await checked(ctx, args.sessionId, args.lease);
    if (op.clientId && op.clientId !== args.clientId)
      throw new ConvexError("ShopifySessionChanged");
    await ctx.db.patch(op._id, { clientId: args.clientId });
    return null;
  },
});
export const handoff = internalMutation({
  args: {
    sessionId: v.id("shopifyGuidedSessions"),
    lease: v.string(),
    clientId: v.string(),
    secret: v.string(),
    state: v.string(),
    oauthHash: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { s, op } = await checked(ctx, args.sessionId, args.lease);
    if (op.clientId !== args.clientId) throw new ConvexError("ShopifySessionChanged");
    const handle = s.domain.slice(0, -".myshopify.com".length);
    const url = new URL(`https://admin.shopify.com/store/${handle}/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: args.clientId,
      scope: "read_orders",
      redirect_uri: `${s.origin}/auth/shopify/callback`,
      state: args.state,
    }).toString();
    // Shopify otherwise silently reuses its current admin account, which may differ
    // from the account that approved the CLI and have no access to this store.
    const login = new URL("https://admin.shopify.com/login");
    login.searchParams.set("returnPath", `${url.pathname}${url.search}`);
    await ctx.db.patch(s._id, {
      status: "ready",
      secret: args.secret,
      oauthHash: args.oauthHash,
      authorizationUrl: login.href,
      expiresAt: Date.now() + 10 * 60_000,
      lease: undefined,
      leaseUntil: undefined,
    });
    await ctx.db.patch(op._id, { leaseUntil: 0 });
    return null;
  },
});
export const callbackSession = internalQuery({
  args: { oauthHash: v.string() },
  returns: guidedDoc,
  handler: async (ctx, { oauthHash }) => {
    const s = await ctx.db
      .query("shopifyGuidedSessions")
      .withIndex("by_oauthHash", (q) => q.eq("oauthHash", oauthHash))
      .unique();
    if (!s || s.expiresAt <= Date.now() || !["ready", "installing"].includes(s.status))
      throw new ConvexError("ShopifySessionExpired");
    return owned(ctx, s._id);
  },
});
export const complete = internalMutation({
  args: {
    sessionId: v.id("shopifyGuidedSessions"),
    lease: v.string(),
    oauthHash: v.string(),
    clientId: v.string(),
    shopifyShopId: v.string(),
    secret: v.string(),
    token: v.string(),
    tokenExpiresAt: v.number(),
    scopes: v.array(v.string()),
  },
  returns: v.id("shops"),
  handler: async (ctx, args) => {
    const s = await owned(ctx, args.sessionId),
      op = s.operationId ? await ctx.db.get(s.operationId) : null;
    if (
      s.status !== "installing" ||
      s.lease !== args.lease ||
      (s.leaseUntil ?? 0) <= Date.now() ||
      s.expiresAt <= Date.now() ||
      s.oauthHash !== args.oauthHash ||
      op?.clientId !== args.clientId
    )
      throw new ConvexError("ShopifySessionChanged");
    const { sessionId: _, lease: __, oauthHash: ___, ...credentials } = args;
    await storeConnection(ctx, {
      ...credentials,
      shopId: s.shopId,
      organizationId: s.organizationId,
      domain: s.domain,
    });
    await ctx.db.patch(s._id, {
      status: "connected",
      secret: undefined,
      oauthHash: undefined,
      authorizationUrl: undefined,
      verificationUrl: undefined,
      userCode: undefined,
      lease: undefined,
      leaseUntil: undefined,
    });
    return s.shopId;
  },
});
export const failed = internalMutation({
  args: { sessionId: v.id("shopifyGuidedSessions"), lease: v.string(), code: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const s = await owned(ctx, args.sessionId);
    if (s.lease !== args.lease) return null;
    const op = s.operationId ? await ctx.db.get(s.operationId) : null;
    if (op?.sessionId === s._id && op.lease === args.lease)
      await ctx.db.patch(op._id, {
        leaseUntil: 0,
        ...(args.code === "SHOPIFY_APP_CREATE_REJECTED" && !op.clientId
          ? { creationAttempted: false }
          : {}),
      });
    await ctx.db.patch(s._id, {
      status: s.status === "installing" ? "ready" : "error",
      errorCode: args.code,
      ...(s.status !== "installing"
        ? { secret: undefined, oauthHash: undefined, authorizationUrl: undefined }
        : {}),
      lease: undefined,
      leaseUntil: undefined,
    });
    return null;
  },
});
export const cancel = mutation({
  args: { sessionId: v.id("shopifyGuidedSessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const s = await owned(ctx, args.sessionId);
    if (["provisioning", "installing"].includes(s.status) && (s.leaseUntil ?? 0) > Date.now())
      throw new ConvexError("ShopifyConnectionInProgress");
    await ctx.db.patch(s._id, {
      status: "error",
      errorCode: "SHOPIFY_AUTH_CANCELLED",
      secret: undefined,
      oauthHash: undefined,
      authorizationUrl: undefined,
      verificationUrl: undefined,
      lease: undefined,
      leaseUntil: undefined,
    });
    return null;
  },
});
export const expire = internalMutation({
  args: { sessionId: v.id("shopifyGuidedSessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const s = await ctx.db.get(sessionId);
    if (s && s.expiresAt <= Date.now()) await ctx.db.delete(s._id);
    else if (s)
      await ctx.scheduler.runAfter(s.expiresAt - Date.now() + 1, internal.shopifyGuided.expire, {
        sessionId,
      });
    return null;
  },
});
export const expireDue = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("shopifyGuidedSessions")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now()))
      .take(100);
    for (const s of rows) await ctx.db.delete(s._id);
    return null;
  },
});
