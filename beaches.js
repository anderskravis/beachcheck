// Toronto's supervised swimming beaches. Coordinates are the beach itself
// (used for Open-Meteo point forecasts). `name` must match the naming used
// in the City of Toronto open datasets; `aliases` cover known variants.
export const BEACHES = [
  { slug: "marie-curtis", name: "Marie Curtis Park East Beach", short: "Marie Curtis", lat: 43.5835, lon: -79.5426, aliases: ["marie curtis"] },
  { slug: "sunnyside", name: "Sunnyside Beach", short: "Sunnyside", lat: 43.6368, lon: -79.4552, aliases: [] },
  { slug: "hanlans-point", name: "Hanlan's Point Beach", short: "Hanlan's Point", lat: 43.6198, lon: -79.3944, aliases: ["hanlans point"] },
  { slug: "gibraltar-point", name: "Gibraltar Point Beach", short: "Gibraltar Point", lat: 43.6132, lon: -79.3820, aliases: [] },
  { slug: "centre-island", name: "Centre Island Beach", short: "Centre Island", lat: 43.6155, lon: -79.3752, aliases: [] },
  { slug: "wards-island", name: "Ward's Island Beach", short: "Ward's Island", lat: 43.6300, lon: -79.3524, aliases: ["wards island"] },
  { slug: "cherry", name: "Cherry Beach", short: "Cherry", lat: 43.6369, lon: -79.3441, aliases: ["cherry beach clarke beach"] },
  { slug: "woodbine", name: "Woodbine Beaches", short: "Woodbine", lat: 43.6626, lon: -79.3065, aliases: ["woodbine beach"] },
  { slug: "kew-balmy", name: "Kew Balmy Beach", short: "Kew Balmy", lat: 43.6668, lon: -79.2946, aliases: ["kew-balmy beach", "kew beach", "balmy beach"] },
  { slug: "bluffers", name: "Bluffer's Beach Park", short: "Bluffer's", lat: 43.7047, lon: -79.2323, aliases: ["bluffers park beach", "bluffers beach"] },
  { slug: "rouge", name: "Rouge Beach", short: "Rouge", lat: 43.7948, lon: -79.1153, aliases: ["rouge beach park"] },
];

export const DEFAULT_SLUG = "kew-balmy";

// Rough (lon, lat) traces of the waterfront for the map — stylized, not
// survey-grade. West (Marie Curtis) to east (Rouge).
export const SHORELINE = [
  [-79.65, 43.575], [-79.59, 43.585], [-79.545, 43.585], [-79.51, 43.596],
  [-79.48, 43.611], [-79.463, 43.628], [-79.445, 43.638], [-79.42, 43.634],
  [-79.40, 43.637], [-79.37, 43.641], [-79.345, 43.647], [-79.33, 43.649],
  [-79.315, 43.657], [-79.30, 43.663], [-79.288, 43.669], [-79.265, 43.681],
  [-79.235, 43.70], [-79.19, 43.735], [-79.145, 43.767], [-79.113, 43.795],
  [-79.05, 43.835],
];

export const ISLANDS = [
  [-79.402, 43.618], [-79.393, 43.611], [-79.381, 43.608], [-79.368, 43.609],
  [-79.352, 43.612], [-79.347, 43.62], [-79.36, 43.627], [-79.381, 43.627],
  [-79.396, 43.624],
];

export const SPIT = [
  [-79.328, 43.648], [-79.316, 43.632], [-79.327, 43.612], [-79.34, 43.613],
  [-79.329, 43.637], [-79.334, 43.648],
];

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
