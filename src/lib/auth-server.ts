import { convexBetterAuthReactStart } from "@convex-dev/better-auth/react-start";

const convexUrl = import.meta.env.VITE_CONVEX_URL;
const convexSiteUrl = import.meta.env.VITE_CONVEX_SITE_URL;

if (!convexUrl) {
  throw new Error("Missing VITE_CONVEX_URL for Better Auth server integration.");
}

if (!convexSiteUrl) {
  throw new Error("Missing VITE_CONVEX_SITE_URL for Better Auth server integration.");
}

export const { fetchAuthAction, fetchAuthMutation, fetchAuthQuery, getToken, handler } =
  convexBetterAuthReactStart({
    convexSiteUrl,
    convexUrl,
  });
