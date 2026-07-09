// Bridges the Apple MapKit JS SDK (loaded via the script tag in index.html)
// to the rest of the app. Kept separate from app.js so it can be dynamically
// imported from window.initMapKit — see index.html for why that matters.
import { BEACHES, DEFAULT_SLUG, beachForSlug } from "./beaches.js";

let map = null;
let pin = null;

const SPAN = { lat: 0.05, lon: 0.07 }; // roughly a 5-6 km view around the beach

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
function exactRegionFor(beach) {
  const targetY = targetScreenY();
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
            return el;
          })
      )
    );

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
    document.getElementById("map-band").classList.add("mapkit-ready");
    document.getElementById("mapkit-map").classList.add("ready");

    // The sheet's resting height is CSS `dvh`, which reflects Safari's
    // dynamic toolbar — on a fresh page load that toolbar can still be
    // settling for a moment after this callback fires, so a region
    // computed from .sheet's rect right now can end up based on a
    // not-yet-final layout. Re-assert it a few more times shortly after,
    // against whatever the DOM reports once things have actually
    // settled, rather than trusting this first synchronous read (one
    // delay wasn't always enough on a real device, so this hedges with
    // a few at increasing delays instead of guessing a single number).
    // Re-reads the hash each time rather than closing over `initial`, in
    // case the user has already switched beaches by the time one fires.
    for (const delay of [300, 800, 1500]) {
      setTimeout(() => centerMapKitOn(currentBeachFromHash()), delay);
    }
    // Don't rely solely on app.js's own listener setup/timing — the
    // dynamic toolbar can also change size independently of any scroll
    // gesture, and iOS Safari fires that through visualViewport, not
    // always through plain window resize.
    window.visualViewport?.addEventListener("resize", () => centerMapKitOn(currentBeachFromHash()));
  } catch (e) {
    console.error("mapkit init failed:", e);
  }
}

// Called on every render(); a no-op until start() has succeeded.
export function centerMapKitOn(beach) {
  if (!map || !pin) return;
  try {
    pin.coordinate = new mapkit.Coordinate(beach.lat, beach.lon);
    map.setRegionAnimated(exactRegionFor(beach), true);
  } catch (e) {
    console.error("mapkit center failed:", e);
  }
}
