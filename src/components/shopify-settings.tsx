import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

const button =
  "rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";
export function ShopifySettings({ shopId }: { shopId: Id<"shops"> }) {
  const status = useQuery(api.shopifyConnection.status, { shopId });
  const begin = useMutation(api.shopifyConnection.begin);
  const disconnect = useMutation(api.shopifyConnection.disconnect);
  const sync = useMutation(api.shopifySync.request);
  const [domain, setDomain] = useState("");
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
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
  const endpoint = import.meta.env.VITE_CONVEX_SITE_URL as string | undefined;
  const command =
    pair && endpoint
      ? `node handlefast-shopify-connect.mjs --endpoint "${endpoint}" --code "${pair.code}"`
      : "";
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
                    setPair(null);
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
        <div className="mt-4">
          <p className="mb-3 max-w-3xl text-sm text-muted-foreground">
            Une app dédiée sera créée avec Shopify CLI dans votre compte Shopify, puis rattachée
            automatiquement à cette organisation HandleFast. L’app demande uniquement la lecture des
            commandes. Vous approuvez l’installation dans Shopify.
          </p>
          {(!status.encryptionConfigured || !endpoint) && (
            <p role="status" className="mb-3 text-sm text-destructive">
              La connexion doit être activée par l’administrateur HandleFast.
            </p>
          )}
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                setPair(await begin({ shopId, domain }));
                setCopied(false);
              });
            }}
          >
            <label className="sr-only" htmlFor={`shopify-domain-${shopId}`}>
              Domaine Shopify
            </label>
            <input
              id={`shopify-domain-${shopId}`}
              className="min-w-64 rounded-md border bg-background px-3 py-2 text-sm"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              placeholder="ma-boutique.myshopify.com"
              required
              maxLength={100}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <button
              className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}
              type="submit"
              disabled={busy || !status.encryptionConfigured || !endpoint}
            >
              Préparer la connexion
            </button>
          </form>
          {pair && command && (
            <ol className="mt-5 space-y-3 text-sm">
              <li>
                1.{" "}
                <a
                  className="text-primary underline"
                  href="https://nodejs.org/en/download"
                  target="_blank"
                  rel="noreferrer"
                >
                  Installez Node.js 22.12 ou plus récent
                </a>
                , puis{" "}
                <a
                  className="text-primary underline"
                  href="/handlefast-shopify-connect.mjs"
                  download
                >
                  téléchargez le connecteur HandleFast
                </a>
                .
              </li>
              <li>
                2. Ouvrez un terminal dans le dossier téléchargé et lancez cette commande :
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-md border bg-background p-3">
                  {command}
                </pre>
                <button
                  className={`${button} mt-2`}
                  type="button"
                  onClick={() =>
                    void perform(async () => {
                      await navigator.clipboard.writeText(command);
                      setCopied(true);
                    })
                  }
                >
                  {copied ? "Commande copiée" : "Copier la commande"}
                </button>
              </li>
              <li>
                3. Connectez-vous à Shopify, choisissez l’organisation qui possède la boutique et
                approuvez l’installation.
              </li>
              <li className="text-muted-foreground">
                La commande expire à {new Date(pair.expiresAt).toLocaleTimeString()}. Elle est
                personnelle et utilisable une seule fois. Cette page se met à jour après la
                connexion.
              </li>
            </ol>
          )}
        </div>
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
