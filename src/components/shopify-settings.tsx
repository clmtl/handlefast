import { useMutation, useQuery } from "convex/react";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ShopifyGuidedConnect } from "./shopify-guided-connect";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Skeleton } from "./ui/skeleton";

export function ShopifySettings({ shopId }: { shopId: Id<"shops"> }) {
  const status = useQuery(api.shopifyConnection.status, { shopId });
  const disconnect = useMutation(api.shopifyConnection.disconnect);
  const sync = useMutation(api.shopifySync.request);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  async function perform(task: () => Promise<unknown>, failure: string) {
    setBusy(true);
    setError("");
    try {
      await task();
      return true;
    } catch {
      setError(failure);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <Skeleton className="h-52 w-full" />;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="break-all text-base">
            {status.connected ? status.domain : "Connecter une boutique"}
          </CardTitle>
          <Badge variant={status.connected ? "default" : "secondary"}>
            {status.connected ? "Connectée" : "À connecter"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.connected ? (
          <>
            <p className="text-sm text-muted-foreground">
              {status.syncing
                ? "Synchronisation en cours…"
                : status.syncedAt
                  ? `Dernière synchronisation le ${new Date(status.syncedAt).toLocaleString("fr-FR")}`
                  : "Première synchronisation en attente."}
            </p>
            {status.error && (
              <p role="status" className="text-sm text-destructive">
                La dernière synchronisation a échoué. Une nouvelle tentative est prévue.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {status.canRefresh && (
                <Button
                  variant="outline"
                  disabled={busy || status.syncing}
                  onClick={() =>
                    void perform(
                      () => sync({ shopId }),
                      "Impossible de demander une nouvelle synchronisation.",
                    )
                  }
                >
                  <RefreshCw data-icon="inline-start" /> Actualiser les commandes
                </Button>
              )}
              {status.canManage && (
                <Button variant="ghost" disabled={busy} onClick={() => setConfirm(true)}>
                  Déconnecter Shopify
                </Button>
              )}
            </div>
            <Dialog open={confirm} onOpenChange={(open) => !busy && setConfirm(open)}>
              <DialogContent showCloseButton={!busy}>
                <DialogHeader>
                  <DialogTitle>Déconnecter Shopify</DialogTitle>
                  <DialogDescription>
                    La synchronisation de {status.domain} sera arrêtée. Pour révoquer aussi l’accès
                    dans Shopify, désinstallez HandleFast depuis votre boutique.
                  </DialogDescription>
                </DialogHeader>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
                <DialogFooter>
                  <Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>
                    Annuler
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await perform(
                          () => disconnect({ shopId }),
                          "Impossible de déconnecter Shopify.",
                        )
                      )
                        setConfirm(false);
                    }}
                  >
                    Déconnecter
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        ) : status.canManage ? (
          <ShopifyGuidedConnect shopId={shopId} disabled={!status.encryptionConfigured} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Un propriétaire ou un administrateur peut connecter cette boutique.
          </p>
        )}
        {error && !confirm && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-sm text-muted-foreground">
          <span>Suivi des colis via 17TRACK</span>
          <Badge variant="secondary">
            {status.trackingConfigured ? "Configuré" : "À configurer"}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
