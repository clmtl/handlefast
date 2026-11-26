import { v } from "convex/values";

export const translation = v.union(
  v.object({ state: v.literal("pending"), retryAt: v.number() }),
  v.object({ state: v.literal("original") }),
  v.object({ state: v.literal("translated"), text: v.string(), subject: v.optional(v.string()) }),
);

// Render the text alternative without loading any remote content.
export function emailBodyText(text?: string, html?: string) {
  return (
    text?.trim() ||
    html
      ?.replace(/<(head|style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<(?:br\b[^>]*|\/(?:p|div|tr|li))>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(
        /&(nbsp|amp|lt|gt|quot|#39);/g,
        (entity) =>
          ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[
            entity
          ] ?? entity,
      )
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim() ||
    ""
  );
}

export function clipEmailText(value: string, limit = 12000) {
  return value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
}
