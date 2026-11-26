import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowLeft, ChevronDown, Languages, Mail, Package, Paperclip, Send } from "lucide-react";
import PostalMime, { type Email } from "postal-mime";
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { AutomaticReplyPanel } from "./automatic-replies";
import { EmailClassification } from "./email-classification";
import { HumanReviewPanel } from "./human-review-panel";
import { OrderContext } from "./order-context";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

type Message = FunctionReturnType<typeof api.emailConversations.timeline>[number];

export function EmailConversationPage({
  receiptId,
  shopId,
  backLabel,
  onBack,
}: {
  receiptId: Id<"emailReceipts">;
  shopId: Id<"shops">;
  backLabel: string;
  onBack: () => void;
}) {
  const [includeOlder, setIncludeOlder] = useState(false);
  const [showOrder, setShowOrder] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const messages = useQuery(api.emailConversations.timeline, { receiptId, shopId, includeOlder });
  const selected = messages?.find((message) => message.receiptId === receiptId);
  const incoming = messages?.filter((message) => message.direction === "inbound").at(-1);
  const last = messages?.at(-1);
  const classificationReceiptId =
    selected?.direction === "inbound" ? receiptId : incoming?.receiptId;
  const subject =
    selected?.translation?.state === "translated" && selected.translation.subject
      ? selected.translation.subject
      : selected?.subject;

  useEffect(() => {
    title.current?.focus({ preventScroll: true });
  }, []);

  return (
    <article className="mx-auto max-w-6xl" aria-labelledby="conversation-title">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 mb-4 text-muted-foreground"
        onClick={onBack}
      >
        <ArrowLeft aria-hidden="true" /> {backLabel}
      </Button>
      <header className="border-b pb-5">
        <h1
          id="conversation-title"
          ref={title}
          tabIndex={-1}
          className="max-w-4xl break-words text-2xl font-semibold tracking-tight focus:outline-none sm:text-3xl"
        >
          {subject || "Conversation"}
        </h1>
        {incoming && (
          <p className="mt-2 break-words text-sm text-muted-foreground">{incoming.sender}</p>
        )}
      </header>
      {messages === undefined && (
        <div className="space-y-3 py-6" role="status" aria-label="Chargement de la conversation">
          <Skeleton className="h-10 max-w-60" />
          <Skeleton className="h-48 max-w-3xl rounded-xl" />
        </div>
      )}
      {messages?.length === 0 && (
        <p className="py-8 text-sm text-muted-foreground">
          Cette conversation n’est plus disponible.
        </p>
      )}
      {Boolean(messages?.length) && (
        <div className="grid items-start gap-6 pt-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="min-w-0 space-y-4">
            {incoming?.receiptId && (
              <HumanReviewPanel key={incoming.receiptId} receiptId={incoming.receiptId} />
            )}
            <section aria-label="Messages de la conversation">
              {!includeOlder && (messages?.length ?? 0) >= 25 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mb-3"
                  onClick={() => setIncludeOlder(true)}
                >
                  Afficher les messages plus anciens
                </Button>
              )}
              <ol className="space-y-3">
                {messages?.map((message) => (
                  <li key={message.id}>
                    <MessageCard
                      message={message}
                      expanded={message.id === last?.id || message.id === selected?.id}
                    />
                  </li>
                ))}
              </ol>
            </section>
          </div>
          {incoming?.receiptId && (
            <aside
              className="min-w-0 space-y-3 xl:sticky xl:top-24"
              aria-label="Informations sur la conversation"
            >
              {classificationReceiptId && (
                <EmailClassification
                  key={classificationReceiptId}
                  receiptId={classificationReceiptId}
                />
              )}
              <details
                className="group rounded-xl border bg-card"
                onToggle={(event) => setShowOrder(event.currentTarget.open)}
              >
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                  <Package className="size-4 text-muted-foreground" aria-hidden="true" />
                  Commande et suivi
                  <ChevronDown
                    className="ml-auto size-4 text-muted-foreground group-open:rotate-180"
                    aria-hidden="true"
                  />
                </summary>
                {showOrder && (
                  <div className="border-t p-3">
                    <OrderContext receiptId={incoming.receiptId} refreshOnOpen={false} />
                  </div>
                )}
              </details>
              <AutomaticReplyPanel receiptId={incoming.receiptId} showSent={false} />
            </aside>
          )}
        </div>
      )}
    </article>
  );
}

