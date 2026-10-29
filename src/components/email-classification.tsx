import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  type Category,
  type Classification,
  categories,
  type Priority,
  priorities,
} from "../../convex/lib/emailClassificationPolicy";

const button =
  "rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";
const priorityStyle: Record<Priority, string> = {
  low: "border-slate-500 bg-slate-50 text-slate-800",
  normal: "border-blue-600 bg-blue-50 text-blue-900",
  high: "border-amber-600 bg-amber-50 text-amber-900",
  urgent: "border-red-600 bg-red-50 text-red-900",
};

export function ClassificationBadges({
  classification,
  pending,
}: {
  classification: Classification | null;
  pending: boolean;
}) {
  return (
    <fieldset
      className="mt-3 flex flex-wrap gap-2 text-xs font-medium"
      aria-label="Catégorie et importance"
    >
      {classification ? (
        <>
          <span className="rounded-full border border-slate-500 px-2.5 py-1">
            {categories[classification.category]}
          </span>
          <span
            className={`rounded-full border px-2.5 py-1 ${priorityStyle[classification.priority]}`}
          >
            Importance {priorities[classification.priority].toLowerCase()}
          </span>
          {classification.needsReview && (
            <span className="rounded-full border border-amber-600 bg-amber-50 px-2.5 py-1 text-amber-900">
              À vérifier
            </span>
          )}
          {classification.source === "manual" && (
            <span className="rounded-full border border-slate-500 px-2.5 py-1">
              Corrigé manuellement
            </span>
          )}
        </>
      ) : (
        !pending && (
          <span className="rounded-full border border-slate-500 px-2.5 py-1">Non classé</span>
        )
      )}
      {pending && (
        <span
          role="status"
          className="rounded-full border border-blue-600 bg-blue-50 px-2.5 py-1 text-blue-900"
        >
          Analyse en cours…
        </span>
      )}
    </fieldset>
  );
}

export function ClassificationControls({
  receiptId,
  classification,
  pending,
  canCorrect,
}: {
  receiptId: Id<"emailReceipts">;
  classification: Classification | null;
  pending: boolean;
  canCorrect: boolean;
}) {
  const correct = useMutation(api.emailClassification.correct);
  const request = useMutation(api.emailClassification.request);
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState<Category>(classification?.category ?? "other");
  const [priority, setPriority] = useState<Priority>(classification?.priority ?? "normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setEditing(false);
    } catch {
      setError("Le classement n’a pas pu être enregistré. Réessayez.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3">
      {classification && (
        <p className="break-words text-sm text-muted-foreground">{classification.reason}</p>
      )}
      {!classification && !pending && (
        <p className="text-sm text-muted-foreground">
          Cet email n’a pas encore de catégorie ni d’importance.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {canCorrect && (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => {
                setCategory(classification?.category ?? "other");
                setPriority(classification?.priority ?? "normal");
                setEditing(true);
              }}
            >
              Modifier le classement
            </button>
            {classification?.source !== "manual" && (
              <button
                type="button"
                className={button}
                disabled={busy || pending}
                onClick={() => void perform(() => request({ receiptId }))}
              >
                {classification ? "Relancer l’analyse" : "Analyser cet email"}
              </button>
            )}
          </div>
          {editing && (
            <form
              className="mt-3 flex flex-wrap items-end gap-3 rounded-md border bg-background p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(() => correct({ receiptId, category, priority }));
              }}
            >
              <label className="grid gap-1 text-sm">
                Catégorie
                <select
                  className={`${button} max-w-full`}
                  value={category}
                  onChange={(event) => setCategory(event.target.value as Category)}
                >
                  {Object.entries(categories).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Importance
                <select
                  className={button}
                  value={priority}
                  onChange={(event) => setPriority(event.target.value as Priority)}
                >
                  {Object.entries(priorities).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                disabled={busy}
                className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}
              >
                Enregistrer
              </button>
              <button
                type="button"
                disabled={busy}
                className={button}
                onClick={() => setEditing(false)}
              >
                Annuler
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}

export function EmailClassification({ receiptId }: { receiptId: Id<"emailReceipts"> }) {
  const value = useQuery(api.emailClassification.get, { receiptId });
  if (!value) return null;
  return (
    <section className="mt-4 rounded-md border p-4" aria-label="Classement SAV">
      <h3 className="font-semibold">Catégorie et importance</h3>
      <ClassificationBadges classification={value.classification} pending={value.pending} />
      <ClassificationControls receiptId={receiptId} {...value} />
    </section>
  );
}
