import type { FunctionArgs } from "convex/server";
import { buildCloudflareEmailRoutingPayload } from "../src/lib/cloudflare-email-routing";
import { maxTakeoutMessageBytes } from "../src/lib/takeout-mbox";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { RAW_EMAIL_CONTENT_TYPE } from "./lib/emailPolicy";

const clip = (value: string, size: number) => value.slice(0, size).replace(/[\uD800-\uDBFF]$/, "");
const clipped = (value: string | undefined, size: number) =>
  value === undefined ? undefined : clip(value, size);
const identity = (value: { address: string; name?: string }) => ({
  address: clip(value.address, 320),
  name: clipped(value.name, 256),
});

export const takeoutMessage = httpAction(async (ctx, request) => {
  if (!(await ctx.auth.getUserIdentity())) return new Response(null, { status: 401 });
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const source = url.searchParams.get("source") === "gmail" ? "gmail" : "takeout";
  if (!shop || shop.length > 64 || !request.body) return new Response(null, { status: 400 });
  if (Number(request.headers.get("content-length")) > maxTakeoutMessageBytes)
    return Response.json({ result: "skipped" });
  let supportEmail: string;
  try {
    supportEmail = await ctx.runQuery(internal.takeoutImport.shopAddress, { shop });
  } catch {
    return new Response(null, { status: 403 });
  }

  // Convex HTTP request blobs can be streamed and consumed only once.
  const raw = await request.arrayBuffer();
  if (!raw.byteLength || raw.byteLength > maxTakeoutMessageBytes)
    return Response.json({ result: "skipped" });
  let parsed: Awaited<ReturnType<typeof buildCloudflareEmailRoutingPayload>>;
  try {
    parsed = await buildCloudflareEmailRoutingPayload({
      from: "",
      to: "",
      headers: new Headers(),
      raw: new Blob([raw]).stream(),
      rawSize: raw.byteLength,
    });
  } catch {
    return Response.json({ result: "skipped" });
  }

  const labels = parsed.headers
    .filter((header) => header.name.toLowerCase() === "x-gmail-labels")
    .flatMap((header) => header.value.split(",").map((label) => label.trim().toLowerCase()));
  const outbound = parsed.from.address === supportEmail;
  const matchesShop = [...parsed.to, ...parsed.cc].some(
    (recipient) => recipient.address === supportEmail,
  );
  const date = parsed.sentAt ?? Number(url.searchParams.get("date"));
  if (
    (!outbound && !matchesShop) ||
    labels.some((label) =>
      ["spam", "trash", "draft", "drafts", "corbeille", "brouillon", "brouillons"].includes(label),
    ) ||
    !Number.isFinite(date) ||
    date <= 0
  )
    return Response.json({ result: "skipped" });

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const sha256 = btoa(String.fromCharCode(...digest));
  const rawStorageId = await ctx.storage.store(new Blob([raw], { type: RAW_EMAIL_CONTENT_TYPE }));
  try {
    const result = await ctx.runMutation(internal.takeoutImport.commit, {
      shopId: shop as FunctionArgs<typeof internal.takeoutImport.commit>["shopId"],
      supportEmail,
      rawStorageId,
      sha256,
      rawSize: raw.byteLength,
      source,
      date,
      direction: outbound ? "outbound" : "inbound",
      from: identity(parsed.from),
      to: parsed.to.slice(0, 30).map(identity),
      cc: parsed.cc.slice(0, 30).map(identity),
      replyTo: parsed.replyTo.slice(0, 30).map(identity),
      subject: clipped(parsed.subject, 1000),
      text: clipped(parsed.text, 12000),
      snippet: clipped(parsed.snippet, 320),
      messageId: clipped(parsed.messageId, 500),
      inReplyTo: clipped(parsed.inReplyTo, 500),
      references: parsed.references.slice(-20).map((ref) => clip(ref, 500)),
      headers: parsed.headers.slice(0, 40).map((header) => ({
        name: clip(header.name, 100),
        value: clip(header.value, 1000),
      })),
      attachmentCount: parsed.attachments.length,
    });
    if (result !== "imported") await ctx.storage.delete(rawStorageId);
    return Response.json({ result });
  } catch {
    await ctx.storage.delete(rawStorageId);
    return new Response(null, { status: 422 });
  }
});
