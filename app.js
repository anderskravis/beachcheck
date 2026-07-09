import { BEACHES, DEFAULT_SLUG, beachForSlug, SHORELINE, ISLANDS, SPIT } from "./beaches.js";
import { centerMapKitOn } from "./mapkit-bridge.js";

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

/* ---------- the map ---------- */

// Simple equirectangular projection scaled to ~17 px/km around Toronto.
const LON0 = -79.66;
const LAT0 = 43.85;
const PX_PER_KM = 17;
const KMX = 111.32 * Math.cos((43.7 * Math.PI) / 180);
const projX = (lon) => (lon - LON0) * KMX * PX_PER_KM;
const projY = (lat) => (LAT0 - lat) * 111.32 * PX_PER_KM;
const ZOOM = 2.1;

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

// Where (in viewport px from the top) a pin should land so it's not hidden
// behind the sheet — roughly centered in whatever map area is still visible
// above it. Read live off the DOM since the sheet's own height changes
// (see the expand/collapse listener below), not assumed from CSS constants.
function visiblePinTargetY() {
  const sheetTop = document.querySelector(".sheet")?.getBoundingClientRect().top;
  return sheetTop ? Math.max(60, sheetTop / 2) : 180;
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

// Scrolling/swiping down on the sheet — even before its content is tall
// enough to actually overflow — expands it toward full height, same as
// Apple Maps' place-card; the reverse gesture at the top of the content
// collapses it back. A plain "scroll" listener alone isn't enough: when
// collapsed content is short enough to fit, there's nothing to scroll, so
// it would never fire. Wheel/touch deltas catch the gesture either way.
{
  const sheetEl = document.querySelector(".sheet");
  const sheetInner = document.querySelector(".sheet-inner");
  const expand = () => sheetEl.classList.add("expanded");
  const collapseIfAtTop = () => {
    if (sheetInner.scrollTop === 0) sheetEl.classList.remove("expanded");
  };

  sheetInner.addEventListener(
    "scroll",
    () => { if (sheetInner.scrollTop > 0) expand(); },
    { passive: true }
  );
  sheetEl.addEventListener(
    "wheel",
    (e) => (e.deltaY > 0 ? expand() : e.deltaY < 0 && collapseIfAtTop()),
    { passive: true }
  );
  let touchStartY = null;
  sheetEl.addEventListener("touchstart", (e) => { touchStartY = e.touches[0].clientY; }, { passive: true });
  sheetEl.addEventListener(
    "touchmove",
    (e) => {
      if (touchStartY == null) return;
      const dy = touchStartY - e.touches[0].clientY; // positive: finger moved up
      if (dy > 8) expand();
      else if (dy < -8) collapseIfAtTop();
    },
    { passive: true }
  );

  // Re-center whichever map is showing once the resize finishes, since the
  // visible area above the sheet just changed.
  sheetEl.addEventListener("transitionend", (e) => {
    if (e.propertyName !== "top") return;
    const beach = currentBeach();
    centerMapOn(beach);
    centerMapKitOn(beach);
  });
}

// A static dvh/rem guess for the collapsed sheet height doesn't hold up
// across real devices (Safari's dynamic chrome, notches, etc.) — on at
// least one real iPhone it left the wind/air cards cut off. Instead,
// measure how tall the content actually is and set the collapsed `top`
// so it just fits, clamped so there's always some map visible above it
// and it never grows absurdly tall on short-content states.
const grabberEl = document.querySelector(".grabber");
const sheetElForHeight = document.querySelector(".sheet");
const sheetInnerForHeight = document.querySelector(".sheet-inner");

function tuneCollapsedHeight() {
  if (sheetElForHeight.classList.contains("expanded")) return; // don't fight the user's own expand
  const bottomGapPx = 20; // matches .sheet's `bottom: 1.25rem`
  // scrollHeight already includes sheet-inner's own top+bottom padding, so
  // don't add it again. The footer (source credits etc.) is deliberately
  // left below the fold in the collapsed state — otherwise, on a tall
  // enough viewport, every field fits and there's nothing left to reveal
  // by scrolling/expanding.
  const footerEl = sheetInnerForHeight.querySelector("footer");
  const footerHeight = footerEl ? footerEl.offsetHeight : 0;
  const essentialContentHeight = sheetInnerForHeight.scrollHeight - footerHeight;
  const neededSheetHeight = grabberEl.offsetHeight + essentialContentHeight;
  const needed = window.innerHeight - neededSheetHeight - bottomGapPx;
  const minTop = window.innerHeight * 0.14;
  const maxTop = window.innerHeight * 0.6;
  const top = Math.max(minTop, Math.min(maxTop, needed));
  sheetElForHeight.style.setProperty("--collapsed-top", `${Math.round(top)}px`);
}

window.addEventListener("resize", tuneCollapsedHeight);

/* ---------- status + stats ---------- */

// Returns whether the water is safe to swim in (true/false), or null when
// there's no current reading — callers use this to keep the paddle note
// from contradicting a "no swim" call.
function renderStatus(wq) {
  const card = $("status");
  const word = $("status-word");
  const detail = $("status-detail");
  if (!wq || daysAgo(wq.sampleDate) > STALE_DAYS) {
    card.className = "stat status-card";
    word.textContent = "no data";
    detail.textContent = wq
      ? `last sample ${shortDate(wq.sampleDate)} — beach not currently monitored`
      : "beach not currently monitored (sampling runs June–September)";
    return null;
  }
  // The city's posted status is authoritative when present (it can flag a
  // beach unsafe preemptively); the E. coli threshold is the fallback.
  const safe = wq.statusFlag ? wq.statusFlag === "SAFE" : wq.eColi < E_COLI_LIMIT;
  card.className = `stat status-card ${safe ? "good" : "bad"}`;
  word.textContent = safe ? "swim" : "no swim";
  detail.textContent = `E. coli ${wq.eColi} of ${E_COLI_LIMIT} limit · sampled ${shortDate(wq.sampleDate)}`;
  return safe;
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
// safe is renderStatus()'s swim call (true/false/null) — a "no swim" day
// should never be topped off with an upbeat paddling verdict.
function conditionsNote(waveWord, waterTempC, windKn, safe) {
  if (safe === false) {
    return waveWord
      ? `${capitalize(waveWord)}, but water quality is unsafe today — best to stay out.`
      : "Water quality is unsafe today — best to stay out.";
  }
  const temp = bandLabel(TEMP_BANDS, waterTempC);
  const clauses = [];
  if (waveWord) clauses.push(capitalize(waveWord));
  if (temp) clauses.push(`water's ${temp}`);
  if (!clauses.length) return "";
  const verdict = bandLabel(VERDICT_BANDS, windKn);
  return verdict ? `${clauses.join(", ")} — ${verdict}.` : `${clauses.join(", ")}.`;
}

async function render() {
  const beach = currentBeach();
  select.value = beach.slug;
  document.title = `${beach.short} · BeachCheck`;
  $("beach-name").textContent = beach.short;
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
    $("water-temp").innerHTML = `${buoy.waterTemp}° <small>buoy · ${when}</small>`;
  } else if (obsFresh && obs.waterTemp != null) {
    waterTempC = obs.waterTemp;
    $("water-temp").innerHTML = `${obs.waterTemp}° <small>${shortDate(obs.date)}</small>`;
  } else {
    $("water-temp").textContent = "—";
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
    $("air-temp").textContent = `${Math.round(weather.temperature_2m)}°`;
  } else {
    if (obsFresh && obs.windSpeed != null) windKn = obs.windSpeed * 0.539957; // km/h -> kn
    $("wind").textContent = obsFresh && obs.windSpeed != null
      ? `${obs.windSpeed} km/h ${obs.windDirection ?? ""}`
      : "—";
    $("air-temp").textContent = obsFresh && obs.airTemp != null ? `${obs.airTemp}°` : "—";
  }

  // Real buoy height wins; then the city's own (rarely fresh) observation;
  // then a wind-derived estimate; "—" if none of that is available.
  const lakeBuoy = conditions?.lakeBuoy;
  const cityWave = obsFresh ? obs.waveAction : null;
  let waveWord;
  if (lakeBuoy?.waveHeightM != null) {
    waveWord = waveStateFromHeight(lakeBuoy.waveHeightM);
    const hoursAgo = Math.round((Date.now() - new Date(lakeBuoy.time)) / 3600000);
    const when = hoursAgo < 1 ? "now" : `${hoursAgo}h ago`;
    $("waves").innerHTML = `${waveWord} <small>${lakeBuoy.waveHeightM.toFixed(1)} m · buoy ${when}</small>`;
  } else if (cityWave) {
    waveWord = cityWave;
    $("waves").textContent = cityWave;
  } else {
    waveWord = waveState(windKn);
    $("waves").innerHTML = waveWord ? `${waveWord} <small>estimated from wind</small>` : "—";
  }
  $("paddle-note").textContent = conditionsNote(waveWord, waterTempC, windKn, safeToSwim);
  tuneCollapsedHeight();
}

async function fetchWeather(beach) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${beach.lat}&longitude=${beach.lon}` +
    `&current=temperature_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m` +
    `&wind_speed_unit=kn&timezone=America%2FToronto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`open-meteo ${r.status}`);
  return (await r.json()).current;
}

render();
