import { useMutation, useQuery } from "convex/react";
import { Pencil } from "lucide-react";
import { useId, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  type Category,
  type Classification,
  categories,
  type Priority,
  priorities,
} from "../../convex/lib/emailClassificationPolicy";

import { Button } from "./ui/button";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";

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

export function EmailClassification({ receiptId }: { receiptId: Id<"emailReceipts"> }) {
  const value = useQuery(api.emailClassification.get, { receiptId });
  const fieldId = useId();
  const correct = useMutation(api.emailClassification.correct);
  const [draft, setDraft] = useState<{ category: Category; priority: Priority } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (!value) return null;

  async function save(values: { category: Category; priority: Priority }) {
    setBusy(true);
    setError(false);
    try {
      await correct({ receiptId, ...values });
      setDraft(null);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const { classification, pending, canCorrect } = value;
  return (
    <section className="rounded-xl border bg-card p-4" aria-label="Catégorie et importance">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Catégorie et importance</h2>
        {canCorrect && !draft && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label="Modifier la catégorie et l’importance"
            onClick={() =>
              setDraft({
                category: classification?.category ?? "other",
                priority: classification?.priority ?? "normal",
              })
            }
          >
            <Pencil aria-hidden="true" /> Modifier
          </Button>
        )}
      </div>
      {draft ? (
        <form
          className="mt-3 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save(draft);
          }}
        >
          <label htmlFor={`${fieldId}-category`} className="grid gap-1.5 text-xs font-medium">
            Catégorie
            <NativeSelect
              id={`${fieldId}-category`}
              value={draft.category}
              className="w-full"
              onChange={(event) => setDraft({ ...draft, category: event.target.value as Category })}
            >
              {Object.entries(categories).map(([value, label]) => (
                <NativeSelectOption key={value} value={value}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label htmlFor={`${fieldId}-priority`} className="grid gap-1.5 text-xs font-medium">
            Importance
            <NativeSelect
              id={`${fieldId}-priority`}
              value={draft.priority}
              className="w-full"
              onChange={(event) => setDraft({ ...draft, priority: event.target.value as Priority })}
            >
              {Object.entries(priorities).map(([value, label]) => (
                <NativeSelectOption key={value} value={value}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} type="submit">
              Enregistrer
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              type="button"
              onClick={() => {
                setDraft(null);
                setError(false);
              }}
            >
              Annuler
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              Impossible d’enregistrer le classement.
            </p>
          )}
        </form>
      ) : classification ? (
        <ClassificationBadges classification={classification} pending={pending} />
      ) : (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {pending ? "Classement en cours…" : "Classement automatique en attente"}
        </p>
      )}
    </section>
  );
}
