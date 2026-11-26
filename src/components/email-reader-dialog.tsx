import { useAction } from "convex/react";
import PostalMime, { type Email } from "postal-mime";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { AutomaticReplyPanel } from "./automatic-replies";
import { EmailClassification } from "./email-classification";
import { HumanReviewPanel } from "./human-review-panel";
import { OrderContext } from "./order-context";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

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
        className="max-h-[90dvh] overflow-y-auto border-0 p-0 sm:max-w-[min(64rem,calc(100vw-2rem))]"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Lire l’email</DialogTitle>
        {selected && <EmailReader key={selected} receiptId={selected} close={close} />}
      </DialogContent>
    </Dialog>
  );
}

const button =
  "rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";

function EmailReader({ receiptId, close }: { receiptId: Id<"emailReceipts">; close: () => void }) {
  const download = useAction(api.emailInbox.download);
  const [content, setContent] = useState<{
    email: Email;
    raw: ArrayBuffer;
    attachmentIds: string[];
  } | null>(null);
  const [error, setError] = useState("");
  const [rawFile, setRawFile] = useState<ArrayBuffer | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    async function load() {
      try {
        const url = await download({ receiptId });
        if (cancelled) return;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("Unavailable");
        const raw = await response.arrayBuffer();
        if (!cancelled) setRawFile(raw);
        const email = await PostalMime.parse(raw, {
          attachmentEncoding: "arraybuffer",
          maxHeadersSize: 128 * 1024,
          maxNestingDepth: 32,
        });
        if (!cancelled)
          setContent({
            email,
            raw,
            attachmentIds: email.attachments.map(() => crypto.randomUUID()),
          });
      } catch {
        if (!cancelled) setError("Impossible d’ouvrir cet email. Il a peut-être expiré.");
      }
    }
    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [download, receiptId]);
  const email = content?.email;
  const links = email
    ? [
        ...new Set(
          Array.from(
            (email.html ?? "").matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi),
            (match) => match[1].replaceAll("&amp;", "&"),
          ),
        ),
      ].slice(0, 30)
    : [];
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <section className="min-w-0 rounded-lg border bg-card p-5" aria-label="Contenu de l’email">
        <div className="flex items-center justify-between gap-3">
          <h2 className="break-words text-lg font-semibold">
            {email?.subject ?? "Ouverture de l’email…"}
          </h2>
          <button className={button} type="button" onClick={close}>
            Fermer
          </button>
        </div>
        {error && (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {rawFile && !content && (
          <button
            className={`${button} mt-3`}
            type="button"
            onClick={() => saveFile(new Blob([rawFile], { type: "message/rfc822" }), "email.eml")}
          >
            Télécharger l’original
          </button>
        )}
        {content && email && (
          <>
            <p className="mt-2 break-all text-sm text-muted-foreground">{email.from?.address}</p>
            <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-4 font-sans text-sm leading-6">
              {email.text ?? email.html?.replace(/<[^>]*>/g, " ") ?? "Aucun contenu texte."}
            </pre>
            {links.length > 0 && (
              <div className="mt-4">
                <h3 className="font-medium">Liens dans cet email</h3>
                <ul className="mt-2 space-y-2">
                  {links.map((link) => (
                    <li key={link}>
                      <a
                        className="break-all text-sm text-primary underline"
                        href={link}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {link}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                className={button}
                type="button"
                onClick={() =>
                  saveFile(new Blob([content.raw], { type: "message/rfc822" }), "email.eml")
                }
              >
                Télécharger l’original
              </button>
              {email.attachments.map((attachment, index) => (
                <button
                  className={button}
                  type="button"
                  key={content.attachmentIds[index]}
                  onClick={() =>
                    saveFile(
                      new Blob(
                        [
                          attachment.content instanceof Uint8Array
                            ? new Uint8Array(attachment.content).buffer
                            : attachment.content,
                        ],
                        { type: "application/octet-stream" },
                      ),
                      attachment.filename ?? `attachment-${index + 1}`,
                    )
                  }
                >
                  Télécharger {attachment.filename ?? `attachment ${index + 1}`}
                </button>
              ))}
            </div>
          </>
        )}
        <EmailClassification receiptId={receiptId} />
        <AutomaticReplyPanel receiptId={receiptId} />
        <HumanReviewPanel receiptId={receiptId} />
      </section>
      <OrderContext receiptId={receiptId} refreshOnOpen={false} />
    </div>
  );
}

function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = Array.from(filename, (char) =>
    char.charCodeAt(0) < 32 || char === "/" || char === "\\" ? "_" : char,
  ).join("");
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
