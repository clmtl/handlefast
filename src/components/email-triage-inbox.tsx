import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { EmailReader } from "./inbound-email-settings";

const buckets = { sav: "SAV", review: "À vérifier", other: "Hors SAV" } as const;
const reasons: Record<string, string> = {
  post_purchase: "Demande d’aide après achat",
  presales: "Question avant achat",
  promotion: "Publicité ou démarchage",
  automatic: "Notification automatique",
  unclear: "Contexte insuffisant ou classement incertain",
  manual: "Classement corrigé manuellement",
  unavailable: "Tri automatique indisponible : vérification nécessaire",
  budget: "Plafond du tri automatique atteint",
  empty: "Message vide ou composé uniquement de pièces jointes",
  too_long: "Message long : vérification nécessaire",
};
const button =
  "rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";
type Bucket = keyof typeof buckets;

export function EmailTriageInbox({ shopId }: { shopId: Id<"shops"> }) {
  const [bucket, setBucket] = useState<Bucket>("sav");
  return (
    <section className="mb-6 rounded-lg border bg-card p-5">
      <h2 className="text-xl font-semibold">Boîte SAV</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Les nouveaux emails sont triés automatiquement. Vérifiez régulièrement les messages
        incertains. Les originaux restent disponibles pendant 12 mois.
      </p>
      <fieldset className="my-5 flex flex-wrap gap-2" aria-label="Classement des emails">
        {Object.entries(buckets).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={bucket === value}
            className={
              bucket === value
                ? `${button} bg-primary text-primary-foreground hover:bg-primary/90`
                : button
            }
            onClick={() => setBucket(value as Bucket)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <TriageList key={`${shopId}:${bucket}`} shopId={shopId} bucket={bucket} />
    </section>
  );
}

function TriageList({ shopId, bucket }: { shopId: Id<"shops">; bucket: Bucket }) {
  const [asOf] = useState(() => Date.now());
  const { results, status, loadMore } = usePaginatedQuery(
    api.emailTriage.list,
    { shopId, bucket, asOf },
    { initialNumItems: 25 },
  );
  const permissions = useQuery(api.emailTriage.permissions, { shopId });
  const reclassify = useMutation(api.emailTriage.reclassify);
  const [selected, setSelected] = useState<Id<"emailReceipts"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function move(receiptId: Id<"emailReceipts">, target: Bucket) {
    setBusy(true);
    setError("");
    try {
      await reclassify({ receiptId, bucket: target });
    } catch {
      setError("Le classement n’a pas pu être modifié. Réessayez.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {status === "LoadingFirstPage" ? (
        <p>Chargement…</p>
      ) : (
        results.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Aucun email dans cet espace. Les anciens messages et les confirmations de connexion sont
            accessibles dans le journal de réception ci-dessous.
          </p>
        )
      )}
      <ul className="divide-y">
        {results.map((email) => (
          <li key={email.id} className="py-4">
            <p className="break-words font-medium">{email.subject}</p>
            <p className="mt-1 break-all text-sm text-muted-foreground">
              {email.from} · {new Date(email.receivedAt).toLocaleString()}
            </p>
            <p className="mt-2 break-words text-sm">{email.snippet}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {reasons[email.reason] ?? "À vérifier"}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className={button} type="button" onClick={() => setSelected(email.id)}>
                Ouvrir
              </button>
              {permissions?.canCorrect &&
                Object.entries(buckets)
                  .filter(([value]) => value !== bucket)
                  .map(([value, label]) => (
                    <button
                      key={value}
                      className={button}
                      type="button"
                      disabled={busy}
                      onClick={() => void move(email.id, value as Bucket)}
                    >
                      Déplacer vers {label}
                    </button>
                  ))}
            </div>
          </li>
        ))}
      </ul>
      {status === "CanLoadMore" && (
        <button type="button" className={button} onClick={() => loadMore(25)}>
          Afficher la suite
        </button>
      )}
      {status === "LoadingMore" && <p>Chargement…</p>}
      {selected && (
        <EmailReader key={selected} receiptId={selected} close={() => setSelected(null)} />
      )}
    </>
  );
}
