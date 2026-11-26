import { useEffect, useRef, useState } from "react";
import {
  type GmailImportCounts,
  gmailReadScope,
  importGmailHistory,
  loadGoogleAuthorization,
} from "@/lib/gmail-history";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

export function GmailHistoryImport({
  shopId,
  address,
  clientId,
}: {
  shopId: Id<"shops">;
  address: string;
  clientId: string;
}) {
  const [oauth, setOAuth] = useState<Awaited<ReturnType<typeof loadGoogleAuthorization>>>();
  const [counts, setCounts] = useState<GmailImportCounts>();
  const [status, setStatus] = useState<"idle" | "authorizing" | "running" | "complete">("idle");
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    void loadGoogleAuthorization().then(
      (client) => active && setOAuth(client),
      () => active && setError("La connexion Google est indisponible. Rechargez cette page."),
    );
    return () => {
      active = false;
      pending.current?.abort();
    };
  }, []);

  function connect() {
    if (!oauth || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setCounts(undefined);
    setStatus("authorizing");
    setError("");
    function fail(message: string) {
      if (controller.signal.aborted) return;
      pending.current = null;
      setStatus("idle");
      setError(message);
    }
    try {
      oauth
        .initTokenClient({
          client_id: clientId,
          scope: gmailReadScope,
          include_granted_scopes: false,
          error_callback: () => fail("La fenêtre Google a été fermée ou bloquée."),
          callback: (response) => {
            if (controller.signal.aborted) return;
            if (
              response.error ||
              !response.access_token ||
              !response.scope?.split(" ").includes(gmailReadScope)
            ) {
              fail("Autorisez la lecture des e-mails dans la fenêtre Google pour lancer l’import.");
              return;
            }
            setStatus("running");
            void importGmailHistory({
              token: response.access_token,
              address,
              shopId,
              signal: controller.signal,
              report: (progress) => !controller.signal.aborted && setCounts(progress),
            }).then(
              (result) => {
                if (controller.signal.aborted) return;
                pending.current = null;
                setCounts(result);
                setStatus("complete");
              },
              (reason: unknown) =>
                fail(
                  reason instanceof Error && reason.message === "GmailExpired"
                    ? "La connexion Google a expiré. Reconnectez-vous pour reprendre sans doublons."
                    : "L’import a été interrompu. Relancez-le pour reprendre sans doublons.",
                ),
            );
          },
        })
        .requestAccessToken({ prompt: "select_account" });
    } catch {
      fail("Impossible d’ouvrir la connexion Google.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Importer l’historique Gmail</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Importez les messages reçus et envoyés pour {address} sur les 12 derniers mois. L’import
          ne déclenche aucun envoi.
        </p>
        <Button
          type="button"
          size="sm"
          disabled={!oauth || status === "authorizing" || status === "running"}
          onClick={connect}
        >
          {status === "authorizing"
            ? "Connexion à Google…"
            : status === "running"
              ? "Import en cours…"
              : "Connecter Gmail et importer"}
        </Button>
        {status === "running" && <p>Gardez cet onglet ouvert pendant l’import.</p>}
        {counts && (
          <p role="status">
            {status === "complete" && "Import terminé. "}
            {counts.imported} importés · {counts.duplicate} déjà présents · {counts.skipped} ignorés
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
