import type { DeliveryMap } from "./storefrontDeliveryMap";
import type { StorefrontLanguage } from "./storefrontTrackingLanguage";
import type { StorefrontTrackingShop } from "./storefrontTrackingShops";

const statusLabels = new Map<string, keyof StorefrontLanguage["text"]>([
  ["Unavailable", "unavailable"],
  ["NotFound", "noInfo"],
  ["InfoReceived", "prepared"],
  ["InTransit", "transit"],
  ["Expired", "expired"],
  ["AvailableForPickup", "pickup"],
  ["OutForDelivery", "out"],
  ["DeliveryFailure", "failure"],
  ["Delivered", "delivered"],
  ["Exception", "issue"],
  ["Returning", "returning"],
  ["Returned", "returned"],
] as const);
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
  { locale, text }: StorefrontLanguage,
  parcels: readonly {
    number: string;
    status: string;
    placedAt?: number;
    lastEventAt: number;
    milestones?: Partial<
      Record<
        "prepared" | "transit" | "localCourier" | "pickup" | "outForDelivery" | "delivered",
        number
      >
    >;
  }[],
  destination?: DeliveryMap,
) {
  const dateFormat = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Paris",
  });
  const updateFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Paris",
  });
  const timeTag = (time: number | undefined, format: Intl.DateTimeFormat) =>
    time && Math.abs(time) <= 8.64e15
      ? `<time datetime="${new Date(time).toISOString()}">${format.format(time)}</time>`
      : "";

  return `<section class="results" aria-labelledby="result-title">
    <h2 id="result-title">${parcels.length === 1 ? text.oneParcel : text.parcels}</h2>
    ${parcels
      .map(({ status, number, placedAt, milestones, lastEventAt }) => {
        const pickup =
          status === "AvailableForPickup" ||
          Boolean(milestones?.pickup && !milestones.outForDelivery);
        const steps = [
          { label: text.confirmed, time: placedAt },
          { label: text.prepared, time: milestones?.prepared, statuses: ["InfoReceived"] },
          {
            label: text.transitStep,
            time: milestones?.transit,
            statuses: ["InTransit", "Expired"],
          },
          { label: text.localCourier, time: milestones?.localCourier },
          {
            label: pickup ? text.pickup : text.out,
            time: pickup ? milestones?.pickup : milestones?.outForDelivery,
            statuses: ["AvailableForPickup", "OutForDelivery", "DeliveryFailure"],
          },
          { label: text.delivered, time: milestones?.delivered, statuses: ["Delivered"] },
        ];
        const progress = steps.reduce(
          (last, step, index) => (step.time || step.statuses?.includes(status) ? index : last),
          -1,
        );
        const lastUpdate = timeTag(lastEventAt, updateFormat);
        return `<article class="parcel">
        <div class="parcel-heading">
          <div><h3>${text.trackingNumber}</h3><p class="number">${escapeHtml(number)}</p></div>
          <span class="parcel-status">${text[statusLabels.get(status) ?? "waiting"]}</span>
        </div>
        <ol class="progress" aria-label="${text.progress}">${steps
          .map(({ label, time }, index) => {
            const current = index === Math.max(progress, 0);
            const unconfirmedHandoff = label === text.localCourier && !time && index < progress;
            const done =
              (index < progress && !unconfirmedHandoff) || (current && status === "Delivered");
            return `<li class="${current ? "current" : done ? "done" : unconfirmedHandoff ? "unconfirmed" : "upcoming"}"${current ? ' aria-current="step"' : ""}>
            <span class="marker" aria-hidden="true">${done ? "✓" : ""}</span>
            <span class="step-label">${label}</span>
            ${current || unconfirmedHandoff ? "" : `<span class="sr-only"> — ${done ? text.completed : text.upcoming}</span>`}
            ${timeTag(time, dateFormat)}
          </li>`;
          })
          .join("")}</ol>
        ${lastUpdate ? `<p class="last-update">${text.updated} · ${lastUpdate}</p>` : ""}
      </article>`;
      })
      .join("")}
    ${
      destination
        ? `<figure class="delivery-map">
      <figcaption><strong>${text.deliveryArea}</strong> · ${escapeHtml(destination.city)}</figcaption>
      ${
        destination.url
          ? `<iframe title="${text.deliveryArea}" src="${escapeHtml(destination.url)}" loading="lazy" referrerpolicy="no-referrer"></iframe>`
          : ""
      }
      ${destination.source === "GeoNames" ? '<p class="map-source"><a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">© GeoNames</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a></p>' : ""}
    </figure>`
        : ""
    }
  </section>`;
}

