// Fetches Toronto beach data from the city's open data portal (CKAN) and
// writes data/conditions.json for the site to consume.
//
// Usage:
//   node scripts/fetch-conditions.mjs             # live fetch (runs in CI)
//   node scripts/fetch-conditions.mjs --fixtures  # use data/fixtures/*.json
//
// No dependencies; requires Node 20+.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BEACHES, beachForCityName } from "../beaches.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CKAN = "https://ckan0.cf.opendata.inter.prod-toronto.ca";
// Live per-day results powering the city's own beach water quality page.
// The CKAN datasets below lag a full season behind; this is the current data.
const LIVE_RESULTS = "https://secure.toronto.ca/opendata/adv/beach_results/v1";
const WATER_QUALITY_PACKAGE = "toronto-beaches-water-quality";
const OBSERVATIONS_PACKAGE = "toronto-beaches-observations";
const HISTORY_DAYS = 14;
const USE_FIXTURES = process.argv.includes("--fixtures");

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// Returns the CKAN datastore_search result ({ fields, records }) for a package.
async function fetchDatastore(packageId, fixtureName) {
  if (USE_FIXTURES) {
    const raw = await readFile(path.join(ROOT, "data", "fixtures", fixtureName), "utf8");
    return JSON.parse(raw).result;
  }
  const pkg = await getJson(`${CKAN}/api/3/action/package_show?id=${packageId}`);
  const resource = pkg.result.resources.find((r) => r.datastore_active);
  if (!resource) throw new Error(`no datastore resource in ${packageId}`);
  // Row order in the datastore doesn't track recency (_id desc returns 2007
  // rows for water quality), so probe the field list and sort by the actual
  // date column. ISO dates sort correctly even when the column is text.
  const probe = await getJson(
    `${CKAN}/api/3/action/datastore_search?resource_id=${resource.id}&limit=1`
  );
  const dateField = probe.result.fields
    .map((f) => f.id)
    .find((id) => /date/i.test(id));
  const sort = encodeURIComponent(`${dateField ?? "_id"} desc`);
  const search = await getJson(
    `${CKAN}/api/3/action/datastore_search?resource_id=${resource.id}&sort=${sort}&limit=2000`
  );
  return search.result;
}

