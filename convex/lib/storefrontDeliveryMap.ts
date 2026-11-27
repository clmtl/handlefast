import { z } from "zod";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";

type Destination = { city: string; country: string; zip: string };
export type DeliveryMap = { city: string; url?: string };

const communeList = z.array(
  z.object({
    nom: z.string(),
    codesPostaux: z.array(z.string()).optional(),
    centre: z.object({ coordinates: z.tuple([z.number(), z.number()]) }).optional(),
  }),
);

const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{M}|[^\p{L}\p{N}]/gu, "")
    .toLowerCase();

async function frenchPoint(city: string, zip: string) {
  const endpoint = new URL("https://geo.api.gouv.fr/communes");
  endpoint.search = new URLSearchParams({
    nom: city,
    fields: "nom,centre,codesPostaux",
    limit: "30",
  }).toString();
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) return null;
  const matches = communeList
    .parse(await response.json())
    .filter((commune) => normalize(commune.nom) === normalize(city));
  const postalMatches = matches.filter((commune) => commune.codesPostaux?.includes(zip));
  const selected =
    postalMatches.length === 1 ? postalMatches[0] : matches.length === 1 ? matches[0] : undefined;
  return selected?.centre?.coordinates;
}

const spanishPlace = z.object({
  id: z.string(),
  type: z.string(),
  provinceCode: z.string().nullable().optional(),
  muni: z.string().nullable().optional(),
  poblacion: z.string().nullable().optional(),
});

async function spanishPoint(city: string, zip: string) {
  const base = "https://www.cartociudad.es/geocoder/api/geocoder/";
  const candidates = new URL("candidates", base);
  candidates.search = new URLSearchParams({ q: city, limit: "20" }).toString();
  const signal = AbortSignal.timeout(5000);
  const response = await fetch(candidates, { signal });
  if (!response.ok) return null;
  const matches = z
    .array(spanishPlace)
    .parse(await response.json())
    .filter((place) => {
      const name =
        place.type === "Municipio"
          ? place.muni
          : place.type === "poblacion"
            ? place.poblacion
            : null;
      return name?.split("/").some((alias) => normalize(alias) === normalize(city));
    });
  const province = /^\d{5}$/.test(zip) ? zip.slice(0, 2) : "";
  const local = matches.filter((place) => place.provinceCode === province);
  const choices = local.length ? local : matches;
  const municipalities = choices.filter((place) => place.type === "Municipio");
  const places = municipalities.length ? municipalities : choices;
  const unique = [...new Map(places.map((place) => [place.id, place])).values()];
  if (unique.length !== 1) return null;
  const [place] = unique;

  const center = new URL("find", base);
  center.search = new URLSearchParams({ id: place.id, type: place.type }).toString();
  const resolved = await fetch(center, { signal });
  if (!resolved.ok) return null;
  const result = spanishPlace
    .extend({ lng: z.number(), lat: z.number() })
    .parse(await resolved.json());
  return result.id === place.id && (result.lng !== 0 || result.lat !== 0)
    ? [result.lng, result.lat]
    : null;
}

async function resolvePoint(ctx: ActionCtx, country: "FR" | "ES", city: string, zip: string) {
  const cachePrefix = country === "ES" ? "ES:" : "";
  const key = `${cachePrefix}${normalize(city)}:${/^\d{5}$/.test(zip) ? zip : ""}`;
  const cached = await ctx.runQuery(internal.storefrontTracking.deliveryPoint, { key });
  if (cached) return cached;

  const point = country === "ES" ? await spanishPoint(city, zip) : await frenchPoint(city, zip);
  if (!point) return null;
  const [longitude, latitude] = point;
  if (Math.abs(latitude) > 89 || Math.abs(longitude) > 179) return null;
  await ctx.runMutation(internal.storefrontTracking.saveDeliveryPoint, {
    key,
    longitude,
    latitude,
  });
  return point;
}

export async function deliveryMap(
  ctx: ActionCtx,
  destination?: Destination,
): Promise<DeliveryMap | undefined> {
  if (!destination) return undefined;
  const city = destination.city.trim();
  if (!city || city.length > 100) return undefined;
  const fallback = { city };
  if (destination.country !== "FR" && destination.country !== "ES") return fallback;

  try {
    const point = await resolvePoint(ctx, destination.country, city, destination.zip.trim());
    if (!point) return fallback;
    const [longitude, latitude] = point;
    const map = new URL("https://www.openstreetmap.org/export/embed.html");
    map.searchParams.set("layer", "mapnik");
    map.searchParams.set(
      "marker",
      [latitude, longitude].map((value) => value.toFixed(3)).join(","),
    );
    map.searchParams.set(
      "bbox",
      [longitude - 0.07, latitude - 0.045, longitude + 0.07, latitude + 0.045]
        .map((value) => value.toFixed(3))
        .join(","),
    );
    return { city, url: map.href };
  } catch {
    return fallback;
  }
}
