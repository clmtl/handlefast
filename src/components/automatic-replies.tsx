import { useMutation, useQuery } from "convex/react";
import { Bot, Pause, Play, Settings2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  autoReplyStatuses,
  defaultReplyRules,
  type ReplyRule,
} from "../../convex/lib/automaticReplyPolicy";
import {
  type Category,
  categories,
  type Priority,
  priorities,
} from "../../convex/lib/emailClassificationPolicy";
import { supportedEmailLanguage } from "../../convex/lib/shopLanguage";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader } from "./ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Skeleton } from "./ui/skeleton";

const button =
  "rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";

export function AutomaticReplySettings({ shopId }: { shopId: Id<"shops"> }) {
  const settings = useQuery(api.automaticReplySettings.get, { shopId });
  const shopify = useQuery(api.shopifyConnection.status, { shopId });
  const save = useMutation(api.automaticReplySettings.save);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ReplyRule[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!settings || !shopify) return <Skeleton className="h-48 w-full" />;
  const { enabled, rules, configured, canManage, approvalRequired } = settings;
  const language = supportedEmailLanguage(shopify?.primaryLocale);
  const active = !approvalRequired && enabled && configured && Boolean(language);
  const categoriesWithRules = Object.entries(categories).filter(([category]) =>
    rules.some((rule) => rule.category === category),
  );
  async function submit(nextEnabled: boolean, nextRules: ReplyRule[], close = false) {
    setBusy(true);
    setMessage("");
    try {
      await save({ shopId, enabled: nextEnabled, rules: nextRules });
      if (close) setEditing(false);
      setMessage("Modifications enregistrées.");
    } catch {
      setMessage("Impossible d’enregistrer. Réessaie.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <Card className="gap-4">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <Bot className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="font-semibold">Envoi automatique</h2>
              <p className="text-sm text-muted-foreground">
                {approvalRequired
                  ? "Chaque réponse doit être validée avant son envoi."
                  : language
                    ? "Les réponses utilisent la langue principale de la boutique Shopify."
                    : "Les envois attendent une langue Shopify prise en charge."}
              </p>
            </div>
          </div>
          <Badge
            variant="secondary"
            className={active ? "bg-emerald-50 text-emerald-800" : undefined}
          >
            {approvalRequired
              ? "Validation manuelle"
              : active
                ? "Actif"
                : !enabled
                  ? "En pause"
                  : !configured
                    ? "Service indisponible"
                    : "Langue indisponible"}
          </Badge>
        </CardHeader>
        {canManage && !approvalRequired && (
          <CardContent className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy || (!enabled && (!configured || !rules.length))}
              onClick={() => void submit(!enabled, rules)}
            >
              {enabled ? (
                <>
                  <Pause /> Mettre en pause
                </>
              ) : (
                <>
                  <Play /> Reprendre
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDraft(rules);
                setEditing(true);
              }}
            >
              <Settings2 /> Modifier les règles
            </Button>
          </CardContent>
        )}
      </Card>
      <Card className="gap-3">
        <CardHeader>
          <h2 className="font-semibold">Demandes autorisées</h2>
        </CardHeader>
        <CardContent>
          {categoriesWithRules.length ? (
            <ul className="divide-y">
              {categoriesWithRules.map(([category, label]) => (
                <li
                  key={category}
                  className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
                >
                  <span className="text-sm font-medium">{label}</span>
                  <span className="flex flex-wrap gap-1.5">
                    {rules
                      .filter((rule) => rule.category === category)
                      .map((rule) => (
                        <Badge key={rule.priority} variant="outline">
                          {priorities[rule.priority]}
                        </Badge>
                      ))}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Aucune règle enregistrée.</p>
          )}
        </CardContent>
      </Card>
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Règles d’envoi</DialogTitle>
            <DialogDescription>Les changements s’appliquent aux nouveaux emails.</DialogDescription>
          </DialogHeader>
          <div className="overflow-x-auto">
            <table className="min-w-96 w-full text-sm">
              <thead>
                <tr>
                  <th scope="col" className="p-2 text-left">
                    Catégorie
                  </th>
                  {Object.entries(priorities).map(([priority, label]) => (
                    <th key={priority} scope="col" className="p-2 text-center">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(categories).map(([category, label]) => (
                  <tr key={category} className="border-t">
                    <th scope="row" className="p-2 text-left font-medium">
                      {label}
                    </th>
                    {Object.entries(priorities).map(([priority, importance]) => {
                      const checked = draft.some(
                        (rule) => rule.category === category && rule.priority === priority,
                      );
                      return (
                        <td key={priority} className="p-2 text-center">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            aria-label={`${label} · ${importance}`}
                            checked={checked}
                            disabled={busy}
                            onChange={() =>
                              setDraft((current) =>
                                checked
                                  ? current.filter(
                                      (rule) =>
                                        rule.category !== category || rule.priority !== priority,
                                    )
                                  : [
                                      ...current,
                                      {
                                        category: category as Category,
                                        priority: priority as Priority,
                                      },
                                    ],
                              )
                            }
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {message && (
            <p role="status" className="text-sm text-muted-foreground">
              {message}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => setDraft(defaultReplyRules)}>
              Règles par défaut
            </Button>
            <Button
              type="button"
              disabled={busy || (enabled && (!draft.length || !configured))}
              onClick={() => void submit(enabled, draft, true)}
            >
              Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function AutomaticReplyPanel({
  receiptId,
  showSent = true,
}: {
  receiptId: Id<"emailReceipts">;
  showSent?: boolean;
}) {
  const reply = useQuery(api.automaticReplies.forEmail, { receiptId });
  const cancel = useMutation(api.automaticReplies.cancel);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!reply || (!showSent && reply.status === "sent")) return null;
  async function takeOver() {
    setBusy(true);
    setError("");
    try {
      await cancel({ receiptId });
    } catch {
      setError("L’envoi a peut-être déjà démarré. Vérifiez son statut avant de répondre.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="mt-4 rounded-lg border border-blue-600 bg-blue-50/30 p-4"
      aria-label="Réponse automatique"
    >
      <h3 className="font-semibold">{reply.manual ? "Réponse validée" : "Réponse automatique"}</h3>
      <p role="status" className="mt-2 text-sm">
        {autoReplyStatuses[reply.status]}
        {reply.sentAt ? ` · ${new Date(reply.sentAt).toLocaleString("fr-FR")}` : ""}
      </p>
      {reply.status === "sent" && (
        <p className="mt-2 text-xs text-muted-foreground">
          Le service d’envoi a accepté la réponse. La réception dans la boîte du destinataire n’est
          pas confirmée ici.
        </p>
      )}
      {reply.status === "uncertain" && (
        <p className="mt-2 text-sm font-medium">
          Vérifiez votre messagerie avant un nouvel envoi pour éviter une réponse en double.
        </p>
      )}
      {reply.text && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium">
            Voir la réponse{reply.to ? ` à ${reply.to}` : ""}
          </summary>
          <p className="mt-3 whitespace-pre-wrap break-words text-sm">{reply.text}</p>
        </details>
      )}
      {reply.canCancel && (
        <button
          type="button"
          className={`${button} mt-3`}
          disabled={busy}
          onClick={() => void takeOver()}
        >
          Annuler et traiter manuellement
        </button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
