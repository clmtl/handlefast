import agent from "@convex-dev/agent/convex.config";
import betterAuth from "@convex-dev/better-auth/convex.config";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({
  env: {
    AUTH_EMAIL_FROM: v.optional(v.string()),
    BETTER_AUTH_SECRET: v.string(),
    CLOUDFLARE_EMAIL_WEBHOOK_SECRET: v.optional(v.string()),
    EMAIL_ROUTE_NAMESPACE: v.optional(v.string()),
    GMAIL_OAUTH_CLIENT_ID: v.optional(v.string()),
    INBOUND_EMAIL_DOMAIN: v.optional(v.string()),
    REQUIRE_EMAIL_APPROVAL: v.optional(v.string()),
    RESEND_API_KEY: v.optional(v.string()),
    RESEND_SHOP_API_KEYS: v.optional(v.string()),
    VERIFIED_SHOP_SENDERS: v.optional(v.string()),
    SITE_URL: v.string(),
    LOCAL_TEST_ORIGINS: v.optional(v.string()),
    OPENAI_API_KEY: v.optional(v.string()),
    COMMERCE_ENCRYPTION_KEY: v.optional(v.string()),
    TRACK17_API_KEY: v.optional(v.string()),
    STOREFRONT_TRACKING_PILOT: v.optional(v.string()),
  },
});

app.use(betterAuth);
app.use(agent);

export default app;
