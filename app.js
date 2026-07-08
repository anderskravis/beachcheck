import { BEACHES, DEFAULT_SLUG, beachForSlug } from "./beaches.js";

const $ = (id) => document.getElementById(id);
const E_COLI_LIMIT = 100; // city posts a beach unsafe at ≥100 E. coli / 100 mL
const STALE_DAYS = 5; // older samples mean the beach isn't being monitored

const select = $("beach-select");
for (const b of BEACHES) {
  const opt = document.createElement("option");
  opt.value = b.slug;
  opt.textContent = b.short;
  select.append(opt);
}

const slugFromHash = () => location.hash.replace(/^#/, "");
const currentBeach = () => beachForSlug(slugFromHash()) ?? beachForSlug(DEFAULT_SLUG);

select.addEventListener("change", () => { location.hash = select.value; });
addEventListener("hashchange", render);

const conditionsPromise = fetch("data/conditions.json").then((r) => {
  if (!r.ok) throw new Error(`conditions.json ${r.status}`);
  return r.json();
});

const compass = (deg) =>
  ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];

function parseDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function daysAgo(day) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
  return Math.round((parseDay(today) - parseDay(day)) / 86400000);
}

const shortDate = (day) =>
  parseDay(day).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });

async function fetchWeather(beach) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${beach.lat}&longitude=${beach.lon}` +
    `&current=temperature_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m` +
    `&wind_speed_unit=kn&timezone=America%2FToronto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`open-meteo ${r.status}`);
  return (await r.json()).current;
}

async function fetchWaves(beach) {
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${beach.lat}&longitude=${beach.lon}` +
    `&current=wave_height&timezone=America%2FToronto`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const height = (await r.json()).current?.wave_height;
  return typeof height === "number" ? height : null;
}

function renderStatus(wq) {
  const el = $("status");
  const word = $("status-word");
  const detail = $("status-detail");
  if (!wq || daysAgo(wq.sampleDate) > STALE_DAYS) {
    el.className = "status neutral";
    word.textContent = "no data";
    detail.textContent = wq
      ? `last sample ${shortDate(wq.sampleDate)} — beach not currently monitored`
      : "beach not currently monitored (sampling runs June–September)";
    return;
  }
  const safe = wq.eColi < E_COLI_LIMIT;
  el.className = `status ${safe ? "good" : "bad"}`;
  word.textContent = safe ? "swim" : "no swim";
  detail.textContent = `E. coli ${wq.eColi} of ${E_COLI_LIMIT} limit · sampled ${shortDate(wq.sampleDate)}`;
}

function paddleNote(windKn, gustsKn) {
  if (windKn == null) return "";
  if (windKn < 8) return "Light wind — easy paddling.";
  if (windKn < 14) return "Some chop — fine if you're steady on the board.";
  if (windKn < 20) return "Windy — expect real chop, short outings only.";
  return `Blowing ${Math.round(windKn)} kn — not a paddle day.`;
}

async function render() {
  const beach = currentBeach();
  select.value = beach.slug;
  document.title = `${beach.short} · beachcheck`;
  $("beach-name").textContent = beach.short;

  const conditions = await conditionsPromise.catch(() => null);
  const data = conditions?.beaches?.[beach.slug];
  const obs = data?.observations;

  renderStatus(data?.waterQuality ?? null);

  const obsFresh = obs && daysAgo(obs.date) <= STALE_DAYS;
  $("water-temp").innerHTML = obsFresh && obs.waterTemp != null
    ? `${obs.waterTemp}° <small>${shortDate(obs.date)}</small>`
    : "—";

  $("app").hidden = false;
  $("loading").hidden = true;

  const fetched = conditions ? new Date(conditions.fetchedAt) : null;
  $("updated").textContent = fetched
    ? `City data fetched ${fetched.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })} · wind is live`
    : "City data unavailable · wind is live";

  // Live weather fills in after the city data paints.
  const [weather, waveHeight] = await Promise.all([
    fetchWeather(beach).catch(() => null),
    fetchWaves(beach).catch(() => null),
  ]);
  if (beach.slug !== currentBeach().slug) return; // user switched beaches mid-fetch

  if (weather) {
    const arrow = `<span class="arrow" style="transform: rotate(${Math.round(weather.wind_direction_10m) + 180}deg)">↑</span>`;
    $("wind").innerHTML =
      `${Math.round(weather.wind_speed_10m)} kn ${compass(weather.wind_direction_10m)} ${arrow} ` +
      `<small>gusts ${Math.round(weather.wind_gusts_10m)}</small>`;
    $("air-temp").textContent = `${Math.round(weather.temperature_2m)}°`;
    $("paddle-note").textContent = paddleNote(weather.wind_speed_10m, weather.wind_gusts_10m);
  } else {
    $("wind").textContent = obsFresh && obs.windSpeed != null
      ? `${obs.windSpeed} km/h ${obs.windDirection ?? ""}`
      : "—";
    $("air-temp").textContent = obsFresh && obs.airTemp != null ? `${obs.airTemp}°` : "—";
  }

  const wavePieces = [];
  if (waveHeight != null) wavePieces.push(`${waveHeight.toFixed(1)} m`);
  if (obsFresh && obs.waveAction) wavePieces.push(obs.waveAction);
  $("waves").textContent = wavePieces.length ? wavePieces.join(" · ") : "—";
}

render();
