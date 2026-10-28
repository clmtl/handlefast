import { z } from "zod";
import { normalizedEmail, SHOPIFY_API_VERSION } from "./commerceModel";

export const ORDER_FIELDS = `
  id name email createdAt updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  totalRefundedSet { shopMoney { amount currencyCode } }
  shippingAddress { city countryCodeV2 zip }
  lineItems(first: 50) { nodes { id title quantity sku variantTitle } pageInfo { hasNextPage } }
  fulfillments(first: 10) { id status trackingInfo(first: 10) { number company } }
`;
export const ORDERS_QUERY = `query SupportOrders($query: String!, $after: String) {
  orders(first: 5, query: $query, after: $after, sortKey: UPDATED_AT, reverse: true) {
    nodes { ${ORDER_FIELDS} } pageInfo { hasNextPage endCursor }
  }
}`;
export const ORDER_QUERY = `query SupportOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`;
export const SHOP_QUERY = `query SupportShop { shop { id name myshopifyDomain } }`;

export async function providerJson(url: string, init: RequestInit) {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "ProviderRateLimited"
        : response.status === 401 || response.status === 403
          ? "ProviderAccessDenied"
          : "ProviderUnavailable",
    );
  const reader = response.body?.getReader();
  if (!reader) throw new Error("InvalidProviderResponse");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) {
        await reader.cancel();
        throw new Error("ProviderResponseTooLarge");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export async function shopifyGraphql(
  domain: string,
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
) {
  const result = z
    .object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() })
    .parse(
      await providerJson(`https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query, variables }),
      }),
    );
  if (
    result.errors?.some(
      (error) =>
        z.object({ extensions: z.object({ code: z.literal("THROTTLED") }) }).safeParse(error)
          .success,
    )
  )
    throw new Error("ProviderRateLimited");
  if (result.errors?.length || !result.data) throw new Error("ShopifyDataAccessDenied");
  return result.data;
}
export async function exchangeCredentials(domain: string, clientId: string, secret: string) {
  return z
    .object({
      access_token: z.string().min(1).max(4096),
      expires_in: z.number().positive().max(172800),
      scope: z.string(),
    })
    .parse(
      await providerJson(`https://${domain}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: secret,
        }).toString(),
      }),
    );
}
const money = z.object({
  shopMoney: z.object({ amount: z.string().max(50), currencyCode: z.string().max(10) }),
});
const orderSchema = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/),
  name: z.string().max(128),
  email: z.string().max(320).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  cancelledAt: z.string().nullable(),
  displayFinancialStatus: z.string().nullable(),
  displayFulfillmentStatus: z.string(),
  currentTotalPriceSet: money,
  totalRefundedSet: money,
  shippingAddress: z
    .object({
      city: z.string().nullable(),
      countryCodeV2: z.string().nullable(),
      zip: z.string().nullable(),
    })
    .nullable(),
  lineItems: z.object({
    nodes: z
      .array(
        z.object({
          id: z.string(),
          title: z.string().max(2000),
          quantity: z.number(),
          sku: z.string().nullable(),
          variantTitle: z.string().nullable(),
        }),
      )
      .max(50),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
  fulfillments: z
    .array(
      z.object({
        id: z.string(),
        status: z.string(),
        trackingInfo: z
          .array(z.object({ number: z.string().nullable(), company: z.string().nullable() }))
          .max(20),
      }),
    )
    .max(50),
});
export function normalizeOrder(raw: unknown) {
  const order = orderSchema.parse(raw);
  const tracking = order.fulfillments
    .filter((f) => f.status !== "CANCELLED" && f.status !== "ERROR" && f.status !== "FAILURE")
    .flatMap((f) =>
      f.trackingInfo
        .filter((t) => t.number && /^[a-z0-9 _-]{3,128}$/i.test(t.number))
        .map((t) => ({
          number: t.number?.trim() ?? "",
          company: (t.company ?? "").slice(0, 200),
          fulfillmentId: f.id,
        })),
    )
    .slice(0, 100);
  return {
    gid: order.id,
    name: order.name,
    email: normalizedEmail(order.email),
    placedAt: Date.parse(order.createdAt),
    sourceUpdatedAt: Date.parse(order.updatedAt),
    financialStatus: order.displayFinancialStatus ?? "UNKNOWN",
    fulfillmentStatus: order.displayFulfillmentStatus,
    cancelled: Boolean(order.cancelledAt),
    total: order.currentTotalPriceSet.shopMoney.amount,
    currency: order.currentTotalPriceSet.shopMoney.currencyCode,
    refunded: order.totalRefundedSet.shopMoney.amount,
    destination: order.shippingAddress
      ? {
          city: (order.shippingAddress.city ?? "").slice(0, 200),
          country: order.shippingAddress.countryCodeV2 ?? "",
          zip: (order.shippingAddress.zip ?? "").slice(0, 30),
        }
      : undefined,
    items: order.lineItems.nodes.map((i) => ({
      id: i.id,
      title: i.title,
      quantity: i.quantity,
      sku: (i.sku ?? "").slice(0, 200),
      variant: (i.variantTitle ?? "").slice(0, 200),
    })),
    detailsTruncated:
      order.lineItems.pageInfo.hasNextPage ||
      order.fulfillments.length === 10 ||
      order.fulfillments.some((f) => f.trackingInfo.length === 10) ||
      tracking.length === 100,
    tracking,
  };
}
export function parseOrders(raw: unknown) {
  const result = z
    .object({
      orders: z.object({
        nodes: z.array(z.unknown()).max(10),
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      }),
    })
    .parse(raw);
  return { orders: result.orders.nodes.map(normalizeOrder), ...result.orders.pageInfo };
}

