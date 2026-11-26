import { useState } from "react";
import {
  indexTakeout,
  maxTakeoutMessageBytes,
  type TakeoutMessage,
  takeoutOriginal,
} from "@/lib/takeout-mbox";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";

type Counts = { imported: number; duplicate: number; skipped: number };

export function TakeoutImport({ shopId, address }: { shopId: Id<"shops">; address: string }) {
  const [preview, setPreview] = useState<TakeoutMessage[]>([]);
  const [counts, setCounts] = useState<Counts>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function prepare(files: File[]) {
    setBusy(true);
    setError("");
    setCounts(undefined);
    setPreview([]);
    try {
      const messages: TakeoutMessage[] = [];
      for (const file of files) {
        for (const message of await indexTakeout(file)) messages.push(message);
      }
      messages.sort((a, b) => a.date - b.date);
      setPreview(messages);
      if (!messages.length)
        setError(
          "Aucun message trouvé. Sélectionnez les fichiers .mbox extraits de Google Takeout.",
        );
    } catch {
      setError("Impossible de lire les fichiers sélectionnés.");
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    setBusy(true);
    setError("");
    const result: Counts = { imported: 0, duplicate: 0, skipped: 0 };
    setCounts(result);
    try {
      for (const message of preview) {
        if (message.end - message.start > maxTakeoutMessageBytes) {
          result.skipped++;
        } else {
          const params = new URLSearchParams({ shop: shopId, date: String(message.date) });
          const response = await fetch(`/api/takeout?${params}`, {
            method: "POST",
            headers: { "Content-Type": "message/rfc822" },
            body: await takeoutOriginal(message),
          });
          if (!response.ok) throw new Error("Import interrompu");
          const reply: unknown = await response.json();
          const status =
            reply && typeof reply === "object" && "result" in reply ? reply.result : null;
          if (status !== "imported" && status !== "duplicate" && status !== "skipped")
            throw new Error("Résultat inconnu");
          result[status]++;
        }
        setCounts({ ...result });
      }
      setPreview([]);
    } catch {
      setError(
        "L’import a été interrompu. Relancez-le avec les mêmes fichiers pour continuer sans doublons.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Importer l’historique Gmail</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Sélectionnez les fichiers .mbox des messages reçus et envoyés pour {address}. L’import ne
          déclenche aucun envoi.
        </p>
        <Input
          aria-label="Fichiers MBOX de Google Takeout"
          type="file"
          accept=".mbox"
          multiple
          disabled={busy}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length) void prepare(files);
          }}
        />
        {preview.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <p>{preview.length} messages dans les fichiers sélectionnés.</p>
            <Button type="button" size="sm" disabled={busy} onClick={() => void run()}>
              Importer les messages
            </Button>
          </div>
        )}
        {counts && (
          <div>
            <p role="status">
              {counts.imported} importés · {counts.duplicate} déjà présents · {counts.skipped}{" "}
              ignorés
            </p>
            {counts.skipped > 0 && (
              <p className="text-muted-foreground">
                Les messages hors boutique, expirés, invalides, trop volumineux, les brouillons et
                les spams sont ignorés.
              </p>
            )}
          </div>
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
