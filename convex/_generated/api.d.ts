/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as http from "../http.js";
import type * as inboundEmailRoutes from "../inboundEmailRoutes.js";
import type * as inboundEmails from "../inboundEmails.js";
import type * as launchPreferences from "../launchPreferences.js";
import type * as lib_authorization from "../lib/authorization.js";
import type * as lib_inboundEmailRoutes from "../lib/inboundEmailRoutes.js";
import type * as lib_slugs from "../lib/slugs.js";
import type * as lib_webhookSignatures from "../lib/webhookSignatures.js";
import type * as onboarding from "../onboarding.js";
import type * as organizations from "../organizations.js";
import type * as shops from "../shops.js";
import type * as viewer from "../viewer.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  http: typeof http;
  inboundEmailRoutes: typeof inboundEmailRoutes;
  inboundEmails: typeof inboundEmails;
  launchPreferences: typeof launchPreferences;
  "lib/authorization": typeof lib_authorization;
  "lib/inboundEmailRoutes": typeof lib_inboundEmailRoutes;
  "lib/slugs": typeof lib_slugs;
  "lib/webhookSignatures": typeof lib_webhookSignatures;
  onboarding: typeof onboarding;
  organizations: typeof organizations;
  shops: typeof shops;
  viewer: typeof viewer;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
