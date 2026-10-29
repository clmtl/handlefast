import { z } from "zod";
import { shopifyGraphql } from "./commerceProviders";

export const SUPPORT_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "REFUNDS_CREATE",
  "ORDERS_FULFILLED",
  "ORDERS_PARTIALLY_FULFILLED",
  "APP_UNINSTALLED",
] as const;
export const WEBHOOKS_QUERY = `query SupportWebhooks($topics: [WebhookSubscriptionTopic!]) {
 webhookSubscriptions(first: 100, topics: $topics) { nodes { id topic uri } pageInfo { hasNextPage } }
}`;
export const WEBHOOK_CREATE = `mutation SupportWebhookCreate($topic: WebhookSubscriptionTopic!, $uri: String!) {
 webhookSubscriptionCreate(topic: $topic, webhookSubscription: {uri: $uri, format: JSON}) {
  webhookSubscription { id } userErrors { message }
 }
}`;
export async function configureSupportWebhooks(domain: string, token: string, uri: string) {
  const data = z
    .object({
      webhookSubscriptions: z.object({
        nodes: z.array(z.object({ id: z.string(), topic: z.string(), uri: z.string() })).max(100),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
      }),
    })
    .parse(await shopifyGraphql(domain, token, WEBHOOKS_QUERY, { topics: SUPPORT_TOPICS }));
  if (data.webhookSubscriptions.pageInfo.hasNextPage)
    throw new Error("ShopifyWebhookConfigurationFailed");
  for (const topic of SUPPORT_TOPICS) {
    if (data.webhookSubscriptions.nodes.some((w) => w.topic === topic && w.uri === uri)) continue;
    const created = z
      .object({
        webhookSubscriptionCreate: z.object({
          webhookSubscription: z.object({ id: z.string() }).nullable(),
          userErrors: z.array(z.object({ message: z.string() })),
        }),
      })
      .parse(await shopifyGraphql(domain, token, WEBHOOK_CREATE, { topic, uri }));
    if (
      !created.webhookSubscriptionCreate.webhookSubscription ||
      created.webhookSubscriptionCreate.userErrors.length
    )
      throw new Error("ShopifyWebhookConfigurationFailed");
  }
}
