import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import PostalMime, { type Email } from "postal-mime";
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { AutomaticReplyPanel } from "./automatic-replies";
import { EmailClassification } from "./email-classification";
import { HumanReviewPanel } from "./human-review-panel";
import { OrderContext } from "./order-context";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

type Message = FunctionReturnType<typeof api.emailConversations.timeline>[number];

export function EmailReaderDialog({
  selected,
  close,
}: {
  selected: Id<"emailReceipts"> | null;
  close: () => void;
}) {
  return (
    <Dialog
      open={selected !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[90dvh] gap-0 overflow-y-auto p-0 sm:max-w-3xl"
      >
        {selected && <Conversation key={selected} receiptId={selected} />}
      </DialogContent>
    </Dialog>
  );
}

function Conversation({ receiptId }: { receiptId: Id<"emailReceipts"> }) {
  const [includeOlder, setIncludeOlder] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showOrder, setShowOrder] = useState(false);
  const messages = useQuery(api.emailConversations.timeline, { receiptId, includeOlder });
  const selected = messages?.find((message) => message.receiptId === receiptId);
  const replyTo = messages?.filter((message) => message.direction === "inbound").at(-1)?.receiptId;
  return (
    <>
      <header className="sticky top-0 z-10 border-b bg-background px-5 py-4 pr-12 sm:px-7 sm:pr-12">
        <DialogTitle className="break-words text-lg">
          {(selected?.translation?.state === "translated"
            ? selected.translation.subject
            : undefined) ??
            selected?.subject ??
            "Conversation"}
        </DialogTitle>
      </header>
      <div className="space-y-4 bg-muted/30 p-5 sm:p-7">
        {messages === undefined && <p role="status">Chargement de la conversation…</p>}
        {messages?.length === 0 && <p>Ce message n’est plus disponible.</p>}
        {!includeOlder && (messages?.length ?? 0) >= 25 && (
          <button type="button" className="text-sm underline" onClick={() => setIncludeOlder(true)}>
            Afficher les messages plus anciens
          </button>
        )}
        {messages?.map((message) => (
          <MessageCard key={message.id} message={message} />
        ))}
      </div>
      {replyTo && (
        <footer className="space-y-4 border-t px-5 py-4 sm:px-7">
          <HumanReviewPanel key={replyTo} receiptId={replyTo} />
          <details onToggle={(event) => setShowOrder(event.currentTarget.open)}>
            <summary className="cursor-pointer text-sm font-medium">Commande et suivi</summary>
            {showOrder && (
              <div className="mt-3">
                <OrderContext receiptId={replyTo} refreshOnOpen={false} />
              </div>
            )}
          </details>
          <details onToggle={(event) => setShowDetails(event.currentTarget.open)}>
            <summary className="cursor-pointer text-sm font-medium">Détails de la demande</summary>
            {showDetails && (
              <>
                <EmailClassification receiptId={replyTo} />
                <AutomaticReplyPanel receiptId={replyTo} />
              </>
            )}
          </details>
        </footer>
      )}
    </>
  );
}

function MessageCard({ message }: { message: Message }) {
  const translate = useAction(api.emailTranslation.translate);
  const card = useRef<HTMLElement>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [showDownloads, setShowDownloads] = useState(false);
  const state = message.translation?.state;
  const retryAt = message.translation?.state === "pending" ? message.translation.retryAt : 0;
  useEffect(() => {
    const node = card.current;
    if (!node || state === "original" || state === "translated") return;
    if (retryAt > Date.now()) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void translate({ id: message.id }).catch(() => undefined);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [message.id, retryAt, state, translate]);
  const translated = message.translation?.state === "translated" ? message.translation : null;
  return (
    <article
      ref={card}
      className={`rounded-lg border bg-card p-4 sm:p-5 ${message.direction === "outbound" ? "ml-3 border-l-4 border-l-primary sm:ml-10" : "sm:mr-10"}`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
        <span className="font-semibold">{message.direction === "inbound" ? "Reçu" : "Envoyé"}</span>
        <time className="text-muted-foreground" dateTime={new Date(message.date).toISOString()}>
          {new Date(message.date).toLocaleString("fr-FR", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </time>
      </header>
      <p className="mt-1 break-words text-sm text-muted-foreground">{message.sender}</p>
      {translated && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
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
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">
        {(!showOriginal && translated?.text) || message.text || "Aucun contenu texte."}
      </p>
      {message.receiptId && (
        <details
          className="mt-3 text-xs text-muted-foreground"
          onToggle={(event) => setShowDownloads(event.currentTarget.open)}
        >
          <summary className="cursor-pointer">
            {message.attachmentCount > 0
              ? `Pièces jointes (${message.attachmentCount})`
              : "Fichier email"}
          </summary>
          {showDownloads && (
            <Downloads receiptId={message.receiptId} hasAttachments={message.attachmentCount > 0} />
          )}
        </details>
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
