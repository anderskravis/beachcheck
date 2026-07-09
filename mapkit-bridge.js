// Bridges the Apple MapKit JS SDK (loaded via the script tag in index.html)
// to the rest of the app. Kept separate from app.js so it can be dynamically
// imported from window.initMapKit — see index.html for why that matters.
import { BEACHES, DEFAULT_SLUG, beachForSlug } from "./beaches.js";

let map = null;
let pin = null;

const SPAN = { lat: 0.05, lon: 0.07 }; // roughly a 5-6 km view around the beach

// Every beach dot's DOM element, keyed by slug, so setBeachStatuses can
// recolor them once water quality data loads (which happens on its own
// schedule, independent of — and usually slower than — MapKit itself).
const dotEls = new Map();
let pendingStatuses = null;

const STATUS_COLORS = { safe: "#0a7aff", caution: "#ff9500", unsafe: "#eb4034" };

// Called from app.js once conditions.json resolves — a subtle color hint
// per beach dot (blue/yellow/red) instead of a flat neutral color, using
// the same "safe"/"caution"/"unsafe"/null classification as the status
// card. Safe to call before start() has run; applies once dots exist.
export function setBeachStatuses(statuses) {
  pendingStatuses = statuses;
  applyPendingStatuses();
}

function applyPendingStatuses() {
  if (!pendingStatuses) return;
  for (const [slug, el] of dotEls) {
    const color = STATUS_COLORS[pendingStatuses[slug]];
    if (color) el.style.setProperty("--dot-status", color);
    else el.style.removeProperty("--dot-status");
  }
}

// The selected beach gets its own larger "pin" annotation at the same
// coordinate as its regular dot — without this, both render on top of
// each other, showing as the color dot poking out from behind/beside the
// pin's ring instead of one clean marker.
function updateDotVisibility(beach) {
  for (const [slug, el] of dotEls) {
    el.style.visibility = slug === beach.slug ? "hidden" : "visible";
  }
}

// Below this width, use a fixed offset from the header instead of trying
// to read the sheet's position at all — the sheet's height is CSS `dvh`,
// which on real phones (not desktop, not emulated mobile) can still be
// settling from Safari's dynamic toolbar at the moment this runs, making
// its measured position unreliable. A flat "just below the header"
// target sidesteps that dependency entirely on narrow viewports, where
// it's mattered in practice; wide/desktop keeps the sheet-aware version,
// which already looks right there.
const NARROW_VIEWPORT_PX = 700;
const NARROW_TARGET_VH = 0.05; // how far below the header, as a fraction of viewport height

