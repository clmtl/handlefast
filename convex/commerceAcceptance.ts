// Operator-only acceptance checks. Never available to clients or production.
import { ConvexError, v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import { env, internalAction, internalMutation } from "./_generated/server";
import { SHOP_QUERY, shopifyGraphql } from "./lib/commerceProviders";
import { decrypt } from "./lib/commerceSecrets";
import { accessToken } from "./shopifySync";

function requireStaging() {
  if (env.SITE_URL !== "https://handlefast-staging.bk201li.workers.dev")
    throw new ConvexError("StagingAcceptanceOnly");
}

export const renewShopifyAccess = internalAction({
  args: { connectionId: v.id("shopifyConnections") },
  returns: v.object({ renewed: v.boolean(), shopMatches: v.boolean(), expiresAt: v.number() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ renewed: boolean; shopMatches: boolean; expiresAt: number }> => {
    requireStaging();
    const row = await ctx.runQuery(internal.shopifyConnection.credentials, args);
    if (!row) throw new ConvexError("ShopifyDisconnected");
    // Exercise the real renewal branch without expiring the stored token first.
    // If Shopify rejects renewal, the existing working token remains intact.
    const token = await accessToken(ctx, { ...row, tokenExpiresAt: 0 });
    const { shop } = z
      .object({ shop: z.object({ id: z.string(), myshopifyDomain: z.string() }) })
      .parse(await shopifyGraphql(row.domain, token, SHOP_QUERY));
    const saved = await ctx.runQuery(internal.shopifyConnection.credentials, args);
    if (
      !saved ||
      saved.generation !== row.generation ||
      (await decrypt(saved.token, `shopify:${row.shopId}`)) !== token
    )
      throw new ConvexError("ShopifyConnectionChanged");
    if (shop.myshopifyDomain !== row.domain || shop.id !== row.shopifyShopId)
      throw new ConvexError("ShopifyDomainMismatch");
    return { renewed: true, shopMatches: true, expiresAt: saved.tokenExpiresAt };
  },
});

export const expireFixtures = internalMutation({
  args: { runId: v.string(), receiptIds: v.array(v.id("emailReceipts")) },
  returns: v.number(),
  handler: async (ctx, { runId, receiptIds }) => {
    requireStaging();
    if (!/^[a-f0-9-]{36}$/.test(runId) || receiptIds.length > 3)
      throw new ConvexError("InvalidAcceptanceRun");
    let count = 0;
    for (const receiptId of new Set(receiptIds)) {
      const receipt = await ctx.db.get(receiptId);
      if (!receipt) continue;
      const message = await ctx.db
        .query("supportMessages")
        .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
        .unique();
      if (
        !message?.subject?.startsWith("HF-QA Feature4 ") ||
        !message.headers.some(
          (h) => h.name.toLowerCase() === "x-handlefast-acceptance" && h.value === runId,
        )
      )
        throw new ConvexError("AcceptanceFixtureRequired");
      await ctx.db.patch(receiptId, { expiresAt: Date.now(), updatedAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.emailRetention.expireReceipt, { receiptId });
      count++;
    }
    return count;
  },
});
