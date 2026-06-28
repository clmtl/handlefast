import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { normalizeEmailAddress } from "./lib/inboundEmailRoutes";

const maxBodyLength = 120_000;
const maxHeaderCount = 80;
const maxHeaderValueLength = 4_000;
const maxReferenceCount = 20;
const maxAddressCount = 30;

const emailIdentityValidator = v.object({
  address: v.string(),
  name: v.optional(v.string()),
});

const emailHeaderValidator = v.object({
  name: v.string(),
  value: v.string(),
});

const attachmentSummaryValidator = v.object({
  filename: v.optional(v.string()),
  contentType: v.string(),
  size: v.number(),
  disposition: v.optional(v.union(v.literal("attachment"), v.literal("inline"))),
  contentId: v.optional(v.string()),
});

export const ingestFromWorker = internalMutation({
  args: {
    provider: v.literal("cloudflare_email_routing"),
    deliveryKey: v.string(),
    envelopeFrom: v.string(),
    envelopeTo: v.string(),
    from: emailIdentityValidator,
    to: v.array(emailIdentityValidator),
    cc: v.array(emailIdentityValidator),
    replyTo: v.array(emailIdentityValidator),
    subject: v.optional(v.string()),
    text: v.optional(v.string()),
    html: v.optional(v.string()),
    snippet: v.optional(v.string()),
    headers: v.array(emailHeaderValidator),
    messageId: v.optional(v.string()),
    inReplyTo: v.optional(v.string()),
    references: v.array(v.string()),
    attachments: v.array(attachmentSummaryValidator),
    receivedAt: v.number(),
    rawSize: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const deliveryKey = args.deliveryKey.trim();

    const existingDelivery = await ctx.db
      .query("inboundEmailDeliveries")
      .withIndex("by_deliveryKey", (q) => q.eq("deliveryKey", deliveryKey))
      .unique();

    if (existingDelivery) {
      return {
        status: "duplicate" as const,
        deliveryId: existingDelivery._id,
      };
    }

    const envelopeTo = normalizeEmailAddress(args.envelopeTo);
    const route = await ctx.db
      .query("inboundEmailRoutes")
      .withIndex("by_address", (q) => q.eq("address", envelopeTo))
      .unique();

    if (route?.status !== "active") {
      const messageId = normalizeOptionalString(args.messageId);
      const deliveryId = await ctx.db.insert("inboundEmailDeliveries", {
        provider: args.provider,
        deliveryKey,
        envelopeFrom: normalizeEmailAddress(args.envelopeFrom),
        envelopeTo,
        ...(messageId ? { messageId } : {}),
        receivedAt: args.receivedAt,
        rawSize: args.rawSize,
        status: "unmatched",
        error: "InboundEmailRouteNotFound",
        createdAt: now,
        updatedAt: now,
      });

      return {
        status: "unmatched" as const,
        deliveryId,
      };
    }

    const normalizedFrom = normalizeEmailIdentity(args.from, args.envelopeFrom);
    const customerEmail = normalizedFrom.address;
    const subject = normalizeOptionalString(args.subject);
    const messageId = normalizeOptionalString(args.messageId);
    const inReplyTo = normalizeOptionalString(args.inReplyTo);
    const references = normalizeReferences(args.references);
    const conversationId = await getOrCreateConversationId(ctx, {
      customerEmail,
      inReplyTo,
      now,
      references,
      route,
      subject,
    });

    const deliveryId = await ctx.db.insert("inboundEmailDeliveries", {
      organizationId: route.organizationId,
      shopId: route.shopId,
      routeId: route._id,
      provider: args.provider,
      deliveryKey,
      envelopeFrom: normalizeEmailAddress(args.envelopeFrom),
      envelopeTo,
      ...(messageId ? { messageId } : {}),
      receivedAt: args.receivedAt,
      rawSize: args.rawSize,
      status: "received",
      createdAt: now,
      updatedAt: now,
    });

    const text = truncateOptional(args.text, maxBodyLength);
    const html = truncateOptional(args.html, maxBodyLength);
    const snippet = buildSnippet(args.snippet, text, html);
    const attachmentSummaries = normalizeAttachmentSummaries(args.attachments);
    const supportMessageId = await ctx.db.insert("supportMessages", {
      organizationId: route.organizationId,
      shopId: route.shopId,
      conversationId,
      routeId: route._id,
      deliveryId,
      direction: "inbound",
      from: normalizedFrom,
      to: normalizeEmailIdentities(args.to, args.envelopeTo),
      cc: normalizeEmailIdentities(args.cc),
      replyTo: normalizeEmailIdentities(args.replyTo),
      ...(subject ? { subject } : {}),
      ...(text ? { text } : {}),
      ...(html ? { html } : {}),
      ...(snippet ? { snippet } : {}),
      headers: normalizeHeaders(args.headers),
      ...(messageId ? { messageId } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      references,
      receivedAt: args.receivedAt,
      rawSize: args.rawSize,
      attachmentCount: attachmentSummaries.length,
      createdAt: now,
      updatedAt: now,
    });

    for (const attachment of attachmentSummaries) {
      await ctx.db.insert("emailAttachments", {
        organizationId: route.organizationId,
        shopId: route.shopId,
        messageId: supportMessageId,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
        contentType: attachment.contentType,
        size: attachment.size,
        ...(attachment.disposition ? { disposition: attachment.disposition } : {}),
        ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
        createdAt: now,
      });
    }

    await ctx.db.patch(conversationId, {
      lastMessageAt: args.receivedAt,
      updatedAt: now,
    });

    return {
      status: "received" as const,
      deliveryId,
      conversationId,
      supportMessageId,
    };
  },
});

async function getOrCreateConversationId(
  ctx: MutationCtx,
  args: {
    route: Doc<"inboundEmailRoutes">;
    customerEmail: string;
    subject: string | null;
    inReplyTo: string | null;
    references: string[];
    now: number;
  },
) {
  const referencedMessageId = await getConversationIdByReferences(ctx, args.route.shopId, [
    args.inReplyTo,
    ...args.references,
  ]);

  if (referencedMessageId) {
    return referencedMessageId;
  }

  const recentConversations = await ctx.db
    .query("supportConversations")
    .withIndex("by_shopId_and_customerEmail", (q) =>
      q.eq("shopId", args.route.shopId).eq("customerEmail", args.customerEmail),
    )
    .order("desc")
    .take(10);
  const openConversation = recentConversations.find(
    (conversation) => conversation.status !== "closed",
  );

  if (openConversation) {
    return openConversation._id;
  }

  return await ctx.db.insert("supportConversations", {
    organizationId: args.route.organizationId,
    shopId: args.route.shopId,
    routeId: args.route._id,
    customerEmail: args.customerEmail,
    ...(args.subject ? { subject: args.subject } : {}),
    status: "open",
    lastMessageAt: args.now,
    createdAt: args.now,
    updatedAt: args.now,
  });
}

async function getConversationIdByReferences(
  ctx: MutationCtx,
  shopId: Id<"shops">,
  references: Array<string | null>,
) {
  for (const reference of references) {
    if (!reference) {
      continue;
    }

    const referencedMessages = await ctx.db
      .query("supportMessages")
      .withIndex("by_messageId", (q) => q.eq("messageId", reference))
      .take(1);
    const referencedMessage = referencedMessages[0];

    if (referencedMessage?.shopId === shopId) {
      return referencedMessage.conversationId;
    }
  }

  return null;
}

function normalizeEmailIdentity(value: { address: string; name?: string }, fallback = "") {
  const address = normalizeEmailAddress(value.address || fallback) || "unknown@unknown.invalid";
  const name = normalizeOptionalString(value.name);
  return {
    address,
    ...(name ? { name } : {}),
  };
}

function normalizeEmailIdentities(
  values: Array<{ address: string; name?: string }>,
  fallback = "",
) {
  const normalized = values
    .slice(0, maxAddressCount)
    .map((value) => normalizeEmailIdentity(value))
    .filter((value) => value.address !== "unknown@unknown.invalid");

  if (normalized.length > 0) {
    return normalized;
  }

  const fallbackAddress = normalizeEmailAddress(fallback);
  return fallbackAddress ? [{ address: fallbackAddress }] : [];
}

function normalizeHeaders(headers: Array<{ name: string; value: string }>) {
  return headers.slice(0, maxHeaderCount).map((header) => ({
    name: header.name.trim().toLowerCase().slice(0, 120),
    value: header.value.trim().slice(0, maxHeaderValueLength),
  }));
}

function normalizeReferences(references: string[]) {
  return references
    .map((reference) => reference.trim())
    .filter(Boolean)
    .slice(0, maxReferenceCount);
}

function normalizeAttachmentSummaries(
  attachments: Array<{
    filename?: string;
    contentType: string;
    size: number;
    disposition?: "attachment" | "inline";
    contentId?: string;
  }>,
) {
  return attachments.map((attachment) => {
    const filename = normalizeOptionalString(attachment.filename);
    const contentId = normalizeOptionalString(attachment.contentId);
    return {
      ...(filename ? { filename } : {}),
      contentType: attachment.contentType.trim() || "application/octet-stream",
      size: Math.max(0, Math.trunc(attachment.size)),
      ...(attachment.disposition ? { disposition: attachment.disposition } : {}),
      ...(contentId ? { contentId } : {}),
    };
  });
}

function normalizeOptionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function truncateOptional(value: string | undefined, maxLength: number) {
  const trimmed = normalizeOptionalString(value);
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function buildSnippet(snippet: string | undefined, text: string | null, html: string | null) {
  const source = normalizeOptionalString(snippet) ?? text ?? stripHtml(html ?? "");
  return source.replace(/\s+/g, " ").trim().slice(0, 240) || null;
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ");
}
