const statusLabels: ReadonlyMap<string, string> = new Map([
  ["Unavailable", "Suivi indisponible"],
  ["NotFound", "Pas encore d’information"],
  ["InfoReceived", "Étiquette créée"],
  ["InTransit", "En transit"],
  ["Expired", "Suivi expiré"],
  ["AvailableForPickup", "Disponible au retrait"],
  ["OutForDelivery", "En livraison"],
  ["DeliveryFailure", "Échec de livraison"],
  ["Delivered", "Livré"],
  ["Exception", "Incident transporteur"],
  ["Returning", "Retour en cours"],
  ["Returned", "Retourné"],
]);

const dateFormat = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Europe/Paris",
});

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function trackingResult(shipment: {
  status: string;
  events: { description: string; time: number | null }[];
}) {
  const events = shipment.events.flatMap(({ description, time }) =>
    time === null || !description.trim()
      ? []
      : [
          `<li><time datetime="${new Date(time).toISOString()}">${dateFormat.format(time)}</time><span>${escapeHtml(description)}</span></li>`,
        ],
  );
  return `<section class="result" aria-labelledby="result-title">
    <h2 id="result-title">${statusLabels.get(shipment.status) ?? "Suivi en attente"}</h2>
    ${events.length ? `<ol>${events.join("")}</ol>` : "<p>Aucune étape de livraison n’est disponible pour le moment.</p>"}
  </section>`;
}

export function trackingPage(content = "", status = 200, number = "") {
  return new Response(
    `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Suivre mon colis | La Combi Bébé</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; color: #29231e; background: #fffaf4; font: 16px/1.5 system-ui, sans-serif; }
    main { width: min(100% - 2rem, 38rem); margin: clamp(1.5rem, 5vw, 3.5rem) auto; }
    h1 { margin: 0; font-size: clamp(1.9rem, 7vw, 2.75rem); line-height: 1.1; letter-spacing: -.035em; }
    p { margin: .65rem 0 1.25rem; color: #5b4c41; }
    form, .result { background: #fff; border: 1px solid #e8d9ca; border-radius: 1rem; padding: clamp(1rem, 4vw, 1.6rem); }
    form { display: grid; gap: .45rem; }
    label, button { font-weight: 650; }
    input, button { min-height: 2.85rem; border-radius: .5rem; padding: .55rem .8rem; font: inherit; }
    input { min-width: 0; width: 100%; border: 1px solid #8d7b6f; margin-bottom: .55rem; }
    button { color: white; background: #513526; border: 1px solid #513526; cursor: pointer; font-weight: 650; }
    :focus-visible { outline: 3px solid #a34f21; outline-offset: 2px; }
    .result, .message { margin-top: 1rem; }
    .message { padding: .75rem 1rem; border: 1px solid #e8d9ca; border-radius: .5rem; }
    h2 { font-size: 1.35rem; margin: 0; }
    ol { list-style: none; padding: 0 0 0 1.25rem; margin: 1rem 0 0; border-left: 2px solid #e8d9ca; }
    li { position: relative; padding-bottom: 1.1rem; overflow-wrap: anywhere; }
    li:last-child { padding-bottom: 0; }
    li::before { content: ""; position: absolute; left: -1.63rem; top: .35rem; width: .65rem; height: .65rem; background: #9c5639; border-radius: 50%; }
    time { display: block; color: #5b4c41; font-size: .875rem; }
  </style>
</head>
<body>
  <main>
    <h1>Suivre mon colis</h1>
    <p>Entre ton numéro de suivi et le code d’accès au pilote.</p>
    <form method="post" action="/storefront/tracking-pilot" autocomplete="off">
      <label for="tracking">Numéro de suivi</label>
      <input id="tracking" name="tracking" value="${escapeHtml(number)}" required maxlength="64" spellcheck="false" autocapitalize="characters">
      <label for="code">Code d’accès</label>
      <input id="code" name="code" type="password" required maxlength="128">
      <button type="submit">Voir le suivi</button>
    </form>
    ${content}
  </main>
</body>
</html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors https://la-combi-bebe.fr https://8vvazz-uj.myshopify.com https://admin.shopify.com",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );
}
