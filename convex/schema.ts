import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  launchPreferences: defineTable({
    email: v.string(),
    source: v.string(),
    createdAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_createdAt", ["createdAt"]),
});
