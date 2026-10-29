import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

const button =
  "rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";
export function ShopifyGuidedConnect({
  shopId,
  disabled,
}: {
  shopId: Id<"shops">;
  disabled: boolean;
}) {
  const start = useAction(api.shopifyGuidedActions.start),
    poll = useAction(api.shopifyGuidedActions.poll),
    provision = useAction(api.shopifyGuidedActions.provision),
    cancel = useMutation(api.shopifyGuided.cancel);
  const [domain, setDomain] = useState("");
  const [sessionId, setSessionId] = useState<Id<"shopifyGuidedSessions"> | null>(null);
  const session = useQuery(api.shopifyGuided.get, sessionId ? { sessionId } : "skip");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [now, setNow] = useState(Date.now());
  const popup = useRef<Window | null>(null),
    submitting = useRef(false),
    provisioned = useRef<string | null>(null);
  const storageKey = `handlefast:shopify-guided:${shopId}`;
  useEffect(() => {
    const saved = sessionStorage.getItem(storageKey);
    if (saved && /^[a-z0-9]{25,64}$/.test(saved))
      setSessionId(saved as Id<"shopifyGuidedSessions">);
  }, [storageKey]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = Boolean(session && session.expiresAt <= now);
  const working = Boolean(
    session &&
      ["provisioning", "installing"].includes(session.status) &&
      (session.leaseUntil ?? 0) > now &&
      !expired,
  );
  useEffect(() => {
    if (!sessionId || session?.status !== "pending" || expired) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      try {
        await poll({ sessionId });
      } catch {
        if (!disposed) setError("Connexion interrompue. Revenez sur cette page pour réessayer.");
      }
      if (!disposed) timer = setTimeout(run, 5000);
    };
    timer = setTimeout(run, Math.max(1000, session.nextPollAt - Date.now()));
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [poll, sessionId, session?.status, session?.nextPollAt, expired]);
  useEffect(() => {
    if (session?.status === "pending" && session.verificationUrl && popup.current) {
      popup.current.location.replace(session.verificationUrl);
      popup.current = null;
    }
  }, [session?.status, session?.verificationUrl]);
  useEffect(() => {
    if (
      !sessionId ||
      session?.status !== "authorized" ||
      expired ||
      provisioned.current === sessionId
    )
      return;
    provisioned.current = sessionId;
    setBusy(true);
    void provision({ sessionId })
      .catch(() => setError("La préparation a été interrompue. Réessayez."))
      .finally(() => setBusy(false));
  }, [sessionId, session?.status, expired, provision]);
  useEffect(() => {
    if (session?.status === "ready" && session.authorizationUrl && !session.errorCode && !expired)
      window.location.assign(session.authorizationUrl);
  }, [session?.status, session?.authorizationUrl, session?.errorCode, expired]);
  async function begin(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    popup.current = window.open("about:blank", "_blank");
    if (popup.current) popup.current.opener = null;
    try {
      const id = await start({ shopId, domain });
      sessionStorage.setItem(storageKey, id);
      setSessionId(id);
    } catch {
      popup.current?.close();
      popup.current = null;
      setError("Impossible de démarrer. Vérifiez le lien de votre boutique puis réessayez.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function reset() {
    setBusy(true);
    setError("");
    try {
      if (sessionId && session) await cancel({ sessionId });
      sessionStorage.removeItem(storageKey);
      setSessionId(null);
      provisioned.current = null;
    } catch {
      setError("Une étape est encore en cours. Réessayez dans quelques instants.");
    } finally {
      setBusy(false);
    }
  }
  const failure = expired
    ? "Cette autorisation a expiré. Recommencez la connexion."
    : session?.errorCode
      ? guidedError(session.errorCode)
      : error;
  return (
    <div className="mt-4">
      {!sessionId ? (
        <form onSubmit={begin} className="space-y-3">
          <p className="max-w-3xl text-sm text-muted-foreground">
            Renseignez le lien de votre boutique. Autorisez la connexion sur Shopify, puis revenez
            ici pour terminer l’installation. Votre boutique sera rattachée automatiquement à cette
            organisation HandleFast.
          </p>
          <label className="block text-sm font-medium" htmlFor={`shopify-domain-${shopId}`}>
            Lien de votre boutique Shopify
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={`shopify-domain-${shopId}`}
              className="min-w-64 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="https://admin.shopify.com/store/ma-boutique"
              required
              maxLength={253}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <button
              className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}
              type="submit"
              disabled={busy || disabled}
            >
              {busy ? "Ouverture de Shopify…" : "Connecter ma boutique"}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Utilisez le lien de votre interface Shopify ou l’adresse de la boutique en
            .myshopify.com.
          </p>
        </form>
      ) : session === undefined ? (
        <p role="status">Préparation de la connexion…</p>
      ) : session === null ? (
        <p>Cette connexion a expiré.</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm font-medium">{session.domain}</p>
          {session.status === "initializing" && !expired && (
            <p role="status">Préparation de l’autorisation Shopify…</p>
          )}
          {session.status === "pending" && !expired && (
            <>
              <p className="text-sm">
                Sur la page Shopify ouverte, vérifiez le code et acceptez la connexion « Shopify CLI
                », puis revenez ici.
              </p>
              <div className="w-fit rounded-lg border bg-background px-6 py-3 font-mono text-2xl font-semibold tracking-widest">
                {session.userCode}
              </div>
              <p className="text-sm text-muted-foreground">
                Cette autorisation permet de créer l’app HandleFast dans votre compte Shopify. L’app
                demandera uniquement la lecture de vos commandes.
              </p>
              <a
                className={`${button} inline-block`}
                href={session.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Ouvrir la page Shopify
              </a>
              <p role="status" className="text-sm text-muted-foreground">
                En attente de votre autorisation…
              </p>
            </>
          )}
          {["authorized", "provisioning"].includes(session.status) && !expired && (
            <p role="status" className="text-sm">
              Préparation de l’app dans l’organisation propriétaire de votre boutique…
            </p>
          )}
          {session.status === "ready" && !expired && (
            <>
              <p role="status" className="text-sm">
                Votre boutique est prête. Shopify va vous demander de confirmer l’installation.
              </p>
              <a className={`${button} inline-block`} href={session.authorizationUrl}>
                Continuer vers l’installation Shopify
              </a>
            </>
          )}
          {session.status === "connected" && <p role="status">Boutique connectée.</p>}
          {session.status === "provisioning" && !working && !expired && (
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => {
                if (sessionId) void provision({ sessionId });
              }}
            >
              Reprendre la préparation
            </button>
          )}
          {session.status === "authorized" && error && (
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => {
                setError("");
                if (sessionId) void provision({ sessionId });
              }}
            >
              Réessayer
            </button>
          )}
        </div>
      )}
      {failure && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {failure}
        </p>
      )}
      {sessionId && !working && (
        <button
          type="button"
          className={`${button} mt-4`}
          disabled={busy}
          onClick={() => void reset()}
        >
          {failure || session === null ? "Recommencer la connexion" : "Annuler"}
        </button>
      )}
      {disabled && (
        <p className="mt-3 text-sm text-destructive">
          La connexion doit être activée par l’administrateur HandleFast.
        </p>
      )}
    </div>
  );
}
function guidedError(code: string) {
  if (code === "SHOPIFY_AUTH_EXPIRED")
    return "Cette autorisation a expiré. Recommencez la connexion.";
  if (["SHOPIFY_AUTH_DENIED", "SHOPIFY_AUTH_CANCELLED"].includes(code))
    return "L’autorisation Shopify a été annulée.";
  if (["SHOPIFY_STORE_NOT_ACCESSIBLE", "SHOPIFY_STORE_ORGANIZATION_UNAVAILABLE"].includes(code))
    return "Cette boutique n’est pas accessible avec ce compte Shopify. Vérifiez son lien et utilisez le compte qui la gère.";
  if (code === "SHOPIFY_APP_RECOVERY_PENDING")
    return "Une app a déjà été demandée. Réessayez pour reprendre cette création sans créer de doublon.";
  if (code === "SHOPIFY_INSTALL_FAILED")
    return "L’installation n’a pas pu être vérifiée. Réessayez l’installation sur Shopify.";
  return "Shopify n’a pas pu terminer cette étape. Réessayez dans quelques instants.";
}
