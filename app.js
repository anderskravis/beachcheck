import { BEACHES, DEFAULT_SLUG, beachForSlug, SHORELINE, ISLANDS, SPIT } from "./beaches.js";
import { centerMapKitOn, isNightInToronto, setBeachStatuses } from "./mapkit-bridge.js";

const $ = (id) => document.getElementById(id);

// Safari tints its own status bar/toolbar to this color — match whichever
// map tone (day/night) is actually showing behind it instead of leaving a
// mismatched dark bar over a light map at noon.
$("theme-color-meta")?.setAttribute("content", isNightInToronto() ? "#0b0d10" : "#aab7c2");
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

const aboutDialog = $("about-dialog");
$("about-btn").addEventListener("click", () => aboutDialog.showModal());

// "Canadian Measurement Mode" — water temp in Fahrenheit (how it actually
// gets talked about at the beach), air stays in Celsius (how the weather
// gets talked about). Persisted as a cookie per the original ask, not
// localStorage.
function getCookie(name) {
  return document.cookie.split("; ").find((row) => row.startsWith(`${name}=`))?.split("=")[1];
}
function setCookie(name, value, days) {
  document.cookie = `${name}=${value}; max-age=${days * 86400}; path=/; SameSite=Lax`;
}
let canadianMode = getCookie("canadianMode") === "1";
const canadianModeToggle = $("canadian-mode-toggle");
canadianModeToggle.checked = canadianMode;
canadianModeToggle.addEventListener("change", () => {
  canadianMode = canadianModeToggle.checked;
  setCookie("canadianMode", canadianMode ? "1" : "0", 365);
  render();
});
const formatWaterTemp = (c) => (canadianMode ? `${Math.round((c * 9) / 5 + 32)}°F` : `${c}°`);

