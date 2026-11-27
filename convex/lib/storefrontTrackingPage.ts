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

export function trackingMessage(message: string, error = false) {
  return `<p class="message" role="${error ? "alert" : "status"}">${escapeHtml(message)}</p>`;
}

export function trackingResult(
  parcels: readonly {
    number: string;
    status: string;
    events: { description: string; time: number }[];
  }[],
) {
  return `<section class="results" aria-labelledby="result-title">
    <h2 id="result-title">${parcels.length === 1 ? "Votre colis" : "Vos colis"}</h2>
    ${parcels
      .map(
        ({ number, status, events }) => `<article class="parcel">
      <h3>${statusLabels.get(status) ?? "Suivi en attente"}</h3>
      <p class="number">${escapeHtml(number)}</p>
      ${
        events.length
          ? `<details open><summary>Historique du suivi</summary><ol>${events
              .map(
                ({ time, description }) =>
                  `<li><time datetime="${new Date(time).toISOString()}">${dateFormat.format(time)}</time><span>${escapeHtml(description)}</span></li>`,
              )
              .join("")}</ol></details>`
          : "<p>Aucune étape de livraison n’est disponible pour le moment.</p>"
      }
    </article>`,
      )
      .join("")}
  </section>`;
}

export function trackingPage(content = "", status = 200) {
  const orderForm = `<form method="post" action="/storefront/tracking-pilot" aria-labelledby="order-title">
    <h2 id="order-title">Par numéro de commande</h2>
    <input type="hidden" name="mode" value="order">
    <label for="order-number">Numéro de commande</label>
    <input id="order-number" name="number" placeholder="#1234" required maxlength="64" spellcheck="false">
    <label for="order-email">E-mail utilisé pour la commande</label>
    <input id="order-email" name="email" type="email" autocomplete="email" required maxlength="254">
    <button type="submit">Suivre ma commande</button>
  </form>`;
  const trackingForm = `<form method="post" action="/storefront/tracking-pilot" aria-labelledby="tracking-title">
    <h2 id="tracking-title">Par numéro de suivi</h2>
    <input type="hidden" name="mode" value="tracking">
    <label for="tracking">Numéro de suivi</label>
    <input id="tracking" name="number" required maxlength="128" spellcheck="false" autocapitalize="characters">
    <button type="submit">Suivre mon colis</button>
  </form>`;
  return new Response(
    `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Suivi de livraison</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; color: #202124; background: transparent; font: 16px/1.5 system-ui, sans-serif; }
    main { width: min(calc(100% - 2rem), 52rem); margin: clamp(1.25rem, 4vw, 3rem) auto; }
    h1 { margin: 0; font-size: clamp(1.85rem, 5vw, 2.6rem); line-height: 1.15; letter-spacing: -.03em; }
    main > p { margin: .5rem 0 1.4rem; }
    h2 { font-size: 1.12rem; margin: 0 0 .5rem; }
    h3 { font-size: 1.1rem; margin: 0; }
    p, time { color: #525760; }
    .methods { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
    form, .parcel { background: #fff; border: 1px solid #d8dbe0; border-radius: .75rem; padding: clamp(1rem, 3vw, 1.5rem); }
    form { display: grid; align-content: start; gap: .4rem; }
    label, button, summary { font-weight: 600; }
    input, button { min-height: 2.85rem; border-radius: .45rem; padding: .55rem .8rem; font: inherit; }
    input { min-width: 0; width: 100%; border: 1px solid #777d86; margin-bottom: .5rem; }
    button { justify-self: start; color: #fff; background: #24262a; border: 1px solid #24262a; cursor: pointer; font-weight: 600; }
    button:hover { background: #3c4047; }
    :focus-visible { outline: 2px solid #394c66; outline-offset: 3px; }
    .results, .message { margin: 0 0 1rem; }
    .parcel + .parcel { margin-top: .65rem; }
    .number { margin: .2rem 0 .85rem; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .message { padding: .75rem 1rem; background: #f6f7f8; border: 1px solid #d8dbe0; border-radius: .5rem; }
    summary { cursor: pointer; }
    ol { padding: 0 0 0 1.1rem; margin: .75rem 0 0; border-left: 2px solid #d8dbe0; list-style: none; }
    li { position: relative; padding-bottom: .8rem; overflow-wrap: anywhere; }
    li:last-child { padding-bottom: 0; }
    li::before { content: ""; position: absolute; left: -1.43rem; top: .38rem; width: .55rem; height: .55rem; background: #565c65; border-radius: 50%; }
    time { display: block; font-size: .875rem; }
    @media (max-width: 600px) { .methods { grid-template-columns: minmax(0, 1fr); } }
  </style>
</head>
<body>
  <main>
    <h1>Suivre ma livraison</h1>
    <p>Utilisez les informations de votre commande ou le numéro de suivi de votre colis.</p>
    ${content}
    <div class="methods">${orderForm}${trackingForm}</div>
  </main>
</body>
</html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors https://la-combi-bebe.fr https://8vvazz-uj.myshopify.com https://admin.shopify.com https://online-store-web.shopifyapps.com",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
        ...(status === 429 ? { "Retry-After": "60" } : {}),
      },
    },
  );
}
