import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export function normalizeShopLocale(value: string) {
  if (value.length > 64) return null;
  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

export function supportedEmailLanguage(
  locale: string | null | undefined,
): "fr" | "en" | "es" | "de" | null {
  const language = locale?.split("-")[0];
  return language === "fr" || language === "en" || language === "es" || language === "de"
    ? language
    : null;
}

export async function shopLocale(ctx: MutationCtx | QueryCtx, shopId: Id<"shops">) {
  const connection = await ctx.db
    .query("shopifyConnections")
    .withIndex("by_shopId", (q) => q.eq("shopId", shopId))
    .unique();
  return connection?.status === "active" ? (connection.primaryLocale ?? null) : null;
}
