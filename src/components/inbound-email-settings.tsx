import { useMutation, useQuery } from "convex/react";
import { Copy, Mail, Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { EmailReaderDialog } from "./email-reader-dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";

const receiptStatuses: Record<string, string> = {
  processed: "Reçu",
  failed: "Traitement en échec",
  paused: "Traitement en pause",
  uploading: "Import incomplet",
};

export function InboundEmailSettings({ shopId }: { shopId: Id<"shops"> }) {
  const connection = useQuery(api.emailInbox.connection, { shopId });
  const receipts = useQuery(api.emailInbox.recent, { shopId });
  const beginTest = useMutation(api.emailInbox.beginTest);
  const setEnabled = useMutation(api.emailInbox.setEnabled);
  const retry = useMutation(api.emailInbox.retry);
  const provision = useMutation(api.inboundEmailRoutes.ensureForShop);
  const [supportEmail, setSupportEmail] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Id<"emailReceipts"> | null>(null);
  const testExpiresAt = connection?.testExpiresAt;
  const [expiredAt, setExpiredAt] = useState(0);

  useEffect(() => {
    if (!testExpiresAt) return;
    const timer = window.setTimeout(
      () => setExpiredAt(testExpiresAt),
      Math.max(0, testExpiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [testExpiresAt]);

  async function perform(task: () => Promise<unknown>, success = "") {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await task();
      setNotice(success);
    } catch {
      setError("Impossible de terminer cette action. Vérifiez la connexion puis réessayez.");
    } finally {
      setBusy(false);
    }
  }

  if (!connection) return <Skeleton className="h-52 w-full" />;
  const {
    address,
    supportEmail: savedEmail,
    enabled,
    verified,
    canManage,
    shopDisabled,
  } = connection;
  const currentEmail = supportEmail ?? savedEmail;
  const testSubject = connection.testSubject;
  const testExpired = Boolean(testExpiresAt && testExpiresAt <= expiredAt);
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Transfert des emails</CardTitle>
            <Badge variant={verified && enabled ? "default" : "secondary"}>
              {address && !enabled
                ? "En pause"
                : verified
                  ? "Vérifié"
                  : testSubject && !testExpired
                    ? "En attente du test"
                    : address
                      ? "À vérifier"
                      : "À configurer"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          )}
          {shopDisabled && <p className="text-sm">Cette boutique est désactivée.</p>}
          {!address ? (
            canManage && (
              <Button
                disabled={busy || shopDisabled}
                onClick={() => void perform(() => provision({ shopId }))}
              >
                Créer l’adresse de réception
              </Button>
            )
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Adresse HandleFast</p>
                  <p className="break-all text-sm font-medium">{address}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void perform(() => navigator.clipboard.writeText(address), "Adresse copiée.")
                  }
                >
                  <Copy data-icon="inline-start" /> Copier
                </Button>
              </div>
              <details className="rounded-lg border px-3 py-2" open={verified ? undefined : true}>
                <summary className="cursor-pointer py-1 text-sm font-medium">
                  Configurer ou vérifier le transfert
                </summary>
                <div className="space-y-3 py-3 text-sm text-muted-foreground">
                  <p>
                    Ajoutez l’adresse HandleFast dans les réglages de transfert de votre messagerie
                    et conservez une copie des emails dans votre boîte.
                  </p>
                  <p>
                    Si Gmail envoie une confirmation, ouvrez-la dans le journal ci-dessous et
                    validez le lien avant d’activer le transfert. Envoyez ensuite un test pour
                    vérifier qu’un email adressé à votre SAV arrive bien dans HandleFast.
                  </p>
                  <a
                    className="inline-block text-primary underline"
                    href="https://support.google.com/mail/answer/10957"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Aide Gmail
                  </a>
                  {canManage && (
                    <form
                      className="space-y-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void perform(
                          () => beginTest({ shopId, supportEmail: currentEmail }),
                          "Test prêt. Envoyez un email depuis une autre boîte avec l’objet indiqué.",
                        );
                      }}
                    >
                      <label className="block font-medium text-foreground" htmlFor="support-email">
                        Adresse SAV
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <Input
                          id="support-email"
                          type="email"
                          required
                          maxLength={320}
                          className="w-full sm:w-72"
                          placeholder="sav@boutique.fr"
                          value={currentEmail}
                          onChange={(event) => setSupportEmail(event.target.value)}
                        />
                        <Button type="submit" disabled={busy || !enabled}>
                          Préparer un test
                        </Button>
                      </div>
                    </form>
                  )}
                  {testSubject && !verified && enabled && (
                    <div className="space-y-2 rounded-lg bg-muted p-3">
                      <p>
                        Destinataire <strong>{savedEmail}</strong>
                      </p>
                      <p className="break-all">
                        Objet <code>{testSubject}</code>
                      </p>
                      <p>
                        {testExpired
                          ? "Test expiré. Préparez un nouveau test."
                          : "Envoyez le test depuis une autre boîte mail. L’objet est valide 30 minutes."}
                      </p>
                      {!testExpired && (
                        <div className="flex flex-wrap gap-2">
                          <Button asChild size="sm">
                            <a
                              href={`mailto:${encodeURIComponent(savedEmail).replace("%40", "@")}?subject=${encodeURIComponent(testSubject)}&body=${encodeURIComponent("Bonjour, je vérifie la réception des e-mails SAV de la boutique.")}`}
                            >
                              Ouvrir le brouillon de test
                            </a>
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              void perform(
                                () => navigator.clipboard.writeText(testSubject),
                                "Objet copié.",
                              )
                            }
                          >
                            Copier l’objet
                          </Button>
                        </div>
                      )}
                      <p>
                        Gmail ne transfère pas les spams. Si le test est dans Spam, cliquez sur «
                        Non-spam » dans Gmail puis envoyez un nouveau message de test.
                      </p>
                    </div>
                  )}
                </div>
              </details>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {connection.lastReceivedAt
                    ? `Dernier email reçu le ${new Date(connection.lastReceivedAt).toLocaleString("fr-FR")}`
                    : "En attente du premier email"}
                </p>
                {canManage && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || shopDisabled}
                    onClick={() => void perform(() => setEnabled({ shopId, enabled: !enabled }))}
                  >
                    {enabled ? (
                      <Pause data-icon="inline-start" />
                    ) : (
                      <Play data-icon="inline-start" />
                    )}
                    {enabled ? "Mettre en pause" : "Reprendre la réception"}
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <Card className="gap-0 pb-0">
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Journal de réception</CardTitle>
        </CardHeader>
        {!receipts ? (
          <div className="p-4">
            <Skeleton className="h-16 w-full" />
          </div>
        ) : receipts.length === 0 ? (
          <p className="border-t p-5 text-sm text-muted-foreground">Aucun email reçu.</p>
        ) : (
          <ul className="divide-y border-t">
            {receipts.map((receipt) => (
              <li className="flex flex-wrap items-center gap-3 p-4 sm:px-6" key={receipt.id}>
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <Mail className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">{receipt.subject}</p>
                  <p className="break-all text-xs text-muted-foreground">{receipt.from}</p>
                </div>
                <Badge variant="secondary">
                  {receiptStatuses[receipt.status] ?? "En traitement"}
                </Badge>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!receipt.hasOriginal}
                    onClick={() => setSelected(receipt.id)}
                  >
                    Ouvrir
                  </Button>
                  {canManage && (receipt.status === "failed" || receipt.status === "paused") && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || !enabled}
                      onClick={() =>
                        void perform(() => retry({ receiptId: receipt.id }), "Traitement relancé.")
                      }
                    >
                      Relancer
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <EmailReaderDialog selected={selected} close={() => setSelected(null)} />
    </div>
  );
}