function currentBeachFromHash() {
  return beachForSlug(location.hash.replace(/^#/, "")) ?? beachForSlug(DEFAULT_SLUG);
}

// Where the beach should land on screen (page/client px — equivalent here
// since .map-band is a fixed, unscrolled full-viewport layer): a fixed
// distance below the header on narrow viewports (ignoring the sheet
// entirely — its dvh-driven position proved unreliable to read on real
// phones), or centered within the strip actually visible between the
// header and the sheet on wide viewports, where the sheet's position is
// trustworthy.
function targetScreenY() {
  const headerBottom = document.querySelector(".map-band header")?.getBoundingClientRect().bottom ?? 60;
  if (window.innerWidth < NARROW_VIEWPORT_PX) {
    return headerBottom + window.innerHeight * NARROW_TARGET_VH;
  }
  const sheetTop = document.querySelector(".sheet")?.getBoundingClientRect().top ?? window.innerHeight * 0.4;
  const visibleTop = headerBottom + 12;
  const visibleBottom = Math.max(sheetTop, visibleTop + 20);
  return visibleTop + (visibleBottom - visibleTop) * 0.56;
}

// A same-span region dead-centered exactly on the beach — the simplest
// possible region, and also the reference frame exactRegionFor uses below.
function centeredRegionFor(beach) {
  return new mapkit.CoordinateRegion(
    new mapkit.Coordinate(beach.lat, beach.lon),
    new mapkit.CoordinateSpan(SPAN.lat, SPAN.lon)
  );
}

// Shifting the center by a fraction of SPAN.lat assumes a simple linear
// relationship between "fraction of screen height" and "fraction of the
// region's latitude span" — that held up fine against this file's own
// hand-drawn SVG fallback (a simple equirectangular projection we fully
// control), but not against real MapKit on an actual phone: MapKit fits a
// region to the container using its own projection, which doesn't
// preserve that relationship, especially on a tall/narrow screen with a
// roughly-square span like this one. Used only if the exact method below
// is ever unavailable.
function approximateRegionFor(beach) {
  const targetFraction = Math.max(0.04, Math.min(0.45, targetScreenY() / window.innerHeight));
  const centerLat = beach.lat - SPAN.lat * (0.5 - targetFraction);
  return new mapkit.CoordinateRegion(
    new mapkit.Coordinate(centerLat, beach.lon),
    new mapkit.CoordinateSpan(SPAN.lat, SPAN.lon)
  );
}

// Asks MapKit itself where things render instead of guessing: center
// exactly on the beach, read back the page point that coordinate actually
// lands on, then solve for whatever center coordinate would put it at the
// real target point instead. Exact regardless of aspect ratio or
// projection quirks, since it's driven by MapKit's own conversion rather
// than an assumed degrees-per-pixel relationship.
//
// The point conversion calls need a real, live region on the map to
// measure against, so this temporarily sets one — but always restores
// whatever the map's region was beforehand. Skipping that restore was a
// real bug: the caller typically does map.setRegionAnimated(result, true)
// right after this returns, which animates FROM whatever the map's
// current region happens to be — leaving it parked on the temporary
// beach-centered reference frame made every call visibly jump there
// first, then animate to the real target. A visible glitch on every
// single call, not just repeated ones.
function exactRegionFor(beach) {
  const targetY = targetScreenY();
  const previousRegion = map.region;
  try {
    map.region = centeredRegionFor(beach);
    const rect = document.getElementById("mapkit-map").getBoundingClientRect();
    const centerPt = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const solveAt = new DOMPoint(centerPt.x, 2 * centerPt.y - targetY);
    const newCenter = map.convertPointOnPageToCoordinate(solveAt);
    return new mapkit.CoordinateRegion(newCenter, new mapkit.CoordinateSpan(SPAN.lat, SPAN.lon));
  } catch (e) {
    console.error("exact region calc failed, falling back to approximate centering:", e);
    return approximateRegionFor(beach);
  } finally {
    if (previousRegion) map.region = previousRegion;
  }
}

// Dark map at night, light muted map by day — tied to actual Toronto time,
// not the visitor's system theme (the sheet below handles that separately).
// Exported so app.js can tint Safari's own chrome (status bar/toolbar) to
// roughly match whichever map tone is actually showing behind it.
export function isNightInToronto() {
  const hour = Number(
    new Intl.DateTimeFormat("en-CA", { hour: "numeric", hour12: false, timeZone: "America/Toronto" })
      .format(new Date())
  );
  return hour < 6 || hour >= 20;
}

// Called by window.initMapKit once the SDK has authorized and loaded.
export function start(mapkitGlobal) {
  try {
    const instance = new mapkitGlobal.Map("mapkit-map", {
      colorScheme: isNightInToronto() ? "dark" : "light",
      mapType: mapkitGlobal.Map.MapTypes.MutedStandard,
      showsCompass: mapkitGlobal.FeatureVisibility.Hidden,
      showsScale: mapkitGlobal.FeatureVisibility.Hidden,
      showsZoomControl: false,
      showsMapTypeControl: false,
      showsUserLocationControl: false,
      isRotationEnabled: false,
      isScrollEnabled: true,
      isZoomEnabled: true,
    });

    instance.addAnnotations(
      BEACHES.map(
        (b) =>
          new mapkitGlobal.Annotation(new mapkitGlobal.Coordinate(b.lat, b.lon), () => {
            const el = document.createElement("div");
            el.className = "mk-dot";
            el.title = b.short;
            el.addEventListener("click", () => { location.hash = b.slug; });
            dotEls.set(b.slug, el);
            return el;
          })
      )
    );
    applyPendingStatuses();

    const initial = currentBeachFromHash();
    pin = new mapkitGlobal.Annotation(
      new mapkitGlobal.Coordinate(initial.lat, initial.lon),
      () => {
        const el = document.createElement("div");
        el.className = "mk-pin";
        return el;
      }
    );
    instance.addAnnotation(pin);
    // exactRegionFor reads/writes the module-level `map` variable (it needs
    // to set a reference region on it before asking it to convert points),
    // so this has to be assigned before the first call, not after.
    map = instance;
    instance.region = exactRegionFor(initial);
    updateDotVisibility(initial);
    document.getElementById("map-band").classList.add("mapkit-ready");
    document.getElementById("mapkit-map").classList.add("ready");
  } catch (e) {
    console.error("mapkit init failed:", e);
  }
}

// Called on every render(); a no-op until start() has succeeded.
export function centerMapKitOn(beach) {
  if (!map || !pin) return;
  try {
    pin.coordinate = new mapkit.Coordinate(beach.lat, beach.lon);
    updateDotVisibility(beach);
    map.setRegionAnimated(exactRegionFor(beach), true);
  } catch (e) {
    console.error("mapkit center failed:", e);
  }
}
