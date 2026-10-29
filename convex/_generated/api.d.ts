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
import type * as automaticReplies from "../automaticReplies.js";
import type * as automaticReplyProcessing from "../automaticReplyProcessing.js";
import type * as automaticReplySettings from "../automaticReplySettings.js";
import type * as commerceAcceptance from "../commerceAcceptance.js";
import type * as commerceHttp from "../commerceHttp.js";
import type * as commerceMaintenance from "../commerceMaintenance.js";
import type * as crons from "../crons.js";
import type * as emailClassification from "../emailClassification.js";
import type * as emailClassificationProcessing from "../emailClassificationProcessing.js";
import type * as emailInbox from "../emailInbox.js";
import type * as emailProcessing from "../emailProcessing.js";
import type * as emailReceipts from "../emailReceipts.js";
import type * as emailRetention from "../emailRetention.js";
import type * as emailTriage from "../emailTriage.js";
import type * as http from "../http.js";
import type * as humanReviewProcessing from "../humanReviewProcessing.js";
import type * as humanReviews from "../humanReviews.js";
import type * as inboundEmailRoutes from "../inboundEmailRoutes.js";
import type * as inboundEmails from "../inboundEmails.js";
import type * as launchPreferences from "../launchPreferences.js";
import type * as lib_authorization from "../lib/authorization.js";
import type * as lib_automaticReplyModel from "../lib/automaticReplyModel.js";
import type * as lib_automaticReplyPolicy from "../lib/automaticReplyPolicy.js";
import type * as lib_commerceModel from "../lib/commerceModel.js";
import type * as lib_commerceProviders from "../lib/commerceProviders.js";
import type * as lib_commerceSecrets from "../lib/commerceSecrets.js";
import type * as lib_emailClassificationModel from "../lib/emailClassificationModel.js";
import type * as lib_emailClassificationPolicy from "../lib/emailClassificationPolicy.js";
import type * as lib_emailPolicy from "../lib/emailPolicy.js";
import type * as lib_emailReceiptValidators from "../lib/emailReceiptValidators.js";
import type * as lib_emailTriageModel from "../lib/emailTriageModel.js";
import type * as lib_emailTriagePolicy from "../lib/emailTriagePolicy.js";
import type * as lib_humanReviewContext from "../lib/humanReviewContext.js";
import type * as lib_humanReviewModel from "../lib/humanReviewModel.js";
import type * as lib_humanReviewPolicy from "../lib/humanReviewPolicy.js";
import type * as lib_inboundEmailRoutes from "../lib/inboundEmailRoutes.js";
import type * as lib_shopifyGuidedClient from "../lib/shopifyGuidedClient.js";
import type * as lib_shopifyGuidedModel from "../lib/shopifyGuidedModel.js";
import type * as lib_shopifyOAuth from "../lib/shopifyOAuth.js";
import type * as lib_shopifyWebhooks from "../lib/shopifyWebhooks.js";
import type * as lib_slugs from "../lib/slugs.js";
import type * as lib_webhookSignatures from "../lib/webhookSignatures.js";
import type * as onboarding from "../onboarding.js";
import type * as orderContext from "../orderContext.js";
import type * as orderTracking from "../orderTracking.js";
import type * as organizations from "../organizations.js";
import type * as shopifyConnection from "../shopifyConnection.js";
import type * as shopifyGuided from "../shopifyGuided.js";
import type * as shopifyGuidedActions from "../shopifyGuidedActions.js";
import type * as shopifySync from "../shopifySync.js";
import type * as shops from "../shops.js";
import type * as viewer from "../viewer.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  automaticReplies: typeof automaticReplies;
  automaticReplyProcessing: typeof automaticReplyProcessing;
  automaticReplySettings: typeof automaticReplySettings;
  commerceAcceptance: typeof commerceAcceptance;
  commerceHttp: typeof commerceHttp;
  commerceMaintenance: typeof commerceMaintenance;
  crons: typeof crons;
  emailClassification: typeof emailClassification;
  emailClassificationProcessing: typeof emailClassificationProcessing;
  emailInbox: typeof emailInbox;
  emailProcessing: typeof emailProcessing;
  emailReceipts: typeof emailReceipts;
  emailRetention: typeof emailRetention;
  emailTriage: typeof emailTriage;
  http: typeof http;
  humanReviewProcessing: typeof humanReviewProcessing;
  humanReviews: typeof humanReviews;
  inboundEmailRoutes: typeof inboundEmailRoutes;
  inboundEmails: typeof inboundEmails;
  launchPreferences: typeof launchPreferences;
  "lib/authorization": typeof lib_authorization;
  "lib/automaticReplyModel": typeof lib_automaticReplyModel;
  "lib/automaticReplyPolicy": typeof lib_automaticReplyPolicy;
  "lib/commerceModel": typeof lib_commerceModel;
  "lib/commerceProviders": typeof lib_commerceProviders;
  "lib/commerceSecrets": typeof lib_commerceSecrets;
  "lib/emailClassificationModel": typeof lib_emailClassificationModel;
  "lib/emailClassificationPolicy": typeof lib_emailClassificationPolicy;
  "lib/emailPolicy": typeof lib_emailPolicy;
  "lib/emailReceiptValidators": typeof lib_emailReceiptValidators;
  "lib/emailTriageModel": typeof lib_emailTriageModel;
  "lib/emailTriagePolicy": typeof lib_emailTriagePolicy;
  "lib/humanReviewContext": typeof lib_humanReviewContext;
  "lib/humanReviewModel": typeof lib_humanReviewModel;
  "lib/humanReviewPolicy": typeof lib_humanReviewPolicy;
  "lib/inboundEmailRoutes": typeof lib_inboundEmailRoutes;
  "lib/shopifyGuidedClient": typeof lib_shopifyGuidedClient;
  "lib/shopifyGuidedModel": typeof lib_shopifyGuidedModel;
  "lib/shopifyOAuth": typeof lib_shopifyOAuth;
  "lib/shopifyWebhooks": typeof lib_shopifyWebhooks;
  "lib/slugs": typeof lib_slugs;
  "lib/webhookSignatures": typeof lib_webhookSignatures;
  onboarding: typeof onboarding;
  orderContext: typeof orderContext;
  orderTracking: typeof orderTracking;
  organizations: typeof organizations;
  shopifyConnection: typeof shopifyConnection;
  shopifyGuided: typeof shopifyGuided;
  shopifyGuidedActions: typeof shopifyGuidedActions;
  shopifySync: typeof shopifySync;
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
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
};