$("share-btn").addEventListener("click", async (e) => {
  const beach = currentBeach();
  const word = $("status-word").textContent.trim();
  const note = $("paddle-note").textContent.trim();
  const text = [word && `${word}.`, note].filter(Boolean).join(" ");
  const shareData = { title: `BeachCheck · ${beach.short}`, text, url: location.href };
  if (navigator.share) {
    try { await navigator.share(shareData); } catch { /* user cancelled */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(`${shareData.title} — ${text} ${shareData.url}`);
    const btn = e.currentTarget;
    const original = btn.textContent;
    btn.classList.remove("confirm");
    void btn.offsetWidth; // restart the animation if clicked again quickly
    btn.classList.add("confirm");
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch { /* clipboard unavailable; nothing more to do */ }
});

const conditionsPromise = fetch("data/conditions.json").then((r) => {
  if (!r.ok) throw new Error(`conditions.json ${r.status}`);
  return r.json();
});

// Once conditions.json resolves, give every beach dot on the map — not
// just the currently selected one — a subtle color hint (blue/yellow/red)
// using the same classification as the status card, instead of a flat
// neutral dot for all of them.
const DOT_STATUS_COLORS = { safe: "#0a7aff", caution: "#f2b90f", unsafe: "#eb4034" };
conditionsPromise.then((conditions) => {
  const statuses = {};
  for (const b of BEACHES) {
    statuses[b.slug] = beachStatus(conditions?.beaches?.[b.slug]?.waterQuality ?? null);
  }
  for (const dot of $("dots").children) {
    const color = DOT_STATUS_COLORS[statuses[dot.dataset.slug]];
    if (color) dot.style.setProperty("--dot-status", color);
    else dot.style.removeProperty("--dot-status");
  }
  setBeachStatuses(statuses);
}).catch(() => { /* dots just keep their neutral color if this fails */ });

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

/* ---------- the map ---------- */

// Simple equirectangular projection scaled to ~17 px/km around Toronto.
const LON0 = -79.66;
const LAT0 = 43.85;
const PX_PER_KM = 17;
const KMX = 111.32 * Math.cos((43.7 * Math.PI) / 180);
const projX = (lon) => (lon - LON0) * KMX * PX_PER_KM;
const projY = (lat) => (LAT0 - lat) * 111.32 * PX_PER_KM;
const ZOOM = 2.1;

// Below this width, use a fixed offset from the header instead of trying
// to read the sheet's position at all — the sheet's height is CSS `dvh`,
// which on real phones (not desktop, not emulated mobile) can still be
// settling from Safari's dynamic toolbar at the moment this runs, making
// its measured position unreliable. A flat "just below the header" target
// sidesteps that dependency entirely on narrow viewports, where it's
// mattered in practice; wide/desktop keeps the sheet-aware version, which
// already looks right there. Shared with the same constants in
// mapkit-bridge.js.
const NARROW_VIEWPORT_PX = 700;
const NARROW_TARGET_VH = 0.05; // how far below the header, as a fraction of viewport height

function polyPath(points, close) {
  const d = points
    .map(([lon, lat], i) => `${i ? "L" : "M"}${projX(lon).toFixed(1)},${projY(lat).toFixed(1)}`)
    .join(" ");
  return close ? `${d} Z` : d;
}

function buildMap() {
  // Land: the shoreline, closed off well above the top of the view.
  const first = SHORELINE[0];
  const last = SHORELINE[SHORELINE.length - 1];
  $("land").setAttribute(
    "d",
    `${polyPath(SHORELINE, false)} L${projX(last[0]).toFixed(1)},-400 L${projX(first[0]).toFixed(1)},-400 Z`
  );
  $("islands").setAttribute("d", polyPath(ISLANDS, true));
  $("spit").setAttribute("d", polyPath(SPIT, true));

  const label = $("lake-label");
  label.setAttribute("x", projX(-79.47));
  label.setAttribute("y", projY(43.594));

  const dots = $("dots");
  for (const b of BEACHES) {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", projX(b.lon).toFixed(1));
    dot.setAttribute("cy", projY(b.lat).toFixed(1));
    dot.setAttribute("r", "3");
    dot.dataset.slug = b.slug;
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = b.short;
    dot.append(title);
    dot.addEventListener("click", () => { location.hash = b.slug; });
    dots.append(dot);
  }
}

// Where a pin should land — in the SVG's own viewBox units (0-500 tall),
// not screen pixels — so it's not hidden behind the sheet OR the header.
// On narrow viewports this is a fixed distance below the header, ignoring
// the sheet entirely (see NARROW_VIEWPORT_PX above); on wide viewports
// it's centered within the strip actually visible between the header and
// the sheet. #world's translate below is a CSS transform on an SVG
// element, which resolves in the SVG's user-space (viewBox) units, not
// physical viewport pixels — mixing the two was an earlier bug. Read live
// off the DOM since the sheet's own height changes continuously (see the
// parallax listener below), not assumed from CSS constants.
function visiblePinTargetY() {
  const headerBottom = document.querySelector(".map-band header")?.getBoundingClientRect().bottom ?? 60;
  let fraction;
  if (window.innerWidth < NARROW_VIEWPORT_PX) {
    const targetY = headerBottom + window.innerHeight * NARROW_TARGET_VH;
    fraction = Math.max(0.04, Math.min(0.18, targetY / window.innerHeight));
  } else {
    const sheetTop = document.querySelector(".sheet")?.getBoundingClientRect().top ?? window.innerHeight * 0.4;
    const visibleTop = headerBottom + 12;
    const visibleBottom = Math.max(sheetTop, visibleTop + 20);
    const targetY = visibleTop + (visibleBottom - visibleTop) * 0.56;
    fraction = Math.max(0.08, Math.min(0.45, targetY / window.innerHeight));
  }
  return fraction * 500; // 500 = the #map viewBox height
}

// Pan the world so the beach sits within the map area the sheet isn't covering.
function centerMapOn(beach) {
  const x = projX(beach.lon);
  const y = projY(beach.lat);
  const targetY = visiblePinTargetY();
  $("world").style.transform =
    `translate(${(400 - ZOOM * x).toFixed(1)}px, ${(targetY - ZOOM * y).toFixed(1)}px) scale(${ZOOM})`;
  $("pin").setAttribute("transform", `translate(${x.toFixed(1)}, ${y.toFixed(1)})`);
  for (const dot of $("dots").children) {
    dot.style.opacity = dot.dataset.slug === beach.slug ? "0" : "1";
  }
}

buildMap();

// Give real Apple Maps a few seconds before falling back to the hand-drawn
// map, so a slow/blocked/expired MapKit load doesn't flash the fallback on
// every visit — it should only appear when it's actually needed.
setTimeout(() => $("map-band").classList.add("show-fallback"), 2500);

// The sheet's resting position is pure CSS (see .sheet's `top`, a
// clamp() on dvh) — no JS measures content or resizes it after load, so
// there's no post-load jump. Scrolling the sheet's own content instead
// pulls the sheet taller continuously, in step with the scroll offset —
// a parallax follow rather than a snap between two fixed states. Once
// scrolled past SCROLL_RANGE_PX the sheet is at its full height and
// further scrolling just scrolls the remaining content (footer etc.)
// normally.
{
  const sheetEl = document.querySelector(".sheet");
  const sheetInner = document.querySelector(".sheet-inner");
  const SCROLL_RANGE_PX = 160;

  const collapsedTopPx = () => {
    const vh = window.innerHeight;
    const guess = vh - 34 * 16;
    return Math.min(Math.max(guess, vh * 0.10), vh * 0.46);
  };
  const expandedTopPx = () => Math.max(window.innerHeight * 0.18, 7 * 16);

  let ticking = false;
  function updateParallax() {
    ticking = false;
    const t = Math.min(1, Math.max(0, sheetInner.scrollTop / SCROLL_RANGE_PX));
    const top = collapsedTopPx() + (expandedTopPx() - collapsedTopPx()) * t;
    sheetEl.style.top = `${Math.round(top)}px`;
  }

  let recenterTimer = null;
  sheetInner.addEventListener(
    "scroll",
    () => {
      if (!ticking) { ticking = true; requestAnimationFrame(updateParallax); }
      // On narrow viewports the pin's target no longer depends on the
      // sheet's position at all (see NARROW_VIEWPORT_PX above), so
      // there's nothing to re-center here — doing it anyway just
      // produced visible jitter as the map briefly re-centers on itself
      // for no visual change. Wide viewports still genuinely need this,
      // since their target is the sheet-relative strip midpoint.
      if (window.innerWidth < NARROW_VIEWPORT_PX) return;
      // Re-centering the map on every scroll frame would be janky and
      // wasteful; wait until scrolling settles instead.
      clearTimeout(recenterTimer);
      recenterTimer = setTimeout(() => {
        const beach = currentBeach();
        centerMapOn(beach);
        centerMapKitOn(beach);
      }, 180);
    },
    { passive: true }
  );

  window.addEventListener("resize", () => {
    if (sheetInner.scrollTop === 0) sheetEl.style.top = "";
    else updateParallax();
    if (window.innerWidth < NARROW_VIEWPORT_PX) return;
    const beach = currentBeach();
    centerMapOn(beach);
    centerMapKitOn(beach);
  });
}

/* ---------- status + stats ---------- */

const E_COLI_CAUTION = 70; // getting close to the posting limit — not unsafe yet, but worth a heads up

// Pure classification, shared between the status card (current beach) and
// the map dots (every beach at once): "safe", "caution", "unsafe", or null
// when there's no current reading. The city's posted status is
// authoritative when present (it can flag a beach unsafe preemptively);
// the E. coli threshold is the fallback. "Caution" only applies within an
// otherwise-safe reading — a beach the city has actually posted unsafe is
// never softened to caution.
function beachStatus(wq) {
  if (!wq || daysAgo(wq.sampleDate) > STALE_DAYS) return null;
  const unsafe = wq.statusFlag ? wq.statusFlag !== "SAFE" : wq.eColi >= E_COLI_LIMIT;
  const caution = !unsafe && wq.eColi >= E_COLI_CAUTION;
  return unsafe ? "unsafe" : caution ? "caution" : "safe";
}

// Renders the status card for the current beach — callers use the return
// value to keep the paddle note from contradicting a "no swim" call (and
// to soften it, rather than contradict it, on a "caution" day).
function renderStatus(wq) {
  const card = $("status");
  const word = $("status-word");
  const detail = $("status-detail");
  const status = beachStatus(wq);
  if (status === null) {
    card.className = "stat status-card";
    word.textContent = "no data";
    detail.textContent = wq
      ? `last sample ${shortDate(wq.sampleDate)} — beach not currently monitored`
      : "beach not currently monitored (sampling runs June–September)";
    return null;
  }
  card.className = `stat status-card ${status === "unsafe" ? "bad" : status === "caution" ? "caution" : "good"}`;
  word.textContent = status === "unsafe" ? "no swim" : status === "caution" ? "caution" : "swim";
  detail.textContent = `E. coli ${wq.eColi} of ${E_COLI_LIMIT} limit · sampled ${shortDate(wq.sampleDate)}`;
  return status;
}

// Real wave height from NW Lake Ontario buoy 45159 wins when fresh; the
// city's own wave-action observation is next; failing both, waves are
// estimated from wind — Open-Meteo's marine API has no real Great Lakes
// coverage (it was returning a flat, fake 0.0 m everywhere).
const WAVE_HEIGHT_BANDS = [
  { max: 0.15, label: "flat" },
  { max: 0.3, label: "light ripples" },
  { max: 0.6, label: "light chop" },
  { max: 1.0, label: "choppy" },
  { max: Infinity, label: "rough" },
];
const WAVE_BANDS = [
  { max: 6, label: "flat" },
  { max: 10, label: "light ripples" },
  { max: 15, label: "light chop" },
  { max: 20, label: "choppy" },
  { max: Infinity, label: "whitecaps" },
];
const TEMP_BANDS = [
  { max: 14, label: "frigid" },
  { max: 18, label: "brisk" },
  { max: 22, label: "refreshing" },
  { max: 26, label: "pleasant" },
  { max: Infinity, label: "bathwater warm" },
];
const VERDICT_BANDS = [
  { max: 8, label: "ideal for a long paddle" },
  { max: 14, label: "easy paddling" },
  { max: 20, label: "fine if you're steady on the board" },
  { max: 28, label: "short outings only" },
  { max: Infinity, label: "not a paddle day" },
];
const bandLabel = (bands, value) => (value == null ? null : bands.find((b) => value < b.max).label);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const waveStateFromHeight = (m) => bandLabel(WAVE_HEIGHT_BANDS, m);
const waveState = (windKn) => bandLabel(WAVE_BANDS, windKn);

// A single playful line combining wave state, water temp and a paddle verdict.
// waveWord is whatever the caller already decided is the best available
// wave descriptor (real buoy height, city observation, or wind estimate).
// status is renderStatus()'s return value ("safe"/"caution"/"unsafe"/null)
// — a "no swim" day should never be topped off with an upbeat paddling
// verdict, and a "caution" day gets a gentle heads-up instead of either.
function conditionsNote(waveWord, waterTempC, windKn, status) {
  if (status === "unsafe") {
    return waveWord
      ? `${capitalize(waveWord)}, but water quality is unsafe today — best to stay out.`
      : "Water quality is unsafe today — best to stay out.";
  }
  const temp = bandLabel(TEMP_BANDS, waterTempC);
  const clauses = [];
  if (waveWord) clauses.push(capitalize(waveWord));
  if (temp) clauses.push(`water's ${temp}`);
  let note = "";
  if (clauses.length) {
    const verdict = bandLabel(VERDICT_BANDS, windKn);
    note = verdict ? `${clauses.join(", ")} — ${verdict}.` : `${clauses.join(", ")}.`;
  }
  if (status === "caution") {
    const headsUp = "Water quality is borderline today — worth checking before you go.";
    note = note ? `${note} ${headsUp}` : headsUp;
  }
  return note;
}

async function render() {
  const beach = currentBeach();
  select.value = beach.slug;
  document.title = `${beach.short} · BeachCheck`;
  $("beach-name").textContent = beach.short;
  // Switching beaches resets the sheet to its resting position, so the
  // map centering below is against a known, settled sheet height rather
  // than whatever scroll position the previous beach was left at.
  document.querySelector(".sheet-inner").scrollTop = 0;
  document.querySelector(".sheet").style.top = "";
  centerMapOn(beach); // hand-drawn fallback, always kept in sync underneath
  centerMapKitOn(beach); // real Apple Maps, once (if) it has loaded

  const conditions = await conditionsPromise.catch(() => null);
  const data = conditions?.beaches?.[beach.slug];
  const obs = data?.observations;

  const safeToSwim = renderStatus(data?.waterQuality ?? null);

  const obsFresh = obs && daysAgo(obs.date) <= STALE_DAYS;
  const buoy = data?.buoy;
  let waterTempC = null;
  if (buoy?.waterTemp != null) {
    waterTempC = buoy.waterTemp;
    const hoursAgo = Math.round((Date.now() - new Date(buoy.time)) / 3600000);
    const when = hoursAgo < 1 ? "now" : `${hoursAgo}h ago`;
    $("water-temp").innerHTML = `${formatWaterTemp(buoy.waterTemp)} <small>buoy · ${when}</small>`;
  } else if (obsFresh && obs.waterTemp != null) {
    waterTempC = obs.waterTemp;
    $("water-temp").innerHTML = `${formatWaterTemp(obs.waterTemp)} <small>${shortDate(obs.date)}</small>`;
  } else {
    $("water-temp").textContent = "—";
  }

  // Real buoy height wins; then the city's own (rarely fresh) observation —
  // neither needs the wind-derived estimate below, so render them now
  // rather than waiting on the weather fetch for no reason (that gap was
  // part of the "empty card" flash on load: waves rarely actually depends
  // on wind, but was being held hostage behind it).
  const lakeBuoy = conditions?.lakeBuoy;
  const cityWave = obsFresh ? obs.waveAction : null;
  let waveWord = null;
  if (lakeBuoy?.waveHeightM != null) {
    waveWord = waveStateFromHeight(lakeBuoy.waveHeightM);
    const hoursAgo = Math.round((Date.now() - new Date(lakeBuoy.time)) / 3600000);
    const when = hoursAgo < 1 ? "now" : `${hoursAgo}h ago`;
    $("waves").innerHTML = `${waveWord} <small>${lakeBuoy.waveHeightM.toFixed(1)} m · buoy ${when}</small>`;
  } else if (cityWave) {
    waveWord = cityWave;
    $("waves").textContent = cityWave;
  }

  $("app").hidden = false;
  $("loading").hidden = true;

  const fetched = conditions ? new Date(conditions.fetchedAt) : null;
  $("updated").textContent = fetched
    ? `City data fetched ${fetched.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })} · wind is live`
    : "City data unavailable · wind is live";

  // Live weather fills in after the city data paints.
  const weather = await fetchWeather(beach).catch(() => null);
  if (beach.slug !== currentBeach().slug) return; // user switched beaches mid-fetch

  let windKn = null;
  if (weather) {
    windKn = weather.wind_speed_10m;
    const arrow = `<span class="arrow" style="transform: rotate(${Math.round(weather.wind_direction_10m)}deg)">↑</span>`;
    $("wind").innerHTML =
      `${Math.round(weather.wind_speed_10m)} kn ${compass(weather.wind_direction_10m)} ${arrow} ` +
      `<small>gusts ${Math.round(weather.wind_gusts_10m)}</small>`;
    const condition = weatherLabel(weather.weather_code);
    $("air-temp").innerHTML = condition
      ? `${Math.round(weather.temperature_2m)}° <small>${condition}</small>`
      : `${Math.round(weather.temperature_2m)}°`;
  } else {
    if (obsFresh && obs.windSpeed != null) windKn = obs.windSpeed * 0.539957; // km/h -> kn
    $("wind").textContent = obsFresh && obs.windSpeed != null
      ? `${obs.windSpeed} km/h ${obs.windDirection ?? ""}`
      : "—";
    $("air-temp").textContent = obsFresh && obs.airTemp != null ? `${obs.airTemp}°` : "—";
  }

  // Only the wind-derived estimate genuinely needs to wait this long —
  // buoy/city-observation waves were already rendered above.
  if (waveWord == null) {
    waveWord = waveState(windKn);
    $("waves").innerHTML = waveWord ? `${waveWord} <small>estimated from wind</small>` : "—";
  }
  $("paddle-note").textContent = conditionsNote(waveWord, waterTempC, windKn, safeToSwim);
}

// WMO weather codes (Open-Meteo's `weather_code` field) collapsed down to
// short, human labels for the Air tile's subtext — same "one word" spirit
// as the wave/paddle-note phrasing elsewhere.
const WEATHER_CODES = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "foggy", 48: "foggy",
  51: "drizzly", 53: "drizzly", 55: "drizzly", 56: "freezing drizzle", 57: "freezing drizzle",
  61: "rainy", 63: "rainy", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "snowy", 73: "snowy", 75: "heavy snow", 77: "snow grains",
  80: "showers", 81: "showers", 82: "heavy showers",
  85: "snow showers", 86: "snow showers",
  95: "thunderstorms", 96: "thunderstorms", 99: "thunderstorms",
};
const weatherLabel = (code) => WEATHER_CODES[code] ?? null;

async function fetchWeather(beach) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${beach.lat}&longitude=${beach.lon}` +
    `&current=temperature_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code` +
    `&wind_speed_unit=kn&timezone=America%2FToronto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`open-meteo ${r.status}`);
  return (await r.json()).current;
}

render();
