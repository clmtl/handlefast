import { Link } from "@tanstack/react-router";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { CalendarClock, FlaskConical, Pause, Play, Settings2, Truck } from "lucide-react";
import { useId, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  type DeliveryConfig,
  deliveryReasons,
  noticeStatuses,
} from "../../convex/lib/deliveryPolicy";
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
import { Input } from "./ui/input";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { Skeleton } from "./ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

const defaults: DeliveryConfig = {
  maxDays: 7,
  calendar: "business",
  timezone: "Europe/Paris",
  hour: 9,
  holidays: [],
};

export function DeliveryMonitoring({ shopId }: { shopId: Id<"shops"> }) {
  const formId = useId();
  const settings = useQuery(api.deliveryMonitoring.get, { shopId });
  const shopify = useQuery(api.shopifyConnection.status, { shopId });
  const email = useQuery(api.emailInbox.connection, { shopId });
  const save = useMutation(api.deliveryMonitoring.save);
  const simulate = useMutation(api.deliveryMonitoring.simulate);
  const [editing, setEditing] = useState(false);
  const [activation, setActivation] = useState(false);
  const [form, setForm] = useState<DeliveryConfig>(defaults);
  const [holidays, setHolidays] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  if (!settings || !shopify || !email) return <Skeleton className="h-48 w-full" />;
  const { config, canManage } = settings;
  const live = config?.mode === "live";
  const language = supportedEmailLanguage(shopify.primaryLocale);
  const available =
    settings.configured &&
    shopify.connected &&
    email.enabled &&
    !email.shopDisabled &&
    Boolean(language);
  function values(): DeliveryConfig {
    return config
      ? {
          maxDays: config.maxDays,
          calendar: config.calendar,
          timezone: config.timezone,
          hour: config.hour,
          holidays: config.holidays,
        }
      : defaults;
  }
  function edit() {
    const current = values();
    setForm(current);
    setHolidays(current.holidays.join("\n"));
    setFeedback("");
    setEditing(true);
  }
  function formatDate(timestamp: number, timezone: string) {
    return new Date(timestamp).toLocaleString("fr-FR", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "short",
    });
  }
  async function perform(action: () => Promise<unknown>, message: string, done?: () => void) {
    setBusy(true);
    setFeedback("");
    try {
      await action();
      done?.();
      setFeedback(message);
    } catch (error) {
      const detail = String(error);
      setFeedback(
        detail.includes("SimulateBeforeLive")
          ? "Relance une simulation avant d’activer les notifications."
          : detail.includes("ShopLanguageUnavailable")
            ? "Attends la synchronisation de la langue principale de Shopify."
            : detail.includes("InvalidDeliveryPolicy")
              ? "Vérifie le délai, le fuseau horaire et les dates saisies."
              : "Action impossible. Vérifie les connexions et réessaie.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <Card className="gap-4">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Truck className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="font-semibold">Notifications de retard</h2>
              <p className="text-sm text-muted-foreground">
                {config
                  ? `${config.maxDays} jours ${config.calendar === "business" ? "ouvrés" : "calendaires"} · Contrôle à ${String(config.hour).padStart(2, "0")} h`
                  : "Renseigne le délai annoncé à tes clients."}
              </p>
            </div>
          </div>
          <Badge
            variant="secondary"
            className={live ? "bg-emerald-50 text-emerald-800" : undefined}
          >
            {live
              ? settings.approvalRequired
                ? "Validation manuelle"
                : "Envois actifs"
              : config?.mode === "off"
                ? "En pause"
                : config
                  ? "Simulation"
                  : "À configurer"}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {config && config.mode !== "off" && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <CalendarClock className="size-4" aria-hidden="true" />
                {config.scanning
                  ? "Contrôle en cours…"
                  : `Prochain contrôle · ${formatDate(config.nextRunAt, config.timezone)}`}
              </span>
              {shopify.primaryLocale && (
                <span>
                  Langue Shopify ·{" "}
                  {new Intl.DisplayNames("fr", { type: "language" }).of(shopify.primaryLocale)}
                </span>
              )}
              {config.lastSimulationAt && (
                <span>
                  Dernière simulation · {formatDate(config.lastSimulationAt, config.timezone)}
                </span>
              )}
            </div>
          )}
          {canManage && (
            <div className="flex flex-wrap gap-2">
              {!config ? (
                <Button onClick={edit}>
                  <Settings2 /> Configurer le délai
                </Button>
              ) : (
                <>
                  {live ? (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void perform(
                          () => save({ shopId, ...values(), mode: "off" }),
                          "Notifications mises en pause.",
                        )
                      }
                    >
                      <Pause /> Mettre en pause
                    </Button>
                  ) : (
                    <Button
                      disabled={busy || config.scanning || !available || !config.previewReady}
                      onClick={() => setActivation(true)}
                    >
                      <Play />{" "}
                      {settings.approvalRequired
                        ? "Activer la surveillance"
                        : "Activer les notifications"}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    disabled={busy || config.scanning}
                    onClick={() => void perform(() => simulate({ shopId }), "Simulation lancée.")}
                  >
                    <FlaskConical /> Simuler maintenant
                  </Button>
                  {config.mode === "off" && (
                    <Button
                      variant="outline"
                      disabled={busy || config.scanning}
                      onClick={() =>
                        void perform(
                          () => save({ shopId, ...values(), mode: "simulation" }),
                          "Contrôle en simulation rétabli.",
                        )
                      }
                    >
                      Reprendre en simulation
                    </Button>
                  )}
                  <Button variant="ghost" onClick={edit}>
                    <Settings2 /> Réglages
                  </Button>
                </>
              )}
            </div>
          )}
          {config && !live && !available && (
            <p className="text-sm text-muted-foreground">
              Pour activer les envois,{" "}
              {!shopify.connected ? (
                <Link
                  to="/dashboard"
                  search={{ view: "shopify", shop: shopId }}
                  className="text-primary underline"
                >
                  connecte Shopify
                </Link>
              ) : !email.enabled || email.shopDisabled ? (
                <Link
                  to="/dashboard"
                  search={{ view: "email", shop: shopId }}
                  className="text-primary underline"
                >
                  active la réception email
                </Link>
              ) : !settings.configured ? (
                "le service email doit être disponible"
              ) : (
                "Shopify doit fournir une langue prise en charge"
              )}
              .
            </p>
          )}
          {config && !live && available && !config.previewReady && !config.scanning && (
            <p className="text-sm text-muted-foreground">
              Lance une simulation pour activer les envois.
            </p>
          )}
          {feedback && (
            <p role="status" className="text-sm text-muted-foreground">
              {feedback}
            </p>
          )}
        </CardContent>
      </Card>
      {config && (
        <Card className="gap-0 py-0">
          <Tabs defaultValue="watch">
            <CardHeader className="border-b py-4">
              <TabsList aria-label="Résultats des retards">
                <TabsTrigger value="watch">À surveiller</TabsTrigger>
                <TabsTrigger value="history">Historique</TabsTrigger>
              </TabsList>
            </CardHeader>
            <TabsContent value="watch">
              <DeliveryRows shopId={shopId} history={false} />
            </TabsContent>
            <TabsContent value="history">
              <DeliveryRows shopId={shopId} history />
            </TabsContent>
          </Tabs>
        </Card>
      )}
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Délai de livraison</DialogTitle>
            <DialogDescription>
              Le délai part du lendemain de la commande. L’enregistrement lance une simulation.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(
                () =>
                  save({
                    shopId,
                    ...form,
                    timezone: form.timezone.trim(),
                    holidays: holidays.trim() ? holidays.trim().split(/[\s,]+/) : [],
                    mode: "simulation",
                  }),
                "Réglages enregistrés. Simulation lancée.",
                () => setEditing(false),
              );
            }}
          >
            <label htmlFor={`${formId}-days`} className="grid gap-1.5 text-sm font-medium">
              Délai maximal (jours)
              <Input
                id={`${formId}-days`}
                type="number"
                min={1}
                max={90}
                required
                value={form.maxDays}
                onChange={(event) => setForm({ ...form, maxDays: Number(event.target.value) })}
              />
            </label>
            <label htmlFor={`${formId}-calendar`} className="grid gap-1.5 text-sm font-medium">
              Calendrier
              <NativeSelect
                id={`${formId}-calendar`}
                value={form.calendar}
                onChange={(event) =>
                  setForm({ ...form, calendar: event.target.value as DeliveryConfig["calendar"] })
                }
              >
                <NativeSelectOption value="business">Jours ouvrés</NativeSelectOption>
                <NativeSelectOption value="calendar">Jours calendaires</NativeSelectOption>
              </NativeSelect>
            </label>
            <label htmlFor={`${formId}-hour`} className="grid gap-1.5 text-sm font-medium">
              Heure du contrôle
              <Input
                id={`${formId}-hour`}
                type="number"
                min={0}
                max={23}
                required
                value={form.hour}
                onChange={(event) => setForm({ ...form, hour: Number(event.target.value) })}
              />
            </label>
            <label htmlFor={`${formId}-timezone`} className="grid gap-1.5 text-sm font-medium">
              Fuseau horaire
              <Input
                id={`${formId}-timezone`}
                required
                value={form.timezone}
                placeholder="Europe/Paris"
                onChange={(event) => setForm({ ...form, timezone: event.target.value })}
              />
            </label>
            {form.calendar === "business" && (
              <label
                htmlFor={`${formId}-holidays`}
                className="grid gap-1.5 text-sm font-medium sm:col-span-2"
              >
                Jours fériés et fermetures
                <textarea
                  id={`${formId}-holidays`}
                  className="min-h-20 rounded-md border border-input bg-background p-2 text-sm"
                  value={holidays}
                  placeholder="AAAA-MM-JJ, une date par ligne"
                  onChange={(event) => setHolidays(event.target.value)}
                />
              </label>
            )}
            {live && (
              <p className="text-sm text-muted-foreground sm:col-span-2">
                Enregistrer met les envois en pause. Tu pourras les réactiver après la simulation.
              </p>
            )}
            {feedback && (
              <p role="status" className="text-sm text-muted-foreground sm:col-span-2">
                {feedback}
              </p>
            )}
            <DialogFooter className="sm:col-span-2">
              <Button type="submit" disabled={busy}>
                Enregistrer et simuler
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={activation} onOpenChange={setActivation}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {settings.approvalRequired
                ? "Activer la surveillance des retards"
                : "Activer les notifications de retard"}
            </DialogTitle>
            <DialogDescription>
              {settings.approvalRequired
                ? "HandleFast repère les retards sur les nouvelles commandes. Tu confirmes chaque avis avant l’envoi."
                : "Les nouvelles commandes deviennent éligibles. HandleFast enverra au plus un email par commande en retard, si le client n’a pas déjà contacté le SAV à son sujet."}
            </DialogDescription>
          </DialogHeader>
          {feedback && (
            <p role="status" className="text-sm text-muted-foreground">
              {feedback}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setActivation(false)}>
              Annuler
            </Button>
            <Button
              disabled={busy || !available || !config?.previewReady}
              onClick={() =>
                void perform(
                  () => save({ shopId, ...values(), mode: "live" }),
                  settings.approvalRequired
                    ? "Surveillance activée. Chaque avis attend ta validation."
                    : "Notifications activées.",
                  () => setActivation(false),
                )
              }
            >
              {settings.approvalRequired ? "Activer la surveillance" : "Activer les envois"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function DeliveryRows({ shopId, history }: { shopId: Id<"shops">; history: boolean }) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.deliveryMonitoring.list,
    { shopId, history },
    { initialNumItems: 10 },
  );
  const cancel = useMutation(api.deliveryMonitoring.cancel);
  const approve = useMutation(api.deliveryMonitoring.approve);
  const [approval, setApproval] = useState<{
    id: Id<"delayNotices">;
    to: string;
    text: string;
  } | null>(null);
  const [sending, setSending] = useState(false);
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
    <div className="p-4 sm:p-6">
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
                <Badge variant="outline">
                  {row.status === "none" && row.simulation && row.reason === "eligible"
                    ? "Candidat en simulation"
                    : noticeStatuses[row.status]}
                </Badge>
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
              {row.text && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm">
                    {row.status === "sent" ? "Voir la notification" : "Aperçu du message"}
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm">{row.text}</p>
                </details>
              )}
              {row.canApprove && row.email && row.text && (
                <Button
                  className="mt-2"
                  size="sm"
                  onClick={() => {
                    if (row.email) setApproval({ id: row.id, to: row.email, text: row.text });
                  }}
                >
                  Relire et envoyer
                </Button>
              )}
              {row.canCancel && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => void takeOver(row.id)}
                >
                  Annuler et traiter manuellement
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={approval !== null}
        onOpenChange={(open) => {
          if (!open && !sending) setApproval(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Confirmer l’avis de retard</DialogTitle>
            <DialogDescription>{approval ? `Destinataire · ${approval.to}` : ""}</DialogDescription>
          </DialogHeader>
          {approval && (
            <p className="whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-sm">
              {approval.text}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={sending} onClick={() => setApproval(null)}>
              Annuler
            </Button>
            <Button
              disabled={sending || !approval}
              onClick={async () => {
                if (!approval) return;
                setSending(true);
                setError("");
                try {
                  await approve(approval);
                  setApproval(null);
                } catch {
                  setError(
                    "La commande ou le message a changé. Vérifie l’aperçu avant de valider.",
                  );
                } finally {
                  setSending(false);
                }
              }}
            >
              Confirmer et envoyer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {status === "CanLoadMore" && (
        <Button className="mt-3" variant="outline" type="button" onClick={() => loadMore(10)}>
          Afficher plus
        </Button>
      )}
    </div>
  );
}
