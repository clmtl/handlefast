export const storefrontTrackingShops = [
  {
    path: "/storefront/tracking-pilot",
    domain: "8vvazz-uj.myshopify.com",
    origins: ["https://la-combi-bebe.fr"],
    locale: "fr",
  },
  {
    path: "/storefront/tracking/mundo-joyero",
    domain: "1k6cdz-v0.myshopify.com",
    origins: ["https://mundo-joyero.com", "https://www.mundo-joyero.com"],
    locale: "es",
  },
] as const;

export type StorefrontTrackingShop = (typeof storefrontTrackingShops)[number];

export function enabledTrackingDomains(setting: string | undefined) {
  const domains = new Set(setting?.split(",").map((domain) => domain.trim()));
  return storefrontTrackingShops
    .map(({ domain }) => domain)
    .filter((domain) => domains.has(domain));
}
