import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";

const button =
  "rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";
const statuses: Record<string, string> = {
  Unavailable: "Suivi indisponible",
  NotFound: "Pas encore d’information",
  InfoReceived: "Étiquette créée",
  InTransit: "En transit",
  Expired: "Suivi expiré",
  AvailableForPickup: "Disponible au retrait",
  OutForDelivery: "En livraison",
  DeliveryFailure: "Échec de livraison",
  Delivered: "Livré",
  Exception: "Incident transporteur",
  Returning: "Retour en cours",
  Returned: "Retourné",
};
const orderStatuses: Record<string, string> = {
  PAID: "Payée",
  PENDING: "Paiement en attente",
  REFUNDED: "Remboursée",
  PARTIALLY_REFUNDED: "Partiellement remboursée",
  AUTHORIZED: "Paiement autorisé",
  VOIDED: "Paiement annulé",
  FULFILLED: "Expédiée",
  UNFULFILLED: "Non expédiée",
  PARTIALLY_FULFILLED: "Partiellement expédiée",
  IN_PROGRESS: "Préparation en cours",
  ON_HOLD: "En attente",
  SCHEDULED: "Expédition planifiée",
  UNKNOWN: "Information indisponible",
};
export function OrderContext({
  receiptId,
  refreshOnOpen = true,
}: {
  receiptId: Id<"emailReceipts">;
  refreshOnOpen?: boolean;
}) {
  const context = useQuery(api.orderContext.forEmail, { receiptId });
  const lookup = useAction(api.orderContext.lookup);
  const link = useMutation(api.orderContext.link);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [results, setResults] = useState<Doc<"shopifyOrders">[]>([]);
  const [notice, setNotice] = useState("");
  const refreshed = useRef(false);
  useEffect(() => {
    if (!refreshOnOpen || !context?.canEdit || refreshed.current) return;
    refreshed.current = true;
    setBusy(true);
    void lookup({ receiptId })
      .catch(() =>
        setError("Actualisation indisponible. Les informations affichées peuvent être anciennes."),
      )
      .finally(() => setBusy(false));
  }, [context?.canEdit, lookup, receiptId, refreshOnOpen]);
  async function perform(task: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch {
      setError("Action indisponible. Réessayez dans quelques secondes.");
    } finally {
      setBusy(false);
    }
  }
  if (!context) return null;
  const selected = context.selected;
  return (
    <aside
      className="mt-5 rounded-lg border bg-background p-4 lg:mt-0"
      aria-label="Commande et livraison"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-semibold">Commande et livraison</h3>
        {context.canEdit && (
          <button
            className={button}
            type="button"
            disabled={busy}
            onClick={() => void perform(() => lookup({ receiptId }))}
          >
            {busy ? "Chargement…" : "Actualiser"}
          </button>
        )}
      </div>
      {!refreshOnOpen && (
        <p className="mt-2 text-sm text-muted-foreground">
          Dernières informations enregistrées. Actualisez pour vérifier les changements récents.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm">
          {notice}
        </p>
      )}
      {selected ? (
        <div className="mt-4 space-y-4">
          <div>
            <p className="text-xl font-semibold">{selected.name}</p>
            <p className="text-sm text-muted-foreground">
              {new Date(selected.placedAt).toLocaleDateString()} ·{" "}
              {context.mode === "automatic"
                ? "Associée par email et numéro de commande"
                : "Association manuelle"}
            </p>
          </div>
          {!context.identityMatches && (
            <p className="rounded-md border border-amber-600 p-3 text-sm">
              L’adresse de cette commande diffère de l’expéditeur. Vérifiez l’identité du client
              avant de communiquer ses informations.
            </p>
          )}
          <div className="flex flex-wrap gap-2 text-sm">
            <span className="rounded-full border px-3 py-1">
              {selected.cancelled
                ? "Commande annulée"
                : (orderStatuses[selected.fulfillmentStatus] ?? selected.fulfillmentStatus)}
            </span>
            <span className="rounded-full border px-3 py-1">
              {orderStatuses[selected.financialStatus] ?? selected.financialStatus}
            </span>
          </div>
          <p className="text-sm">
            Montant actuel : {selected.total} {selected.currency} · Remboursé : {selected.refunded}{" "}
            {selected.currency}
          </p>
          {selected.destination && (
            <p className="text-sm">
              Destination :{" "}
              {[selected.destination.city, selected.destination.zip, selected.destination.country]
                .filter(Boolean)
                .join(", ")}
            </p>
          )}
          <ul className="divide-y text-sm">
            {selected.items.map((item) => (
              <li key={item.id} className="py-2">
                {item.quantity} × {item.title}
                {item.variant && ` · ${item.variant}`}
                {item.sku && (
                  <span className="block text-xs text-muted-foreground">SKU : {item.sku}</span>
                )}
              </li>
            ))}
          </ul>
          {selected.detailsTruncated && (
            <p className="text-sm text-muted-foreground">
              Aperçu partiel : consultez Shopify pour tous les articles et expéditions.
            </p>
          )}
          <a
            className="inline-block text-sm text-primary underline"
            href={`https://${context.domain}/admin/orders/${selected.gid.split("/").pop()}`}
            target="_blank"
            rel="noreferrer"
          >
            Ouvrir dans Shopify
          </a>
          <p className="text-xs text-muted-foreground">
            Commande vérifiée le {new Date(selected.syncedAt).toLocaleString()}.
          </p>
          <div className="space-y-4">
            {context.shipments.length ? (
              context.shipments.map((shipment) => (
                <Shipment key={shipment._id} shipment={shipment} />
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                Aucun numéro de suivi fourni par Shopify.
              </p>
            )}
          </div>
          {context.canEdit && (
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => void perform(() => link({ receiptId, orderId: null }))}
            >
              Retirer l’association
            </button>
          )}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          {context.candidates.length
            ? "Choisissez la commande concernée. Aucune association certaine n’a été trouvée."
            : "Aucune commande identifiée pour cet email."}
        </p>
      )}
      {context.canEdit && (
        <div className="mt-5 border-t pt-4">
          <label className="text-sm font-medium" htmlFor={`order-search-${receiptId}`}>
            Retrouver ou changer la commande
          </label>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const result = await lookup({ receiptId, name });
                setResults(result.orders);
                setNotice(
                  result.hasMore
                    ? "Résultats partiels. Précisez le numéro de commande."
                    : result.orders.length
                      ? "Résultats trouvés. Vérifiez le client avant d’associer."
                      : "Aucune commande trouvée dans l’historique autorisé.",
                );
              });
            }}
          >
            <input
              className="min-w-0 flex-1 rounded-md border px-3 py-2 text-sm"
              id={`order-search-${receiptId}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="#1234"
              required
              maxLength={40}
            />
            <button type="submit" className={button} disabled={busy}>
              Chercher
            </button>
          </form>
          {[...new Map([...results, ...context.candidates].map((o) => [o._id, o])).values()]
            .filter((o) => o._id !== selected?._id)
            .map((order) => (
              <button
                className={`${button} mt-2 w-full text-left`}
                type="button"
                key={order._id}
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await link({ receiptId, orderId: order._id });
                    setResults([]);
                    setNotice("");
                  })
                }
              >
                {order.name} · {new Date(order.placedAt).toLocaleDateString()} · {order.total}{" "}
                {order.currency}
              </button>
            ))}
          {context.limited && (
            <p className="mt-2 text-xs text-muted-foreground">
              Les 25 commandes en cache sont affichées. Utilisez un numéro pour une recherche
              précise.
            </p>
          )}
          {context.mode === "manual" && (
            <button
              type="button"
              className={`${button} mt-2`}
              disabled={busy}
              onClick={() => void perform(() => link({ receiptId, orderId: null, reset: true }))}
            >
              Rétablir l’association automatique
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
function Shipment({ shipment }: { shipment: Doc<"orderShipments"> }) {
  return (
    <section className={`rounded-md border p-3 ${shipment.active ? "" : "opacity-70"}`}>
      <h4 className="text-sm font-semibold">
        {shipment.company || "Colis"} · {statuses[shipment.status] ?? shipment.status}
        {!shipment.active && " · Ancienne expédition"}
      </h4>
      <a
        className="mt-1 inline-block break-all text-sm text-primary underline"
        href={`https://t.17track.net/en#nums=${encodeURIComponent(shipment.number)}`}
        target="_blank"
        rel="noreferrer"
      >
        {shipment.number}
      </a>
      <p className="mt-1 text-xs text-muted-foreground">
        {shipment.syncedAt
          ? `Suivi vérifié le ${new Date(shipment.syncedAt).toLocaleString()}`
          : "En attente des informations du transporteur."}
      </p>
      {shipment.error && (
        <p className="mt-2 text-xs text-destructive">
          Suivi temporairement indisponible. Nouvelle tentative prévue.
        </p>
      )}
      <ol className="mt-3 space-y-3 border-l pl-3">
        {shipment.events.slice(0, 10).map((event) => (
          <li key={JSON.stringify(event)} className="text-sm">
            <p>{event.description || "Mise à jour transporteur"}</p>
            <p className="text-xs text-muted-foreground">
              {event.time ? new Date(event.time).toLocaleString() : "Date non fournie"}
              {event.location && ` · ${event.location}`}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
