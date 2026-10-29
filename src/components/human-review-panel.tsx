import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { blockReasons, reviewStatuses, reviewWarnings } from "../../convex/lib/humanReviewPolicy";

const button =
  "rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";

export function HumanReviewPanel({ receiptId }: { receiptId: Id<"emailReceipts"> }) {
  const value = useQuery(api.humanReviews.get, { receiptId });
  const request = useMutation(api.humanReviews.request),
    setStatus = useMutation(api.humanReviews.setStatus);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch {
      setError("La demande n’a pas pu être mise à jour. Réessayez.");
    } finally {
      setBusy(false);
    }
  }
  if (!value) return null;
  const { review, canManage, stale } = value,
    proposal = review?.proposal;
  return (
    <section
      className="mt-4 rounded-lg border border-amber-600 bg-amber-50/40 p-4"
      aria-label="Traitement humain"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Traitement humain</h3>
        {review && (
          <span className="rounded-full border border-amber-600 px-2.5 py-1 text-xs font-medium">
            {reviewStatuses[review.status]}
          </span>
        )}
      </div>
      <p className="mt-2 text-sm">{blockReasons[value.reason]}</p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {review?.job && (
        <p role="status" className="mt-3 text-sm">
          Préparation du résumé et de la proposition…
        </p>
      )}
      {stale && (
        <p
          role="status"
          className="mt-3 rounded-md border border-amber-600 bg-amber-50 p-3 text-sm text-amber-950"
        >
          Le contexte a changé depuis cette proposition. Régénérez-la ou adaptez votre brouillon
          avant de l’utiliser.
        </p>
      )}
      {proposal && (
        <div className="mt-4 grid gap-4">
          {proposal.source === "fallback" && (
            <p className="text-sm font-medium">
              Assistance indisponible : la demande reste à traiter.
            </p>
          )}
          <div>
            <h4 className="text-sm font-semibold">Résumé</h4>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{proposal.summary}</p>
          </div>
          <div>
            <h4 className="text-sm font-semibold">Piste de résolution</h4>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{proposal.solution}</p>
          </div>
          {(proposal.missingInformation.length > 0 || proposal.warnings.length > 0) && (
            <div>
              <h4 className="text-sm font-semibold">Informations à vérifier</h4>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {proposal.warnings.map((warning) => (
                  <li key={warning}>{reviewWarnings[warning]}</li>
                ))}
                {[...new Set(proposal.missingInformation)].map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {review && (
        <DraftEditor
          receiptId={receiptId}
          saved={review.editedDraft ?? proposal?.draftReply ?? ""}
          suggested={proposal?.draftReply ?? ""}
          canManage={canManage}
          edited={review.editedDraft !== undefined}
        />
      )}
      {canManage && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className={button}
            type="button"
            disabled={busy || Boolean(review?.job)}
            onClick={() => void perform(() => request({ receiptId }))}
          >
            {proposal ? "Régénérer la proposition" : "Préparer le résumé et la proposition"}
          </button>
          {review && review.status !== "in_progress" && review.status !== "resolved" && (
            <button
              className={button}
              type="button"
              disabled={busy}
              onClick={() => void perform(() => setStatus({ receiptId, status: "in_progress" }))}
            >
              Prendre en charge
            </button>
          )}
          {review && review.status !== "resolved" && (
            <button
              className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}
              type="button"
              disabled={busy}
              onClick={() => void perform(() => setStatus({ receiptId, status: "resolved" }))}
            >
              Marquer comme traité
            </button>
          )}
          {review?.status === "resolved" && (
            <button
              className={button}
              type="button"
              disabled={busy}
              onClick={() => void perform(() => setStatus({ receiptId, status: "open" }))}
            >
              Rouvrir la demande
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function DraftEditor({
  receiptId,
  saved,
  suggested,
  canManage,
  edited,
}: {
  receiptId: Id<"emailReceipts">;
  saved: string;
  suggested: string;
  canManage: boolean;
  edited: boolean;
}) {
  const saveDraft = useMutation(api.humanReviews.saveDraft);
  const [text, setText] = useState(""),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState("");
  const draft = editing ? text : saved;
  async function save() {
    setBusy(true);
    setFeedback("");
    try {
      await saveDraft({ receiptId, draft });
      setEditing(false);
      setFeedback("Brouillon enregistré.");
    } catch {
      setFeedback("Le brouillon n’a pas pu être enregistré.");
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(draft);
      setFeedback("Brouillon copié. Relisez-le avant de l’envoyer depuis votre messagerie.");
    } catch {
      setFeedback("Copie impossible. Sélectionnez et copiez le texte manuellement.");
    }
  }
  return (
    <div className="mt-4">
      <label className="grid gap-2 text-sm font-semibold">
        Brouillon de réponse à valider
        <textarea
          className="min-h-40 w-full rounded-md border border-slate-500 bg-background p-3 text-sm font-normal leading-6"
          value={draft}
          maxLength={6000}
          readOnly={!canManage}
          onChange={(event) => {
            setText(event.target.value);
            setEditing(true);
            setFeedback("");
          }}
          placeholder="Préparez une réponse après vérification des informations."
        />
      </label>
      <p className="mt-2 text-xs text-muted-foreground">
        {edited ? "Brouillon modifié par l’équipe. " : "Proposition à relire et adapter. "}Validez
        les faits et les engagements avant tout envoi depuis votre messagerie.
      </p>
      {canManage && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className={button}
            type="button"
            disabled={busy || !editing}
            onClick={() => void save()}
          >
            Enregistrer le brouillon
          </button>
          <button
            className={button}
            type="button"
            disabled={!draft.trim()}
            onClick={() => void copy()}
          >
            Copier le brouillon
          </button>
          {suggested && (
            <button
              className={button}
              type="button"
              disabled={busy}
              onClick={() => {
                setText(suggested);
                setEditing(true);
                setFeedback("");
              }}
            >
              Reprendre la proposition
            </button>
          )}
        </div>
      )}
      {feedback && (
        <p role="status" className="mt-2 text-sm">
          {feedback}
        </p>
      )}
    </div>
  );
}
