import { z } from "zod";

type Destination = { city: string; country: string; zip: string };
export type DeliveryMap = { city: string; url?: string };

const communeList = z.array(
  z.object({
    nom: z.string(),
    codesPostaux: z.array(z.string()).optional(),
    centre: z.object({ coordinates: z.tuple([z.number(), z.number()]) }).optional(),
  }),
);

export async function deliveryMap(destination?: Destination): Promise<DeliveryMap | undefined> {
  if (!destination) return undefined;
  const city = destination.city.trim();
  if (!city || city.length > 100) return undefined;
  const fallback = { city };
  if (destination.country !== "FR") return fallback;

  const endpoint = new URL("https://geo.api.gouv.fr/communes");
  endpoint.search = new URLSearchParams({
    nom: city,
    fields: "nom,centre,codesPostaux",
    limit: "30",
  }).toString();
  const normalize = (value: string) =>
    value
      .normalize("NFD")
      .replace(/\p{M}|[^\p{L}\p{N}]/gu, "")
      .toLowerCase();
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return fallback;
    const matches = communeList
      .parse(await response.json())
      .filter((commune) => normalize(commune.nom) === normalize(city));
    const postalMatches = matches.filter((commune) =>
      commune.codesPostaux?.includes(destination.zip),
    );
    const selected =
      postalMatches.length === 1 ? postalMatches[0] : matches.length === 1 ? matches[0] : undefined;
    const point = selected?.centre?.coordinates;
    if (!point) return fallback;
    const [longitude, latitude] = point;
    if (Math.abs(latitude) > 89 || Math.abs(longitude) > 179) return fallback;
    const map = new URL("https://www.openstreetmap.org/export/embed.html");
    map.searchParams.set("layer", "mapnik");
    map.searchParams.set(
      "marker",
      point
        .slice()
        .reverse()
        .map((value) => value.toFixed(3))
        .join(","),
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
