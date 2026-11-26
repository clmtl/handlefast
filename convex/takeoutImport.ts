import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { getOrCreateConversationId } from "./inboundEmails";
import { assertCanManageOrganization, requireShopMembership } from "./lib/authorization";
import { suppressAutoResponse, validMailbox } from "./lib/automaticReplyPolicy";
import { emailExpiresAt } from "./lib/emailPolicy";
import { shopifyContactAddress } from "./lib/shopifyContact";

const identity = v.object({ address: v.string(), name: v.optional(v.string()) });
const field = v.optional(v.string());
const direction = v.union(v.literal("inbound"), v.literal("outbound"));

export const shopAddress = internalQuery({
  args: { shop: v.string() },
  returns: v.string(),
  handler: async (ctx, { shop: value }) => {
    const id = ctx.db.normalizeId("shops", value);
    if (!id) throw new ConvexError("ShopUnavailable");
    const { shop, membership } = await requireShopMembership(ctx, id);
    assertCanManageOrganization(membership);
    if (!shop.supportEmail || shop.status === "disabled") throw new ConvexError("ShopUnavailable");
    return shop.supportEmail;
  },
});

export const commit = internalMutation({
  args: {
    shopId: v.id("shops"),
    supportEmail: v.string(),
    rawStorageId: v.id("_storage"),
    sha256: v.string(),
    rawSize: v.number(),
    source: v.optional(v.union(v.literal("takeout"), v.literal("gmail"))),
    gmailThreadId: field,
    date: v.number(),
    direction,
    from: identity,
    to: v.array(identity),
    cc: v.array(identity),
    replyTo: v.array(identity),
    subject: field,
    text: field,
    snippet: field,
    messageId: field,
    inReplyTo: field,
    references: v.array(v.string()),
    headers: v.array(v.object({ name: v.string(), value: v.string() })),
    attachmentCount: v.number(),
  },
  returns: v.union(v.literal("imported"), v.literal("duplicate"), v.literal("skipped")),
  handler: async (ctx, args) => {
    const { shop, membership } = await requireShopMembership(ctx, args.shopId);
    assertCanManageOrganization(membership);
    if (shop.supportEmail !== args.supportEmail || shop.status === "disabled")
      throw new ConvexError("ShopUnavailable");
    const route = await ctx.db
      .query("inboundEmailRoutes")
      .withIndex("by_shopId_and_status", (q) => q.eq("shopId", shop._id).eq("status", "active"))
      .first();
    if (!route) throw new ConvexError("ReceptionDisabled");

    const now = Date.now();
    const source = args.source ?? "takeout";
    const receivedAt = Math.min(args.date, now);
    const expiresAt = emailExpiresAt(receivedAt);
    const incoming = args.direction === "inbound";
    const recipients = [...args.to, ...args.cc];
    const customer = incoming
      ? (shopifyContactAddress(args) ?? args.from.address)
      : recipients.find((item) => item.address !== shop.supportEmail)?.address;
    if (
      !Number.isFinite(receivedAt) ||
      expiresAt <= now ||
      !customer ||
      !validMailbox(customer) ||
      (incoming
        ? !recipients.some((item) => item.address === shop.supportEmail)
        : args.from.address !== shop.supportEmail)
    )
      return "skipped";

    const key = `takeout:${shop._id}:${args.sha256}`;
    const duplicate = args.messageId
      ? await ctx.db
          .query("supportMessages")
          .withIndex("by_shopId_and_messageId", (q) =>
            q.eq("shopId", shop._id).eq("messageId", args.messageId),
          )
          .first()
      : null;
    const automatic =
      suppressAutoResponse(args.headers) ||
      /(?:no-?reply|mailer-daemon|postmaster)(?:[+._-][^@]*)?@/i.test(args.from.address);
    const originalReceipt = duplicate
      ? null
      : await ctx.db
          .query("emailReceipts")
          .withIndex("by_key", (q) => q.eq("key", key))
          .first();
    const existing =
      duplicate ??
      (originalReceipt
        ? await ctx.db
            .query("supportMessages")
            .withIndex("by_receiptId", (q) => q.eq("receiptId", originalReceipt._id))
            .first()
        : null);
    const sameThread =
      !automatic && args.gmailThreadId
        ? await gmailConversation(ctx, shop._id, args.gmailThreadId, customer)
        : null;
    if (existing || originalReceipt) {
      if (existing && args.gmailThreadId)
        await ctx.db.patch(existing._id, {
          gmailThreadId: args.gmailThreadId,
          ...(sameThread && existing.direction === "outbound"
            ? { conversationId: sameThread }
            : {}),
        });
      return "duplicate";
    }
    const conversationId = !automatic
      ? (sameThread ??
        (await getOrCreateConversationId(ctx, {
          route,
          customerEmail: customer,
          inReplyTo: args.inReplyTo ?? null,
          references: args.references,
          subject: args.subject ?? null,
          receivedAt,
          now,
        })))
      : undefined;
    const previous = conversationId
      ? await ctx.db
          .query("supportMessages")
          .withIndex("by_conversationId_and_receivedAt", (q) =>
            q.eq("conversationId", conversationId),
          )
          .order("desc")
          .first()
      : null;
    const isLatest =
      !previous ||
      previous.receivedAt < receivedAt ||
      (previous.receivedAt === receivedAt && !incoming);
    const receiptId = await ctx.db.insert("emailReceipts", {
      organizationId: shop.organizationId,
      shopId: shop._id,
      routeId: route._id,
      key,
      envelopeFrom: args.from.address,
      envelopeTo: route.address,
      sha256: args.sha256,
      rawSize: args.rawSize,
      rawStorageId: args.rawStorageId,
      status: "processed",
      receivedAt,
      expiresAt,
      attempts: 0,
      nextAttemptAt: now,
      updatedAt: now,
      source,
      autoReplyEligibility: { eligible: false, revision: 0 },
      automaticReplySuppressed: automatic,
      triage: {
        bucket: incoming && !automatic ? "sav" : "other",
        reason: source,
        source: "rules",
        version: 1,
      },
      ...(incoming && !automatic
        ? {
            humanReview: {
              status: isLatest ? ("open" as const) : ("resolved" as const),
              reason: "auto_reply_disabled" as const,
              createdAt: now,
              updatedAt: now,
            },
          }
        : {}),
    });
    const deliveryId = await ctx.db.insert("inboundEmailDeliveries", {
      organizationId: shop.organizationId,
      shopId: shop._id,
      routeId: route._id,
      receiptId,
      provider: source === "gmail" ? "gmail_api" : "google_takeout",
      deliveryKey: key,
      envelopeFrom: args.from.address,
      envelopeTo: route.address,
      messageId: args.messageId,
      receivedAt,
      rawSize: args.rawSize,
      status: "received",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("supportMessages", {
      organizationId: shop.organizationId,
      shopId: shop._id,
      routeId: route._id,
      conversationId,
      deliveryId,
      receiptId,
      expiresAt,
      gmailThreadId: args.gmailThreadId,
      direction: args.direction,
      from: args.from,
      to: args.to,
      cc: args.cc,
      replyTo: args.replyTo,
      subject: args.subject,
      text: args.text,
      snippet: args.snippet,
      headers: args.headers,
      messageId: args.messageId,
      inReplyTo: args.inReplyTo,
      references: args.references,
      receivedAt,
      sentAt: receivedAt,
      rawSize: args.rawSize,
      attachmentCount: args.attachmentCount,
      createdAt: now,
      updatedAt: now,
    });
    if (conversationId && isLatest) {
      const conversation = await ctx.db.get(conversationId);
      if (conversation)
        await ctx.db.patch(conversationId, { lastMessageAt: receivedAt, updatedAt: now });
      if (previous?.receiptId) {
        const prior = await ctx.db.get(previous.receiptId);
        if (
          prior?.source !== undefined &&
          prior.humanReview?.status === "open" &&
          !prior.humanReview.updatedBy
        )
          await ctx.db.patch(prior._id, {
            humanReview: { ...prior.humanReview, status: "resolved", updatedAt: now },
          });
      }
    }
    return "imported";
  },
});

export const thread = query({
  args: { receiptId: v.id("emailReceipts") },
  returns: v.array(
    v.object({
      id: v.id("emailReceipts"),
      direction,
      subject: v.string(),
      date: v.number(),
    }),
  ),
  handler: async (ctx, { receiptId }) => {
    const receipt = await ctx.db.get(receiptId);
    if (!receipt || receipt.expiresAt <= Date.now()) return [];
    await requireShopMembership(ctx, receipt.shopId);
    const message = await ctx.db
      .query("supportMessages")
      .withIndex("by_receiptId", (q) => q.eq("receiptId", receiptId))
      .first();
    if (!message?.conversationId) return [];
    const siblings = await ctx.db
      .query("supportMessages")
      .withIndex("by_conversationId_and_receivedAt", (q) =>
        q.eq("conversationId", message.conversationId),
      )
      .order("desc")
      .take(50);
    return siblings.flatMap((sibling) =>
      sibling.receiptId && (sibling.expiresAt ?? 0) > Date.now()
        ? [
            {
              id: sibling.receiptId,
              direction: sibling.direction,
              subject: sibling.subject ?? "(sans objet)",
              date: sibling.receivedAt,
            },
          ]
        : [],
    );
  },
});

async function gmailConversation(
  ctx: import("./_generated/server").MutationCtx,
  shopId: Doc<"shops">["_id"],
  gmailThreadId: string,
  address: string,
) {
  const candidates = await ctx.db
    .query("supportMessages")
    .withIndex("by_shopId_and_gmailThreadId", (q) =>
      q.eq("shopId", shopId).eq("gmailThreadId", gmailThreadId),
    )
    .take(50);
  // Prefer an incoming message, so a Gmail reimport attaches sent copies to the inbox thread.
  candidates.sort(
    (a, b) => Number(a.direction === "outbound") - Number(b.direction === "outbound"),
  );
  for (const message of candidates) {
    if (!message.conversationId || (message.expiresAt ?? 0) <= Date.now()) continue;
    const conversation = await ctx.db.get(message.conversationId);
    if (conversation?.customerEmail === address) return conversation._id;
  }
  return null;
}
