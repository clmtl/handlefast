import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { autoReplyStatuses, type ReplyRule } from "../../convex/lib/automaticReplyPolicy";
import {
  type Category,
  categories,
  type Priority,
  priorities,
} from "../../convex/lib/emailClassificationPolicy";

const button =
  "rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";

export function AutomaticReplySettings({ shopId }: { shopId: Id<"shops"> }) {
  const settings = useQuery(api.automaticReplySettings.get, { shopId });
  const save = useMutation(api.automaticReplySettings.save);
  const [editing, setEditing] = useState(false),
    [enabled, setEnabled] = useState(false),
    [rules, setRules] = useState<ReplyRule[]>([]);
  const [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState("");
  if (!settings) return null;
  const currentRules = editing ? rules : settings.rules;
  const currentEnabled = editing ? enabled : settings.enabled;
  function edit() {
    if (!settings) return;
    setRules(settings.rules);
    setEnabled(settings.enabled);
    setEditing(true);
    setFeedback("");
  }
  function toggle(category: Category, priority: Priority) {
    setRules(
      currentRules.some((r) => r.category === category && r.priority === priority)
        ? currentRules.filter((r) => r.category !== category || r.priority !== priority)
        : [...currentRules, { category, priority }],
    );
  }
  async function submit() {
    setBusy(true);
    setFeedback("");
    try {
      await save({ shopId, enabled, rules });
      setEditing(false);
      setFeedback("Règles enregistrées. Elles s’appliquent aux prochains emails reçus.");
    } catch {
      setFeedback("Enregistrement impossible. Vérifiez les règles et réessayez.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-lg border bg-card p-5" aria-label="Réponses automatiques">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Réponses automatiques</h2>
        <span className="rounded-full border px-3 py-1 text-sm">
          {settings.enabled ? "Activées" : "Désactivées"}
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Choisissez les catégories et importances autorisées pour les prochains emails. HandleFast
        peut communiquer un suivi connu, demander les informations manquantes ou accuser réception
        d’une résolution. Les demandes nécessitant une décision restent à traiter par votre équipe.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        Réponses en français, anglais ou espagnol. Aucun remboursement, renvoi ou changement de
        commande automatique. Une seule tentative de réponse par conversation sur 30 minutes.
      </p>
      {!settings.configured && (
        <p role="status" className="mt-3 text-sm">
          Le service d’envoi n’est pas encore disponible.
        </p>
      )}
      {editing && (
        <label className="mt-4 flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={currentEnabled}
            disabled={busy || !settings.configured}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Activer les réponses automatiques
        </label>
      )}
      <details key={editing ? "edit" : "view"} open={editing} className="mt-4">
        <summary className="cursor-pointer text-sm font-medium">
          {currentRules.length}{" "}
          {currentRules.length > 1 ? "combinaisons autorisées" : "combinaison autorisée"} — afficher
          les règles
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Catégories et importances autorisées pour une réponse automatique
            </caption>
            <thead>
              <tr>
                <th scope="col" className="p-2 text-left">
                  Catégorie
                </th>
                {Object.entries(priorities).map(([priority, label]) => (
                  <th scope="col" className="p-2 text-center" key={priority}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(categories).map(([category, label]) => (
                <tr key={category} className="border-t">
                  <th scope="row" className="p-2 text-left font-normal">
                    {label}
                  </th>
                  {Object.entries(priorities).map(([priority, importance]) => (
                    <td key={priority} className="p-2 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${label} — ${importance}`}
                        checked={currentRules.some(
                          (r) => r.category === category && r.priority === priority,
                        )}
                        disabled={!editing || busy}
                        onChange={() => toggle(category as Category, priority as Priority)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {settings.canManage && (
        <div className="mt-4 flex flex-wrap gap-2">
          {editing ? (
            <>
              <button
                type="button"
                className={button}
                disabled={busy || (enabled && !rules.length)}
                onClick={() => void submit()}
              >
                Enregistrer
              </button>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                Annuler
              </button>
            </>
          ) : (
            <button type="button" className={button} onClick={edit}>
              Configurer les règles
            </button>
          )}
        </div>
      )}
      {!settings.canManage && (
        <p className="mt-3 text-xs text-muted-foreground">
          Les propriétaires et administrateurs peuvent modifier ces règles.
        </p>
      )}
      {feedback && (
        <p role="status" className="mt-3 text-sm">
          {feedback}
        </p>
      )}
    </section>
  );
}

export function AutomaticReplyPanel({ receiptId }: { receiptId: Id<"emailReceipts"> }) {
  const reply = useQuery(api.automaticReplies.forEmail, { receiptId });
  const cancel = useMutation(api.automaticReplies.cancel);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!reply) return null;
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
      <h3 className="font-semibold">Réponse automatique</h3>
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
