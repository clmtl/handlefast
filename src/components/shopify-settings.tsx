import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ShopifyGuidedConnect } from "./shopify-guided-connect";

const button =
  "rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";
export function ShopifySettings({ shopId }: { shopId: Id<"shops"> }) {
  const status = useQuery(api.shopifyConnection.status, { shopId });
  const disconnect = useMutation(api.shopifyConnection.disconnect);
  const sync = useMutation(api.shopifySync.request);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function perform(task: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch {
      setError(
        "Connexion impossible. Vérifiez le domaine, votre rôle et la configuration, puis réessayez.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!status) return <p>Chargement de Shopify…</p>;
  return (
    <section className="mb-6 rounded-lg border bg-card p-5" aria-label="Connexion Shopify">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Votre boutique Shopify</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Commandes, paiements et suivi des colis au même endroit que vos emails.
          </p>
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-sm ${status.connected ? "border-primary text-primary" : ""}`}
        >
          {status.connected ? "Connectée" : "À connecter"}
        </span>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {status.connected ? (
        <div className="mt-4 space-y-3">
          <p className="font-medium">{status.domain}</p>
          <p className="text-sm text-muted-foreground">
            {status.syncing
              ? "Synchronisation en cours…"
              : status.syncedAt
                ? `Dernière synchronisation : ${new Date(status.syncedAt).toLocaleString()}`
                : "Première synchronisation en attente."}
          </p>
          {status.error && (
            <p role="status" className="text-sm text-destructive">
              La dernière synchronisation a échoué. Les informations conservées restent consultables
              ; une nouvelle tentative est prévue.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {status.canRefresh && (
              <button
                type="button"
                className={button}
                disabled={busy || status.syncing}
                onClick={() => void perform(() => sync({ shopId }))}
              >
                Actualiser les commandes
              </button>
            )}
            {status.canManage && (
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await disconnect({ shopId });
                  })
                }
              >
                Déconnecter Shopify
              </button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Pour retirer aussi l’autorisation dans Shopify, désinstallez l’app dans les paramètres
            de votre boutique.
          </p>
        </div>
      ) : status.canManage ? (
        <ShopifyGuidedConnect shopId={shopId} disabled={!status.encryptionConfigured} />
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          Un propriétaire ou administrateur peut connecter cette boutique.
        </p>
      )}
      <p className="mt-4 text-sm text-muted-foreground">
        17TRACK :{" "}
        {status.trackingConfigured ? "suivi activé" : "en attente de configuration HandleFast"}.
        L’historique Shopify disponible par défaut couvre 60 jours.
      </p>
    </section>
  );
}