function MessageCard({ message, expanded }: { message: Message; expanded: boolean }) {
  const [open, setOpen] = useState(expanded);
  const translate = useAction(api.emailTranslation.translate);
  const card = useRef<HTMLElement>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [showDownloads, setShowDownloads] = useState(false);
  const state = message.translation?.state;
  const retryAt = message.translation?.state === "pending" ? message.translation.retryAt : 0;
  useEffect(() => {
    const node = card.current;
    if (!node || !open || state === "original" || state === "translated") return;
    if (retryAt > Date.now()) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void translate({ id: message.id }).catch(() => undefined);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [message.id, open, retryAt, state, translate]);
  const translated = message.translation?.state === "translated" ? message.translation : null;
  const outbound = message.direction === "outbound";
  const Icon = outbound ? Send : Mail;
  return (
    <article
      ref={card}
      className={`overflow-hidden rounded-xl border ${outbound ? "border-primary/15 bg-primary/[0.035]" : "bg-card"}`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-5"
      >
        <span
          className={`grid size-9 shrink-0 place-items-center rounded-lg ${outbound ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
        >
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{message.sender}</span>
          <span className="block text-xs text-muted-foreground">
            {outbound ? "Envoyé" : "Reçu"}
          </span>
        </span>
        <time
          className="shrink-0 text-xs text-muted-foreground"
          dateTime={new Date(message.date).toISOString()}
        >
          {new Date(message.date).toLocaleString("fr-FR", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
        <ChevronDown
          aria-hidden="true"
          className={`size-4 shrink-0 text-muted-foreground ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-border/70 px-4 py-4 sm:px-5 sm:py-5">
          {translated && (
            <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <Languages aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span className="font-medium text-muted-foreground">
                {showOriginal ? "Texte original" : "Traduit en français"}
              </span>
              <button
                type="button"
                className="text-primary underline"
                onClick={() => setShowOriginal(!showOriginal)}
              >
                {showOriginal ? "Afficher la traduction" : "Afficher l’original"}
              </button>
            </div>
          )}
          {translated?.subject && (
            <p className="mt-3 break-words text-sm font-medium">
              {showOriginal ? message.subject : translated.subject}
            </p>
          )}
          <p className="max-w-[75ch] whitespace-pre-wrap [overflow-wrap:anywhere] text-[15px] leading-7">
            {(!showOriginal && translated?.text) || message.text || "Aucun contenu texte."}
          </p>
          {message.receiptId && (
            <details
              className="mt-4 text-xs text-muted-foreground"
              onToggle={(event) => setShowDownloads(event.currentTarget.open)}
            >
              <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 hover:bg-muted [&::-webkit-details-marker]:hidden">
                <Paperclip className="size-3.5" aria-hidden="true" />
                {message.attachmentCount > 0
                  ? `Pièces jointes (${message.attachmentCount})`
                  : "Fichier email"}
              </summary>
              {showDownloads && (
                <Downloads
                  receiptId={message.receiptId}
                  hasAttachments={message.attachmentCount > 0}
                />
              )}
            </details>
          )}
        </div>
      )}
    </article>
  );
}

function Downloads({
  receiptId,
  hasAttachments,
}: {
  receiptId: Id<"emailReceipts">;
  hasAttachments: boolean;
}) {
  const download = useAction(api.emailInbox.download);
  const [url, setUrl] = useState("");
  const [attachments, setAttachments] = useState<
    { id: string; file: Email["attachments"][number] }[]
  >([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const signed = await download({ receiptId });
        if (controller.signal.aborted) return;
        setUrl(signed);
        if (!hasAttachments) return;
        const response = await fetch(signed, { signal: controller.signal });
        if (!response.ok) throw new Error("Unavailable");
        const parsed = await PostalMime.parse(await response.arrayBuffer(), {
          attachmentEncoding: "arraybuffer",
          maxHeadersSize: 128 * 1024,
          maxNestingDepth: 32,
        });
        if (!controller.signal.aborted)
          setAttachments(parsed.attachments.map((file) => ({ id: crypto.randomUUID(), file })));
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    })();
    return () => controller.abort();
  }, [download, hasAttachments, receiptId]);
  return (
    <div className="mt-2 flex flex-wrap gap-3">
      {url && (
        <a className="underline" href={url} download="email.eml" target="_blank" rel="noreferrer">
          Télécharger l’email (.eml)
        </a>
      )}
      {attachments.map(({ id, file }, index) => (
        <button
          key={id}
          type="button"
          className="break-all underline"
          onClick={() => saveAttachment(file, index)}
        >
          {file.filename ?? `Pièce jointe ${index + 1}`}
        </button>
      ))}
      {error && <p role="alert">Téléchargement indisponible.</p>}
      {!url && !error && <p role="status">Chargement…</p>}
    </div>
  );
}

function saveAttachment(attachment: Email["attachments"][number], index: number) {
  const content = attachment.content;
  const url = URL.createObjectURL(
    new Blob([content instanceof Uint8Array ? new Uint8Array(content).buffer : content], {
      type: "application/octet-stream",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = Array.from(attachment.filename ?? `piece-jointe-${index + 1}`, (char) =>
    char.charCodeAt(0) < 32 || char === "/" || char === "\\" ? "_" : char,
  ).join("");
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
