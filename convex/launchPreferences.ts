import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const save = mutation({
  args: {
    email: v.string(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const [existingPreference] = await ctx.db
      .query("launchPreferences")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .take(1);

    if (existingPreference) {
      await ctx.db.patch(existingPreference._id, {
        createdAt: now,
        source: args.source ?? existingPreference.source,
      });

      return existingPreference._id;
    }

    return await ctx.db.insert("launchPreferences", {
      email: args.email,
      source: args.source ?? "starter",
      createdAt: now,
    });
  },
});

export const recent = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 5, 20);

    return await ctx.db
      .query("launchPreferences")
      .withIndex("by_createdAt")
      .order("desc")
      .take(limit);
  },
});
