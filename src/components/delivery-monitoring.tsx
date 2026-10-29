import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  type DeliveryConfig,
  deliveryReasons,
  noticeStatuses,
} from "../../convex/lib/deliveryPolicy";

const button =
  "rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";
type Form = DeliveryConfig & { mode: "off" | "simulation" | "live" };
const defaults: Form = {
  mode: "simulation",
  maxDays: 7,
  calendar: "business",
  timezone: "Europe/Paris",
  hour: 9,
  locale: "fr",
  holidays: [],
};
export function DeliveryMonitoring({ shopId }: { shopId: Id<"shops"> }) {
  const settings = useQuery(api.deliveryMonitoring.get, { shopId }),
    save = useMutation(api.deliveryMonitoring.save),
    simulate = useMutation(api.deliveryMonitoring.simulate);
  const [editing, setEditing] = useState(false),
    [form, setForm] = useState<Form>(defaults),
    [holidays, setHolidays] = useState("");
  const [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState(""),
    [history, setHistory] = useState(false);
  if (!settings) return null;
  const config = settings.config;
  function edit() {
    setForm(
      config
        ? {
            mode: config.mode,
            maxDays: config.maxDays,
            calendar: config.calendar,
            timezone: config.timezone,
            hour: config.hour,
            locale: config.locale,
            holidays: config.holidays,
          }
        : defaults,
    );
    setHolidays(config?.holidays.join("\n") ?? "");
    setEditing(true);
    setFeedback("");
  }
  async function perform(action: () => Promise<unknown>, saved = false) {
    setBusy(true);
    setFeedback("");
    try {
      await action();
      if (saved) setEditing(false);
      setFeedback(
        saved
          ? "Configuration enregistrée."
          : "Simulation lancée : ce contrôle ne déclenche aucun envoi.",
      );
    } catch (error) {
      setFeedback(
        String(error).includes("SimulateBeforeLive")
          ? "Enregistrez ces réglages en simulation et attendez son résultat avant d’activer les envois réels."
          : "Action impossible. Vérifiez les réglages, la connexion Shopify et la réception SAV, puis réessayez.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-lg border bg-card p-5" aria-label="Surveillance des retards">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Surveillance des retards</h2>
        <span className="rounded-full border px-3 py-1 text-sm">
          {!config
            ? "Simulation — à configurer"
            : config.mode === "live"
              ? "Envois réels activés"
              : config.mode === "off"
                ? "Désactivée"
                : "Mode simulation"}
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Compare chaque jour l’avancement des commandes au délai maximal annoncé, préparation
        comprise. Un seul email peut prévenir le client d’un retard, s’il ne vous a pas déjà
        contacté pour cette commande.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        Le mode simulation n’envoie aucun email. Les envois réels concernent les nouvelles commandes
        après activation. Les contacts ambigus et les suivis insuffisants restent à vérifier par
        votre équipe.
      </p>
      {config && (
        <p className="mt-3 text-sm">
          Délai : {config.maxDays} jours{" "}
          {config.calendar === "business" ? "ouvrés (lundi à vendredi)" : "calendaires"} · contrôle
          vers {String(config.hour).padStart(2, "0")} h ({config.timezone}).{" "}
          {config.lastSimulationAt
            ? `Dernière simulation : ${new Date(config.lastSimulationAt).toLocaleString("fr-FR", { timeZone: config.timezone })}.`
            : "Aucune simulation terminée."}
        </p>
      )}
      {settings.canManage && !editing && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={button} onClick={edit}>
            Configurer la surveillance
          </button>
          {config && (
            <button
              type="button"
              className={button}
              disabled={busy || config.scanning}
              onClick={() => void perform(() => simulate({ shopId }))}
            >
              {config.scanning ? "Vérification en cours…" : "Simuler maintenant"}
            </button>
          )}
        </div>
      )}
      {editing && (
        <form
          className="mt-4 grid gap-4 rounded-md border p-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(
              () =>
                save({
                  shopId,
                  ...form,
                  holidays: holidays.trim() ? holidays.trim().split(/[\s,]+/) : [],
                }),
              true,
            );
          }}
        >
          <label className="grid gap-1 text-sm">
            Mode
            <select
              className={button}
              value={form.mode}
              onChange={(e) => setForm({ ...form, mode: e.target.value as Form["mode"] })}
            >
              <option value="simulation">Simulation : aucun envoi</option>
              <option value="off">Désactivée</option>
              <option value="live" disabled={!settings.configured || !config?.previewReady}>
                Envois réels après simulation
              </option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Délai maximal depuis la commande
            <input
              type="number"
              className={button}
              min={1}
              max={90}
              required
              value={form.maxDays}
              onChange={(e) => setForm({ ...form, maxDays: Number(e.target.value) })}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Calendrier
            <select
              className={button}
              value={form.calendar}
              onChange={(e) => setForm({ ...form, calendar: e.target.value as Form["calendar"] })}
            >
              <option value="business">Jours ouvrés : lundi à vendredi</option>
              <option value="calendar">Jours calendaires</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Fuseau horaire
            <input
              className={button}
              required
              value={form.timezone}
              placeholder="Europe/Paris"
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Heure du contrôle quotidien
            <input
              className={button}
              type="number"
              min={0}
              max={23}
              required
              value={form.hour}
              onChange={(e) => setForm({ ...form, hour: Number(e.target.value) })}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Langue des notifications
            <select
              className={button}
              value={form.locale}
              onChange={(e) => setForm({ ...form, locale: e.target.value as Form["locale"] })}
            >
              <option value="fr">Français</option>
              <option value="en">Anglais</option>
              <option value="es">Espagnol</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm sm:col-span-2">
            Jours fériés ou fermés à exclure des jours ouvrés
            <textarea
              className={`${button} min-h-20`}
              value={holidays}
              onChange={(e) => setHolidays(e.target.value)}
              placeholder={"2026-12-25\n2027-01-01"}
            />
            <span className="text-xs text-muted-foreground">
              Une date AAAA-MM-JJ par ligne, jusqu’à 80 dates. Aucun calendrier de jours fériés
              n’est ajouté automatiquement.
            </span>
          </label>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            La date limite est la fin du dernier jour prévu. Les promesses déjà enregistrées
            conservent leur délai initial. Pour modifier les règles avant un envoi réel,
            enregistrez-les d’abord en simulation.
          </p>
          <div className="flex gap-2 sm:col-span-2">
            <button className={button} type="submit" disabled={busy}>
              Enregistrer
            </button>
            <button
              className={button}
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Annuler
            </button>
          </div>
        </form>
      )}
      {feedback && (
        <p role="status" className="mt-3 text-sm">
          {feedback}
        </p>
      )}
      {!settings.canManage && (
        <p className="mt-3 text-xs text-muted-foreground">
          Les propriétaires et administrateurs peuvent configurer cette surveillance.
        </p>
      )}
      {config && (
        <>
          <fieldset className="mt-5 flex gap-2" aria-label="Vue des retards">
            <button
              type="button"
              className={button}
              aria-pressed={!history}
              onClick={() => setHistory(false)}
            >
              À surveiller
            </button>
            <button
              type="button"
              className={button}
              aria-pressed={history}
              onClick={() => setHistory(true)}
            >
              Historique
            </button>
          </fieldset>
          <DeliveryRows key={String(history)} shopId={shopId} history={history} />
        </>
      )}
    </section>
  );
}
function DeliveryRows({ shopId, history }: { shopId: Id<"shops">; history: boolean }) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.deliveryMonitoring.list,
    { shopId, history },
    { initialNumItems: 10 },
  );
  const cancel = useMutation(api.deliveryMonitoring.cancel);
  const [error, setError] = useState("");
  async function takeOver(id: Id<"delayNotices">) {
    setError("");
    try {
      await cancel({ id });
    } catch {
      setError("L’envoi a peut-être déjà démarré. Vérifiez son statut avant de répondre.");
    }
  }
  return (
    <div className="mt-3">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {status === "LoadingFirstPage" ? (
        <p role="status" className="text-sm">
          Chargement…
        </p>
      ) : !results.length ? (
        <p className="text-sm text-muted-foreground">Aucune commande dans cette vue.</p>
      ) : (
        <ul className="grid gap-3">
          {results.map((row) => (
            <li key={row.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">{row.orderName}</h3>
                <span className="rounded-full border px-2 py-1 text-xs">
                  {row.status === "none" && row.simulation && row.reason === "eligible"
                    ? "Candidat en simulation"
                    : noticeStatuses[row.status]}
                </span>
              </div>
              <p className="mt-1 text-sm">{deliveryReasons[row.reason]}</p>
              <p className="mt-1 break-words text-xs text-muted-foreground">
                {row.email ?? "Sans adresse client"} · Date limite :{" "}
                {new Date(row.deadlineAt).toLocaleString("fr-FR", { timeZone: row.timezone })} (
                {row.timezone})
              </p>
              {row.estimated && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Simulation indicative : commande antérieure à la configuration de ses délais.
                </p>
              )}
              {row.status === "sent" && (
                <p className="mt-2 text-xs">
                  Acceptée le {new Date(row.sentAt ?? row.updatedAt).toLocaleString("fr-FR")}. La
                  réception dans la boîte du client n’est pas confirmée ici.
                </p>
              )}
              {row.status === "uncertain" && (
                <p className="mt-2 text-sm font-medium">
                  Vérifiez votre messagerie avant de répondre pour éviter un doublon.
                </p>
              )}
              <details className="mt-2">
                <summary className="cursor-pointer text-sm">
                  {row.status === "sent" ? "Voir la notification" : "Aperçu du message"}
                </summary>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm">{row.text}</p>
              </details>
              {row.canCancel && (
                <button
                  type="button"
                  className={`${button} mt-2`}
                  onClick={() => void takeOver(row.id)}
                >
                  Annuler et traiter manuellement
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {status === "CanLoadMore" && (
        <button className={`${button} mt-3`} type="button" onClick={() => loadMore(10)}>
          Afficher plus
        </button>
      )}
    </div>
  );
}
