import { v } from "convex/values";
import { triageDecision } from "./emailTriagePolicy";

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
};
export const receiptDoc = v.object({
  _id: v.id("emailReceipts"),
  _creationTime: v.number(),
  ...receiptFields,
});
