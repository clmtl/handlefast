import PostalMime, { type Address, type Attachment } from "postal-mime";

export const maxInboundEmailRawBytes = 5 * 1024 * 1024;

export type CloudflareEmailRoutingMessage = {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
};

export type EmailIdentityPayload = {
  address: string;
  name?: string;
};

export type CloudflareEmailRoutingPayload = {
  provider: "cloudflare_email_routing";
  deliveryKey: string;
  envelopeFrom: string;
  envelopeTo: string;
  from: EmailIdentityPayload;
  to: EmailIdentityPayload[];
  cc: EmailIdentityPayload[];
  replyTo: EmailIdentityPayload[];
  subject?: string;
  text?: string;
  html?: string;
  snippet?: string;
  headers: Array<{ name: string; value: string }>;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  attachments: Array<{
    filename?: string;
    contentType: string;
    size: number;
    disposition?: "attachment" | "inline";
    contentId?: string;
  }>;
  receivedAt: number;
  rawSize: number;
};

export async function buildCloudflareEmailRoutingPayload(
  message: CloudflareEmailRoutingMessage,
): Promise<CloudflareEmailRoutingPayload> {
  if (message.rawSize > maxInboundEmailRawBytes) {
    throw new Error("InboundEmailTooLarge");
  }

  const rawBytes = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(rawBytes, {
    attachmentEncoding: "arraybuffer",
    maxHeadersSize: 128 * 1024,
    maxNestingDepth: 32,
  });
  const envelopeFrom = normalizeEmailAddress(message.from);
  const envelopeTo = normalizeEmailAddress(message.to);
  const messageId = normalizeOptionalString(parsed.messageId);
  const rawHash = await sha256Hex(rawBytes);
  const receivedAt = getReceivedAt(parsed.date);
  const text = normalizeOptionalString(parsed.text);
  const html = normalizeOptionalString(parsed.html);
  const subject = normalizeOptionalString(parsed.subject);
  const snippet = buildSnippet(text, html);
  const inReplyTo = normalizeOptionalString(parsed.inReplyTo);
  const from = flattenPostalAddresses(parsed.from ? [parsed.from] : [])[0] ?? {
    address: envelopeFrom,
  };
  const to = flattenPostalAddresses(parsed.to ?? []);
  const deliveryKey = [
    "cloudflare_email_routing",
    envelopeTo,
    messageId ? normalizeMessageId(messageId) : rawHash,
  ].join(":");

  return {
    provider: "cloudflare_email_routing",
    deliveryKey,
    envelopeFrom,
    envelopeTo,
    from: normalizeIdentity(from, envelopeFrom),
    to: normalizeIdentities(to, envelopeTo),
    cc: normalizeIdentities(flattenPostalAddresses(parsed.cc ?? [])),
    replyTo: normalizeIdentities(flattenPostalAddresses(parsed.replyTo ?? [])),
    ...(subject ? { subject } : {}),
    ...(text ? { text: truncate(text, 120_000) } : {}),
    ...(html ? { html: truncate(html, 120_000) } : {}),
    ...(snippet ? { snippet } : {}),
    headers: parsed.headers.map((header) => ({
      name: header.originalKey || header.key,
      value: header.value,
    })),
    ...(messageId ? { messageId: normalizeMessageId(messageId) } : {}),
    ...(inReplyTo ? { inReplyTo: normalizeMessageId(inReplyTo) } : {}),
    references: parseReferences(parsed.references),
    attachments: parsed.attachments.map(normalizeAttachment),
    receivedAt,
    rawSize: message.rawSize,
  };
}

function normalizeIdentities(values: EmailIdentityPayload[], fallback = "") {
  const normalized = values
    .map((value) => normalizeIdentity(value))
    .filter((value) => value.address);

  if (normalized.length > 0) {
    return normalized;
  }

  const fallbackAddress = normalizeEmailAddress(fallback);
  return fallbackAddress ? [{ address: fallbackAddress }] : [];
}

function normalizeIdentity(value: EmailIdentityPayload, fallback = "") {
  const address = normalizeEmailAddress(value.address || fallback);
  const name = normalizeOptionalString(value.name);

  return {
    address,
    ...(name ? { name } : {}),
  };
}

function flattenPostalAddresses(addresses: Address[]): EmailIdentityPayload[] {
  const flattened: EmailIdentityPayload[] = [];

  for (const address of addresses) {
    if ("group" in address) {
      flattened.push(...flattenPostalAddresses(address.group ?? []));
      continue;
    }

    if (address.address) {
      flattened.push({
        address: address.address,
        ...(address.name ? { name: address.name } : {}),
      });
    }
  }

  return flattened;
}

function normalizeAttachment(attachment: Attachment) {
  const filename = normalizeOptionalString(attachment.filename ?? undefined);
  const contentId = normalizeOptionalString(attachment.contentId);
  return {
    ...(filename ? { filename } : {}),
    contentType: attachment.mimeType || "application/octet-stream",
    size: getAttachmentSize(attachment.content),
    ...(attachment.disposition === "attachment" || attachment.disposition === "inline"
      ? { disposition: attachment.disposition }
      : {}),
    ...(contentId ? { contentId } : {}),
  };
}

function getAttachmentSize(content: Attachment["content"]) {
  if (typeof content === "string") {
    return new TextEncoder().encode(content).byteLength;
  }

  return content.byteLength;
}

function parseReferences(value: string | undefined) {
  if (!value) {
    return [];
  }

  return Array.from(value.matchAll(/<[^>]+>|[^\s]+/g), (match) => normalizeMessageId(match[0]))
    .filter(Boolean)
    .slice(0, 20);
}

function getReceivedAt(value: string | undefined) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function normalizeMessageId(value: string) {
  return value.trim();
}

function normalizeEmailAddress(value: string) {
  return value.trim().toLowerCase();
}

function normalizeOptionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function buildSnippet(text: string | null, html: string | null) {
  const source = text ?? stripHtml(html ?? "");
  return source.replace(/\s+/g, " ").trim().slice(0, 240) || null;
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ");
}

function truncate(value: string, maxLength: number) {
  return value.slice(0, maxLength);
}

async function sha256Hex(value: ArrayBuffer) {
  const hash = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
