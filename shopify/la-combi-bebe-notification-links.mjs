const trackingPage = "https://la-combi-bebe.fr/pages/suivi-colis";
const trackingLinks = [
  "shipping_confirmation",
  "shipping_update",
  "shipment_out_for_delivery",
  "shipment_delivered",
];

function replaceOnce(source, expression, replacement) {
  const matches = [...source.matchAll(new RegExp(expression.source, "g"))];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one occurrence of ${expression.source}; found ${matches.length}`,
    );
  }
  return source.replace(expression, replacement);
}

export function prepareNotification(name, source) {
  if (source.includes(trackingPage))
    throw new Error("The new tracking page is already in the template");
  if (name === "order_confirmation") {
    return replaceOnce(
      source,
      /<a href="\{\{\s*order_status_url\s*\}\}"[^>]*>[\s\S]*?<\/a>/,
      (anchor) => `${anchor}
          <p style="margin:12px 0 0;text-align:center"><a href="${trackingPage}" style="color:#3D6954;text-decoration:underline">Suivre ma livraison</a></p>`,
    );
  }

  if (!trackingLinks.includes(name)) throw new Error(`Unsupported notification: ${name}`);
  const itemLink =
    /\{% if fulfillment\.tracking_urls\[forloop\.index0\] != blank %\}(<br><a href=")\{\{\s*fulfillment\.tracking_urls\[forloop\.index0\]\s*\}\}("[^>]*>[\s\S]*?<\/a>)\{% endif %\}/;
  let updated = replaceOnce(
    source,
    itemLink,
    (_match, before, after) =>
      `${before}${trackingPage}?nums={{ tracking_number | url_encode }}${after}`,
  );

  if (["shipping_confirmation", "shipping_update"].includes(name)) {
    updated = replaceOnce(
      updated,
      /\{% if fulfillment\.tracking_urls\.size == 1 %\}/,
      "{% if fulfillment.tracking_numbers.size == 1 %}",
    );
    updated = replaceOnce(
      updated,
      /href="\{\{\s*fulfillment\.tracking_urls\.first\s*\}\}"/,
      `href="${trackingPage}?nums={{ fulfillment.tracking_numbers.first | url_encode }}"`,
    );
  }

  return updated;
}