const eventSchema = z.object({
  time_utc: z.string().nullish(),
  time_iso: z.string().nullish(),
  description: z.string().nullish(),
  location: z.string().nullish(),
});
export function normalizeTracking(raw: unknown) {
  const parsed = z
    .object({
      number: z.string().min(1).max(128),
      carrier: z.number().int().positive(),
      track_info: z
        .object({
          latest_status: z.object({ status: z.string().max(100) }).nullish(),
          latest_event: eventSchema.nullish(),
          tracking: z
            .object({
              providers: z
                .array(
                  z.object({
                    latest_sync_time: z.string().nullish(),
                    events: z.array(eventSchema).max(2000).nullish(),
                  }),
                )
                .max(20),
            })
            .nullish(),
        })
        .nullish(),
    })
    .parse(raw);
  const events = [
    ...(parsed.track_info?.tracking?.providers?.flatMap((p) => p.events ?? []) ?? []),
    ...(parsed.track_info?.latest_event ? [parsed.track_info.latest_event] : []),
  ].map((event) => {
    const date = event.time_utc ?? event.time_iso;
    const time = date && /(?:Z|[+-]\d\d:\d\d)$/.test(date) ? Date.parse(date) : Number.NaN;
    return {
      time: Number.isFinite(time) ? time : null,
      description: (event.description ?? "").slice(0, 2000),
      location: (event.location ?? "").slice(0, 500),
    };
  });
  const unique = [...new Map(events.map((e) => [JSON.stringify(e), e])).values()]
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    .slice(0, 50);
  const syncTimes =
    parsed.track_info?.tracking?.providers
      ?.map((p) => Date.parse(p.latest_sync_time ?? ""))
      .filter(Number.isFinite) ?? [];
  const eventAt = Math.max(...unique.map((e) => e.time ?? 0), ...syncTimes, 0) || undefined;
  return {
    number: parsed.number,
    carrier: parsed.carrier,
    status: parsed.track_info?.latest_status?.status ?? "NotFound",
    events: unique,
    eventAt,
  };
}
export async function track17(
  key: string,
  endpoint: "register" | "gettrackinfo",
  payload: unknown,
) {
  return z
    .object({
      code: z.number(),
      data: z
        .object({
          accepted: z.array(z.unknown()).max(40),
          rejected: z
            .array(z.object({ number: z.string(), error: z.object({ code: z.number() }) }))
            .max(40),
        })
        .optional(),
    })
    .parse(
      await providerJson(`https://api.17track.net/track/v2.4/${endpoint}`, {
        method: "POST",
        headers: { "17token": key, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
}
