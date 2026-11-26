import { useMutation, useQuery } from "convex/react";
import { Check, Reply, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export function HumanReviewPanel({ receiptId }: { receiptId: Id<"emailReceipts"> }) {
  const value = useQuery(api.humanReviews.get, { receiptId });
  const setStatus = useMutation(api.humanReviews.setStatus);
  const saveDraft = useMutation(api.humanReviews.saveDraft);
  const approve = useMutation(api.automaticReplies.approveManual);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [approval, setApproval] = useState<{ from: string; to: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) editor.current?.focus();
  }, [editing]);

  async function perform(action: () => Promise<unknown>, failure: string) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  if (!value?.review)
    return notice ? (
      <p role="status" className="text-sm">
        {notice}
      </p>
    ) : null;
  const { review, canManage, sendTarget, draftLanguageMatches } = value;
  const resolved = review.status === "resolved";
  const draft =
    text ?? review.editedDraft ?? (draftLanguageMatches ? review.proposal?.draftReply : "") ?? "";

  return (
    <section aria-label="Actions sur la conversation" className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        {resolved && (
          <span className="mr-auto text-sm font-medium text-muted-foreground">Traitée</span>
        )}
        {canManage && !resolved && !editing && (
          <Button
            onClick={() => {
              setNotice("");
              setEditing(true);
            }}
          >
            <Reply aria-hidden="true" /> {draft ? "Ouvrir le brouillon" : "Répondre"}
          </Button>
        )}
        {canManage && !editing && (
          <Button
            variant={resolved ? "ghost" : "outline"}
            disabled={busy}
            onClick={() => {
              setNotice("");
              void perform(
                () => setStatus({ receiptId, status: resolved ? "open" : "resolved" }),
                "Impossible de changer le statut.",
              );
            }}
          >
            {resolved ? <RotateCcw aria-hidden="true" /> : <Check aria-hidden="true" />}
            {resolved ? "Rouvrir" : "Marquer comme traitée"}
          </Button>
        )}
      </div>
      {editing && (
        <div className="space-y-3">
          <label className="block text-sm font-medium">
            Réponse
            <textarea
              ref={editor}
              className="mt-2 min-h-36 w-full rounded-lg border bg-background p-3 text-sm leading-6 font-normal focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              value={draft}
              maxLength={6000}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {sendTarget && (
              <Button
                disabled={busy || !draft.trim()}
                onClick={() => {
                  setError("");
                  setApproval({ ...sendTarget, text: draft.trim() });
                }}
              >
                Vérifier l’envoi
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy || text === null}
              onClick={() =>
                void perform(async () => {
                  await saveDraft({ receiptId, draft });
                  setEditing(false);
                  setNotice("Brouillon enregistré.");
                }, "Impossible d’enregistrer le brouillon.")
              }
            >
              Enregistrer le brouillon
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Fermer le brouillon
            </Button>
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="mt-2 text-sm">
          {notice}
        </p>
      )}
      {error && !approval && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={approval !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setApproval(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Confirmer l’envoi</DialogTitle>
            <DialogDescription className="break-all">
              De {approval?.from}
              <br />À {approval?.to}
            </DialogDescription>
          </DialogHeader>
          <p className="whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-sm">
            {approval?.text}
          </p>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setApproval(null);
                setError("");
              }}
            >
              Annuler
            </Button>
            <Button
              disabled={busy || !approval}
              onClick={() => {
                if (!approval) return;
                void perform(async () => {
                  await approve({ receiptId, ...approval });
                  setApproval(null);
                  setEditing(false);
                  setText(null);
                  setNotice("Envoi validé.");
                }, "L’envoi est indisponible ou a déjà été validé.");
              }}
            >
              Confirmer et envoyer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
