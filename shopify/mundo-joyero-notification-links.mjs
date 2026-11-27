const trackingPage = "https://mundo-joyero.com/pages/seguimiento-de-pedidos";
const notificationKinds = {
  order_confirmation: { shopLinks: 2 },
  shipping_confirmation: { shopLinks: 2, parcels: true },
  shipping_update: { shopLinks: 2, parcels: true },
  shipment_out_for_delivery: { shopLinks: 0, parcels: true, deliveryButton: true },
  shipment_delivered: { shopLinks: 0, parcels: true },
};

const selectedParcel =
  trackingPage +
  "{% if fulfillment.tracking_numbers.size == 1 %}?nums={{ fulfillment.tracking_numbers.first | url_encode }}{% endif %}";
const parcelLinks = `{% if fulfillment.tracking_numbers.size > 0 %}
  <p class="disclaimer__subtext">
    <br/>
    {% if fulfillment.tracking_company %}{{ fulfillment.tracking_company | escape }} · {% endif %}
    {% if fulfillment.tracking_numbers.size == 1 %}Número de seguimiento:{% else %}Números de seguimiento:{% endif %}
    {% for tracking_number in fulfillment.tracking_numbers %}
      <br/><a href="${trackingPage}?nums={{ tracking_number | url_encode }}"><span dir="ltr" style="display:inline-block;unicode-bidi:isolate">{{ tracking_number | escape }}</span></a>
    {% endfor %}
  </p>
{% endif %}`;

function replaceMatches(source, expression, expected, replacement) {
  const matches = [...source.matchAll(expression)].length;
  if (matches !== expected) {
    throw new Error(`Expected ${expected} occurrences of ${expression.source}; found ${matches}`);
  }
  return source.replace(expression, replacement);
}

export function prepareMundoJoyeroNotification(name, source) {
  const kind = Object.hasOwn(notificationKinds, name) ? notificationKinds[name] : undefined;
  if (!kind) throw new Error(`Unsupported notification: ${name}`);
  if (source.includes(trackingPage))
    throw new Error("The new tracking page is already in the template");

  const destination = kind.parcels ? selectedParcel : trackingPage;
  let updated = replaceMatches(
    source,
    /(<a href=")\{\{ shop_app_tracking_url \}\}("[^>]*>)[\s\S]*?<\/a>/g,
    kind.shopLinks,
    (_match, open, attributes) => `${open}${destination}${attributes}Ver el seguimiento</a>`,
  );

  if (!kind.parcels) {
    return replaceMatches(
      updated,
      /\{% if order_status_url %\}/g,
      1,
      (
        orderButton,
      ) => `{% unless order_status_url and shop_app_tracking_url and shop_app_tracking_button_variant_key %}
              <p><a href="${trackingPage}">Ver el seguimiento</a></p>
            {% endunless %}
            ${orderButton}`,
    );
  }

  updated = replaceMatches(
    updated,
    /\{% if fulfillment\.tracking_numbers\.size > 0 %\}\s*<p class="disclaimer__subtext">[\s\S]*?<\/p>\s*\{% endif %\}/g,
    1,
    parcelLinks,
  );
  if (kind.deliveryButton) {
    updated = replaceMatches(
      updated,
      /href="\{\{ order_status_url \}\}"([^>]*>Rastrear mi envío<\/a>)/g,
      1,
      (_match, suffix) => `href="${destination}"${suffix}`,
    );
  }
  return updated;
}