// Response shape: [{ CollectionDate, data: [{ beachId, beachName, eColi, advisory, statusFlag }] }]
async function fetchLiveResults() {
  if (USE_FIXTURES) {
    const raw = await readFile(path.join(ROOT, "data", "fixtures", "beach-results.json"), "utf8");
    return JSON.parse(raw);
  }
  const end = new Date();
  const start = new Date(end.getTime() - HISTORY_DAYS * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return getJson(`${LIVE_RESULTS}?format=json&startDate=${fmt(start)}&endDate=${fmt(end)}`);
}

// The live feed already carries one value per beach per day plus the city's
// own SAFE/UNSAFE call. Returns the same per-slug shape as the CKAN summary.
function summarizeLiveResults(days) {
  const bySlug = new Map(); // slug -> [{date, eColi, statusFlag}]
  for (const day of days ?? []) {
    const date = dayOf(day.CollectionDate ?? day.collectionDate);
    for (const rec of day.data ?? []) {
      const beach = beachForCityName(rec.beachName);
      const eColi = toNumber(rec.eColi);
      if (!beach || !date || eColi === null) continue;
      if (!bySlug.has(beach.slug)) bySlug.set(beach.slug, []);
      bySlug.get(beach.slug).push({ date, eColi, statusFlag: rec.statusFlag ?? null });
    }
  }
  const out = {};
  for (const [slug, entries] of bySlug) {
    entries.sort((a, b) => b.date.localeCompare(a.date));
    const latest = entries[0];
    out[slug] = {
      eColi: latest.eColi,
      sampleDate: latest.date,
      statusFlag: latest.statusFlag,
      history: entries.slice(0, HISTORY_DAYS).map(({ date, eColi }) => ({ date, eColi })),
    };
  }
  return out;
}

// Open Water Data (openwaterdata.com) runs IoT water-temperature buoys at
// some Toronto beaches (Kew-Balmy, Cherry). Their site search returns each
// matching site with its latest measurements.
const OWD = "https://www.openwaterdata.com";
const OWD_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const BUOY_MAX_AGE_MS = 48 * 3600 * 1000;

// "Tue, Jul 7, 2026 at 8:44pm" (Toronto local) -> Date, or null.
function parseOwdTime(t) {
  const m = String(t ?? "").match(/(\w{3}) (\d+), (\d{4})(?: at (\d+):(\d+)(am|pm))?/);
  if (!m || !(m[1] in OWD_MONTHS)) return null;
  let hours = m[4] ? Number(m[4]) % 12 : 12;
  if (m[6] === "pm") hours += 12;
  // Treat as UTC-4 (EDT); buoys only matter in summer, and we only use this
  // for a 48-hour freshness check.
  return new Date(Date.UTC(Number(m[3]), OWD_MONTHS[m[1]], Number(m[2]), hours + 4, Number(m[5] ?? 0)));
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111.32;
  const dLon = (lon2 - lon1) * 111.32 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

// Search OWD per beach and keep a fresh buoy water temp when a site sits
// within 2.5 km of the beach. Sequential on purpose — be polite to them.
async function fetchBuoyTemps() {
  const fixtures = USE_FIXTURES
    ? JSON.parse(await readFile(path.join(ROOT, "data", "fixtures", "owd-sites.json"), "utf8"))
    : null;
  const out = {};
  for (const beach of BEACHES) {
    try {
      const keyword = beach.short.split(/[\s']/)[0].toLowerCase();
      const res = fixtures
        ? fixtures[beach.slug] ?? { Data: { sites: [] } }
        : await getJson(`${OWD}/data/sites?keywords=${encodeURIComponent(keyword)}`);
      for (const site of res?.Data?.sites ?? []) {
        if (!site.slug || distanceKm(beach.lat, beach.lon, site.lat, site.lng) > 2.5) continue;
        const temp = (site.data ?? []).find((d) => d.m === "Water Temperature");
        const time = temp && parseOwdTime(temp.t);
        if (!time || Date.now() - time.getTime() > BUOY_MAX_AGE_MS) continue;
        const value = toNumber(temp.r);
        if (value === null) continue;
        out[beach.slug] = { waterTemp: value, time: time.toISOString(), site: site.l };
        break;
      }
    } catch (e) {
      console.error(`buoy lookup failed for ${beach.slug}:`, e.message);
    }
  }
  return out;
}

// NW Lake Ontario buoy 45159 (near Ajax; Environment and Climate Change
// Canada, relayed through NOAA's National Data Buoy Center) — the one real
// wave-height reading available for the lake. Open-Meteo's marine model has
// no Great Lakes coverage at all (it was returning a flat, fake 0.0 m).
// One shared regional reading applied to every beach, not per-beach.
const LAKE_BUOY = "https://www.ndbc.noaa.gov/data/realtime2/45159.txt";
const LAKE_BUOY_MAX_AGE_MS = 4 * 3600 * 1000; // updates hourly; allow some slack

// Fixed-width columns, most-recent row first:
// #YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
function parseLakeBuoy(text) {
  const row = text
    .trim()
    .split("\n")
    .find((l) => !l.startsWith("#"));
  if (!row) return null;
  const c = row.trim().split(/\s+/);
  const num = (v) => (v === undefined || v === "MM" ? null : toNumber(v));
  const time = new Date(Date.UTC(Number(c[0]), Number(c[1]) - 1, Number(c[2]), Number(c[3]), Number(c[4])));
  if (Number.isNaN(time.getTime()) || Date.now() - time.getTime() > LAKE_BUOY_MAX_AGE_MS) return null;
  const windMs = num(c[6]);
  return {
    time: time.toISOString(),
    waveHeightM: num(c[8]),
    waterTempC: num(c[14]),
    windKn: windMs != null ? Math.round(windMs * 1.9438445 * 10) / 10 : null,
    station: "45159",
  };
}

async function fetchLakeBuoy() {
  const text = USE_FIXTURES
    ? await readFile(path.join(ROOT, "data", "fixtures", "lake-buoy.txt"), "utf8")
    : await (async () => {
        const res = await fetch(LAKE_BUOY);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      })();
  return parseLakeBuoy(text);
}

// Rainfall over the previous 48 hours, per beach. Heavy rain washes runoff
// into the lake and can spike E. coli well before the (day-delayed) samples
// catch up — the classic "don't swim for 48h after a storm" rule. Summer
// storms are localized enough across the ~40 km beach span to be worth
// per-beach numbers; Open-Meteo takes comma-separated coordinates and
// returns one result per point, so it's still a single request.
const RAIN_HOURS = 48;

async function fetchRain48h() {
  if (USE_FIXTURES) {
    // A mix: a couple of soaked beaches to exercise the caution escalation,
    // dry everywhere else.
    return Object.fromEntries(
      BEACHES.map((b) => [b.slug, b.slug === "woodbine" ? 31.2 : b.slug === "kew-balmy" ? 26.4 : 2.1])
    );
  }
  const lats = BEACHES.map((b) => b.lat).join(",");
  const lons = BEACHES.map((b) => b.lon).join(",");
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
    `&hourly=precipitation&past_days=2&forecast_days=1&timezone=UTC`;
  const res = await getJson(url);
  const locations = Array.isArray(res) ? res : [res];
  const now = Date.now();
  const cutoff = now - RAIN_HOURS * 3600 * 1000;
  const out = {};
  BEACHES.forEach((beach, i) => {
    const hourly = locations[i]?.hourly;
    if (!hourly?.time) return;
    let mm = 0;
    hourly.time.forEach((t, j) => {
      const ts = Date.parse(`${t}:00Z`);
      // Only hours that have actually happened — the request includes today's
      // forecast hours, and predicted rain shouldn't count as fallen rain.
      if (ts >= cutoff && ts <= now && hourly.precipitation[j] != null) {
        mm += hourly.precipitation[j];
      }
    });
    out[beach.slug] = Math.round(mm * 10) / 10;
  });
  return out;
}

// City datasets have varied casing over the years; find fields case-insensitively.
function fieldFinder(record) {
  const keys = Object.keys(record);
  return (...candidates) => {
    for (const c of candidates) {
      const k = keys.find((k) => k.toLowerCase() === c.toLowerCase());
      if (k !== undefined) return record[k];
    }
    return undefined;
  };
}

const dayOf = (v) => String(v ?? "").slice(0, 10); // "YYYY-MM-DD"

function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function geometricMean(values) {
  if (values.length === 0) return null;
  // E. coli of 0 breaks a geomean; treat as 1 (detection floor) like the city does.
  const logs = values.map((v) => Math.log(Math.max(v, 1)));
  return Math.round(Math.exp(logs.reduce((a, b) => a + b, 0) / logs.length));
}

// Water quality rows are one per sampling site per day; the city's standard
// is the geometric mean across a beach's sites. Returns per-slug history.
function summarizeWaterQuality(records) {
  const byBeachDay = new Map(); // slug -> Map(day -> number[])
  for (const rec of records) {
    const f = fieldFinder(rec);
    const beach = beachForCityName(f("beachName", "beach_name", "beach"));
    if (!beach) continue;
    const day = dayOf(f("collectionDate", "collection_date", "sampleDate", "sample_date"));
    const eColi = toNumber(f("eColi", "e_coli", "ecoli"));
    if (!day || eColi === null) continue;
    if (!byBeachDay.has(beach.slug)) byBeachDay.set(beach.slug, new Map());
    const days = byBeachDay.get(beach.slug);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(eColi);
  }

  const out = {};
  for (const [slug, days] of byBeachDay) {
    const history = [...days.entries()]
      .map(([date, samples]) => ({ date, eColi: geometricMean(samples) }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, HISTORY_DAYS);
    const latest = history[0];
    out[slug] = { eColi: latest.eColi, sampleDate: latest.date, history };
  }
  return out;
}

// Observations are one row per beach per day, recorded by city staff.
function summarizeObservations(records) {
  const out = {};
  for (const rec of records) {
    const f = fieldFinder(rec);
    const beach = beachForCityName(f("beachName", "beach_name", "beach"));
    if (!beach) continue;
    const day = dayOf(f("dataCollectionDate", "data_collection_date", "collectionDate", "date"));
    if (!day) continue;
    const existing = out[beach.slug];
    if (existing && existing.date >= day) continue; // keep the newest row only
    out[beach.slug] = {
      date: day,
      waterTemp: toNumber(f("waterTemp", "water_temp", "waterTemperature")),
      airTemp: toNumber(f("airTemp", "air_temp", "airTemperature")),
      windSpeed: toNumber(f("windSpeed", "wind_speed")),
      windDirection: f("windDirection", "wind_direction") ?? null,
      waveAction: f("waveAction", "wave_action") ?? null,
      waterClarity: f("waterClarity", "water_clarity") ?? null,
    };
  }
  return out;
}

const [liveResults, ckanWaterQuality, observations] = await Promise.all([
  fetchLiveResults().then(summarizeLiveResults).catch((e) => {
    console.error("live beach_results failed:", e.message);
    return {};
  }),
  fetchDatastore(WATER_QUALITY_PACKAGE, "water-quality.json")
    .then((r) => summarizeWaterQuality(r.records))
    .catch((e) => {
      console.error("CKAN water quality failed:", e.message);
      return {};
    }),
  fetchDatastore(OBSERVATIONS_PACKAGE, "observations.json").then((r) =>
    summarizeObservations(r.records)
  ),
]);

const buoys = await fetchBuoyTemps();
const lakeBuoy = await fetchLakeBuoy().catch((e) => {
  console.error("NDBC 45159 lake buoy failed:", e.message);
  return null;
});
const rain48h = await fetchRain48h().catch((e) => {
  console.error("Open-Meteo rain history failed:", e.message);
  return {};
});

// Live feed wins per beach; the CKAN dataset (a season behind) is the fallback.
const waterQuality = { ...ckanWaterQuality, ...liveResults };

const conditions = {
  fetchedAt: new Date().toISOString(),
  sources: {
    liveResults: LIVE_RESULTS,
    waterQuality: `https://open.toronto.ca/dataset/${WATER_QUALITY_PACKAGE}/`,
    observations: `https://open.toronto.ca/dataset/${OBSERVATIONS_PACKAGE}/`,
    buoys: OWD,
    lakeBuoy: "https://www.ndbc.noaa.gov/station_page.php?station=45159",
    rain: "https://open-meteo.com/",
  },
  lakeBuoy,
  beaches: Object.fromEntries(
    BEACHES.map((b) => [
      b.slug,
      {
        name: b.name,
        waterQuality: waterQuality[b.slug] ?? null,
        observations: observations[b.slug] ?? null,
        buoy: buoys[b.slug] ?? null,
        rain48hMm: rain48h[b.slug] ?? null,
      },
    ])
  ),
};

const outPath = path.join(ROOT, "data", "conditions.json");
await writeFile(outPath, JSON.stringify(conditions, null, 2) + "\n");

const withData = Object.values(conditions.beaches).filter((b) => b.waterQuality).length;
console.log(`wrote ${path.relative(ROOT, outPath)} — ${withData}/${BEACHES.length} beaches have water quality data`);
if (!USE_FIXTURES && withData === 0) {
  process.exit(1); // fail the CI run rather than commit an empty file
}
