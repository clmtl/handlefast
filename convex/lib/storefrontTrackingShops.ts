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
  {
    path: "/storefront/tracking/paso-noble",
    domain: "r6nfea-iv.myshopify.com",
    origins: ["https://paso-noble.es", "https://www.paso-noble.es"],
    locale: "es",
  },
  {
    path: "/storefront/tracking/pluschwelt",
    domain: "dp2iki-0b.myshopify.com",
    origins: ["https://pluschwelt.com", "https://www.pluschwelt.com"],
    locale: "de",
  },
  {
    path: "/storefront/tracking/mundo-lamparas",
    domain: "ymv1px-wc.myshopify.com",
    origins: ["https://mundo-lamparas.es", "https://www.mundo-lamparas.es"],
    locale: "es",
  },
  {
    path: "/storefront/tracking/guertelhaus",
    domain: "86npih-sd.myshopify.com",
    origins: ["https://guertelhaus.de", "https://www.guertelhaus.de"],
    locale: "de",
  },
  {
    path: "/storefront/tracking/peluche-club",
    domain: "c0hrhz-tv.myshopify.com",
    origins: ["https://peluche-club.com", "https://www.peluche-club.com"],
    locale: "es",
  },
  {
    path: "/storefront/tracking/montessori-co",
    domain: "myhhqu-yz.myshopify.com",
    origins: ["https://montessorico.com", "https://www.montessorico.com"],
    locale: "de",
  },
  {
    path: "/storefront/tracking/bolsaria",
    domain: "sdfrqt-ew.myshopify.com",
    origins: ["https://bolsaria.es", "https://www.bolsaria.es"],
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
