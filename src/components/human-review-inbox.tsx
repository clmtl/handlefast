import { usePaginatedQuery, useQuery } from "convex/react";
import { BellRing } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { categories, priorities } from "../../convex/lib/emailClassificationPolicy";
import { reviewStatuses } from "../../convex/lib/humanReviewPolicy";
import { EmailReader } from "./inbound-email-settings";

const button =
  "rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";
type Status = keyof typeof reviewStatuses;

export function HumanReviewInbox({ shopId }: { shopId: Id<"shops"> }) {
  const [asOf] = useState(() => Date.now()),
    [status, setStatus] = useState<Status>("open");
  const counts = useQuery(api.humanReviews.overview, { shopId, asOf });
  return (
    <section className="mb-6 rounded-lg border bg-card p-5" aria-label="Demandes à traiter">
      <div className="flex items-center gap-2">
        <BellRing className="size-5 text-primary" aria-hidden="true" />
        <h2 className="text-xl font-semibold">Demandes à traiter</h2>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={`mt-3 rounded-md border p-3 text-sm ${counts?.open ? "border-amber-600 bg-amber-50 text-amber-950" : "border-slate-500"}`}
      >
        {counts
          ? `${counts.open}${counts.openMore ? "+" : ""} demande${counts.open !== 1 ? "s" : ""} en attente de votre intervention · ${counts.inProgress}${counts.inProgressMore ? "+" : ""} en cours.`
          : "Chargement des alertes…"}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Les emails qui nécessitent une validation humaine sont regroupés ici, avec un résumé et une
        proposition à vérifier. Les anciens emails peuvent être préparés depuis leur lecteur dans la
        boîte SAV.
      </p>
      <fieldset className="my-4 flex flex-wrap gap-2" aria-label="État des demandes">
        {Object.entries(reviewStatuses).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={
              status === value
                ? `${button} bg-primary text-primary-foreground hover:bg-primary/90`
                : button
            }
            aria-pressed={status === value}
            onClick={() => setStatus(value as Status)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <ReviewList key={`${shopId}:${status}`} shopId={shopId} status={status} asOf={asOf} />
    </section>
  );
}

function ReviewList({
  shopId,
  status,
  asOf,
}: {
  shopId: Id<"shops">;
  status: Status;
  asOf: number;
}) {
  const {
    results,
    status: loading,
    loadMore,
  } = usePaginatedQuery(api.humanReviews.list, { shopId, status, asOf }, { initialNumItems: 20 });
  const [selected, setSelected] = useState<Id<"emailReceipts"> | null>(null);
  return (
    <>
      {selected && (
        <div className="mb-4">
          <EmailReader
            key={selected}
            receiptId={selected}
            close={() => setSelected(null)}
            refreshOrderOnOpen={false}
          />
        </div>
      )}
      {loading === "LoadingFirstPage" ? (
        <p className="text-sm">Chargement…</p>
      ) : (
        !results.length && (
          <p className="text-sm text-muted-foreground">Aucune demande dans cet état.</p>
        )
      )}
      <ul className="divide-y">
        {results.map((item) => (
          <li key={item.receiptId} className="py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="break-words font-medium">{item.subject}</h3>
              {item.priority && (
                <span
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium ${item.priority === "urgent" ? "border-red-600 bg-red-50 text-red-900" : item.priority === "high" ? "border-amber-600 bg-amber-50 text-amber-900" : "border-slate-500"}`}
                >
                  Importance {priorities[item.priority].toLowerCase()}
                </span>
              )}
            </div>
            <p className="mt-1 break-all text-sm text-muted-foreground">
              {item.from} · {new Date(item.receivedAt).toLocaleString()}
            </p>
            {item.category && (
              <p className="mt-2 text-sm font-medium">{categories[item.category]}</p>
            )}
            <p className="mt-2 whitespace-pre-wrap break-words text-sm">
              {item.summary ??
                (item.pending
                  ? "Résumé en préparation ; vous pouvez déjà traiter la demande."
                  : "Ouvrez l’email pour préparer le traitement.")}
            </p>
            <button
              className={`${button} mt-3`}
              type="button"
              onClick={() => setSelected(item.receiptId)}
            >
              Ouvrir et traiter
            </button>
          </li>
        ))}
      </ul>
      {loading === "CanLoadMore" && (
        <button className={button} type="button" onClick={() => loadMore(20)}>
          Afficher la suite
        </button>
      )}
      {loading === "LoadingMore" && (
        <p role="status" className="text-sm">
          Chargement…
        </p>
      )}
    </>
  );
}
