// Toronto's supervised swimming beaches. Coordinates are the beach itself
// (used for Open-Meteo point forecasts). `name` must match the naming used
// in the City of Toronto open datasets; `aliases` cover known variants.
export const BEACHES = [
  { slug: "marie-curtis", name: "Marie Curtis Park East Beach", short: "Marie Curtis", lat: 43.5855, lon: -79.5439, aliases: ["marie curtis"] },
  { slug: "sunnyside", name: "Sunnyside Beach", short: "Sunnyside", lat: 43.6368, lon: -79.4552, aliases: [] },
  { slug: "hanlans-point", name: "Hanlan's Point Beach", short: "Hanlan's Point", lat: 43.6198, lon: -79.3944, aliases: ["hanlans point"] },
  { slug: "gibraltar-point", name: "Gibraltar Point Beach", short: "Gibraltar Point", lat: 43.6134, lon: -79.3831, aliases: [] },
  { slug: "centre-island", name: "Centre Island Beach", short: "Centre Island", lat: 43.6172, lon: -79.3733, aliases: [] },
  { slug: "wards-island", name: "Ward's Island Beach", short: "Ward's Island", lat: 43.6163, lon: -79.3524, aliases: ["wards island"] },
  { slug: "cherry", name: "Cherry Beach", short: "Cherry", lat: 43.6369, lon: -79.3441, aliases: ["cherry beach clarke beach"] },
  { slug: "woodbine", name: "Woodbine Beaches", short: "Woodbine", lat: 43.6626, lon: -79.3065, aliases: ["woodbine beach"] },
  { slug: "kew-balmy", name: "Kew Balmy Beach", short: "Kew Balmy", lat: 43.6683, lon: -79.2931, aliases: ["kew-balmy beach", "kew beach", "balmy beach"] },
  { slug: "bluffers", name: "Bluffer's Beach Park", short: "Bluffer's", lat: 43.7047, lon: -79.2323, aliases: ["bluffers park beach", "bluffers beach"] },
  { slug: "rouge", name: "Rouge Beach", short: "Rouge", lat: 43.7948, lon: -79.1153, aliases: ["rouge beach park"] },
];

export const DEFAULT_SLUG = "kew-balmy";

const normalize = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();

const bySlug = new Map(BEACHES.map((b) => [b.slug, b]));
const byName = new Map();
for (const b of BEACHES) {
  byName.set(normalize(b.name), b);
  for (const a of b.aliases) byName.set(normalize(a), b);
}

export function beachForSlug(slug) {
  return bySlug.get(slug);
}

// Match a beach name as it appears in a city dataset row to our registry.
export function beachForCityName(cityName) {
  if (!cityName) return undefined;
  const n = normalize(cityName);
  if (byName.has(n)) return byName.get(n);
  // Fall back to containment either way, so "Kew Balmy Beach (East)" still matches.
  for (const [key, beach] of byName) {
    if (n.includes(key) || key.includes(n)) return beach;
  }
  return undefined;
}
