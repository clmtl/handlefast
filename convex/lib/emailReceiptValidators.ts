import { v } from "convex/values";
import { classificationValidator } from "./emailClassificationPolicy";
import { triageDecision } from "./emailTriagePolicy";
import { humanReviewValidator } from "./humanReviewPolicy";

export const receiptStatus = v.union(
  v.literal("uploading"),
  v.literal("queued"),
  v.literal("processing"),
  v.literal("failed"),
  v.literal("processed"),
  v.literal("paused"),
);
export const receiptFields = {
  organizationId: v.id("organizations"),
  shopId: v.id("shops"),
  routeId: v.id("inboundEmailRoutes"),
  key: v.string(),
  envelopeFrom: v.string(),
  envelopeTo: v.string(),
  sha256: v.string(),
  rawSize: v.number(),
  rawStorageId: v.optional(v.id("_storage")),
  status: receiptStatus,
  receivedAt: v.number(),
  expiresAt: v.number(),
  attempts: v.number(),
  nextAttemptAt: v.number(),
  error: v.optional(v.string()),
  updatedAt: v.number(),
  triage: v.optional(triageDecision),
  automaticTriage: v.optional(triageDecision),
  triageUpdatedAt: v.optional(v.number()),
  triageUpdatedBy: v.optional(v.id("profiles")),
  classification: v.optional(classificationValidator),
  automaticClassification: v.optional(classificationValidator),
  classificationUpdatedAt: v.optional(v.number()),
  classificationUpdatedBy: v.optional(v.id("profiles")),
  humanReview: v.optional(humanReviewValidator),
  autoReplyEligibility: v.optional(v.object({ eligible: v.boolean(), revision: v.number() })),
  automaticReplySuppressed: v.optional(v.boolean()),
  classificationJob: v.optional(
    v.object({
      token: v.string(),
      requestedAt: v.number(),
      startedAt: v.optional(v.number()),
    }),
  ),
};
export const receiptDoc = v.object({
  _id: v.id("emailReceipts"),
  _creationTime: v.number(),
  ...receiptFields,
});