export function trackingPage(
  shop: StorefrontTrackingShop,
  { locale, text }: StorefrontLanguage,
  content = "",
  status = 200,
  themeAccent?: string | null,
) {
  const hasAccent = themeAccent && /^#[0-9a-f]{6}$/i.test(themeAccent);
  const accent = hasAccent ? themeAccent : "#24262a";
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(accent.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  const foreground = luminance > 0.179 ? "#000" : "#fff";
  const params = new URLSearchParams({ lang: locale });
  if (hasAccent) params.set("accent", accent);
  const action = escapeHtml(`${shop.path}?${params.toString()}`);
  const orderForm = `<form method="post" action="${action}" aria-labelledby="order-title">
    <h2 id="order-title">${text.byOrder}</h2>
    <input type="hidden" name="mode" value="order">
    <label for="order-number">${text.orderNumber}</label>
    <input id="order-number" name="number" placeholder="#1234" required maxlength="64" spellcheck="false">
    <label for="order-email">${text.email}</label>
    <input id="order-email" name="email" type="email" autocomplete="email" required maxlength="254">
    <button type="submit">${text.findOrder}</button>
  </form>`;
  const trackingForm = `<form method="post" action="${action}" aria-labelledby="tracking-title">
    <h2 id="tracking-title">${text.byTracking}</h2>
    <input type="hidden" name="mode" value="tracking">
    <label for="tracking">${text.trackingNumber}</label>
    <input id="tracking" name="number" required maxlength="128" spellcheck="false" autocapitalize="characters">
    <button type="submit">${text.findTracking}</button>
  </form>`;
  return new Response(
    `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${text.title}</title>
  <style>
    :root { --button-color: ${accent}; --button-text: ${foreground}; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #202124; background: transparent; font: 16px/1.5 system-ui, sans-serif; }
    main { width: min(calc(100% - 2rem), 52rem); margin: clamp(1.25rem, 4vw, 3rem) auto; }
    h1 { margin: 0; font-size: clamp(1.85rem, 5vw, 2.6rem); line-height: 1.15; letter-spacing: -.03em; }
    main > p { margin: .5rem 0 1.4rem; }
    h2 { font-size: 1.12rem; margin: 0 0 .5rem; }
    h3 { font-size: 1.1rem; margin: 0; }
    p, time { color: #525760; }
    .methods { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: .75rem; }
    .method-separator { align-self: center; margin: 0; color: #525760; font-size: .9rem; font-weight: 650; }
    form, .parcel { background: #fff; border: 1px solid #d8dbe0; border-radius: .75rem; padding: clamp(1rem, 3vw, 1.5rem); }
    form { display: grid; align-content: start; gap: .4rem; }
    label, button, summary { font-weight: 600; }
    input, button { min-height: 2.85rem; border-radius: .45rem; padding: .55rem .8rem; font: inherit; }
    input { min-width: 0; width: 100%; border: 1px solid #777d86; margin-bottom: .5rem; }
    button { justify-self: start; color: var(--button-text); background: var(--button-color); border: 1px solid var(--button-color); cursor: pointer; font-weight: 600; }
    button:hover { text-decoration: underline; }
    :focus-visible { outline: 2px solid #394c66; outline-offset: 3px; }
    .results, .message { margin: 0 0 1.25rem; }
    .parcel + .parcel { margin-top: .75rem; }
    .parcel-heading { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: .5rem; }
    .parcel-heading h3 { font-size: .82rem; color: #525760; }
    .number { margin: .12rem 0 0; color: #202124; font-weight: 650; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .parcel-status { display: inline-block; padding: .28rem .7rem; border-radius: 99px; background: #e9f2ee; color: #234d3b; font-weight: 650; font-size: .875rem; }
    .message { padding: .75rem 1rem; background: #f6f7f8; border: 1px solid #d8dbe0; border-radius: .5rem; }
    .progress { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); list-style: none; padding: 0; margin: 1.4rem 0 0; }
    .progress li { position: relative; display: grid; grid-template-rows: 1.55rem auto auto; justify-items: center; align-content: start; gap: .45rem; text-align: center; padding: 0 .2rem; }
    .progress li + li::before { content: ""; position: absolute; top: .73rem; right: 50%; width: 100%; border-top: 2px solid #d8dbe0; }
    .progress li.done::before, .progress li.current::before { border-color: #42836b; }
    .marker { z-index: 1; display: grid; place-items: center; flex: none; width: 1.55rem; height: 1.55rem; border: 2px solid #c6ccc9; border-radius: 50%; background: white; color: white; font-size: .83rem; }
    .done .marker, .current .marker { border-color: #286950; background: #286950; }
    .current .marker { box-shadow: 0 0 0 4px #e2efe9; }
    .step-label { font-size: .85rem; font-weight: 650; overflow-wrap: anywhere; line-height: 1.25; }
    .upcoming .step-label, .unconfirmed .step-label { color: #60656b; font-weight: 550; }
    time { font-size: .8rem; }
    .last-update { margin: 1rem 0 0; font-size: .8rem; border-top: 1px solid #e6e7e8; padding-top: .65rem; }
    .delivery-map { margin: .75rem 0 0; overflow: hidden; background: #fff; border: 1px solid #d8dbe0; border-radius: .75rem; }
    .delivery-map figcaption { padding: .7rem 1rem; }
    .map-source { margin: .35rem .75rem; font-size: .75rem; }
    .delivery-map iframe { display: block; border: 0; width: 100%; height: 235px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    @media (max-width: 600px) {
      .methods { grid-template-columns: minmax(0, 1fr); }
      .method-separator { justify-self: center; }
      .progress { grid-template-columns: 1fr; gap: .65rem; }
      .progress li { display: flex; flex-wrap: wrap; align-items: center; min-height: 1.55rem; padding: 0; text-align: start; gap: .55rem; }
      .progress li + li::before { width: 0; height: .7rem; border-top: 0; border-left: 2px solid #d8dbe0; left: .73rem; top: -.7rem; right: auto; }
      .progress li.done::before, .progress li.current::before { border-color: #42836b; }
    }
  </style>
</head>
<body>
  <main>
    <h1>${text.title}</h1>
    <p>${text.intro}</p>
    ${content}
    <div class="methods">${orderForm}<p class="method-separator">${text.separator}</p>${trackingForm}</div>
  </main>
</body>
</html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-src https://www.openstreetmap.org; base-uri 'none'; frame-ancestors ${shop.origins.join(" ")} https://${shop.domain} https://admin.shopify.com https://online-store-web.shopifyapps.com`,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
        ...(status === 429 ? { "Retry-After": "60" } : {}),
      },
    },
  );
}
