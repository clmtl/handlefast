import betterAuth from "@convex-dev/better-auth/convex.config";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({
  env: {
    AUTH_EMAIL_FROM: v.optional(v.string()),
    BETTER_AUTH_SECRET: v.string(),
    CLOUDFLARE_EMAIL_WEBHOOK_SECRET: v.optional(v.string()),
    INBOUND_EMAIL_DOMAIN: v.optional(v.string()),
    RESEND_API_KEY: v.optional(v.string()),
    SITE_URL: v.string(),
  },
});

app.use(betterAuth);

export default app;
