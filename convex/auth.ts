import type { GenericCtx } from "@convex-dev/better-auth";
import { createClient } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { env, query } from "./_generated/server";
import authConfig from "./auth.config";

export const authComponent = createClient<DataModel>(components.betterAuth);

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth({
    baseURL: env.SITE_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: authComponent.adapter(ctx),
    emailVerification: {
      sendOnSignIn: true,
      sendOnSignUp: true,
      sendVerificationEmail,
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
    },
    plugins: [convex({ authConfig })],
  });
};

export const { getAuthUser } = authComponent.clientApi();

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    return await authComponent.getAuthUser(ctx);
  },
});

async function sendVerificationEmail({ user, url }: { user: { email: string }; url: string }) {
  const resendApiKey = env.RESEND_API_KEY;
  const emailFrom = env.AUTH_EMAIL_FROM;

  if (!resendApiKey || !emailFrom) {
    if (isLocalSiteUrl(env.SITE_URL)) {
      console.info(`Email verification link for ${user.email}: ${url}`);
      return;
    }

    throw new Error("Email verification delivery is not configured.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    body: JSON.stringify({
      from: emailFrom,
      html: `<p>Welcome to HandleFast.</p><p><a href="${url}">Verify your email</a> to finish signing in.</p>`,
      subject: "Verify your HandleFast email",
      text: `Verify your HandleFast email: ${url}`,
      to: user.email,
    }),
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to send verification email: ${response.status} ${body.slice(0, 200)}`);
  }
}

function isLocalSiteUrl(siteUrl: string) {
  return siteUrl.startsWith("http://localhost") || siteUrl.startsWith("http://127.0.0.1");
}
