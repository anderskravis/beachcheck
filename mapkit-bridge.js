// Bridges the Apple MapKit JS SDK (loaded via the script tag in index.html)
// to the rest of the app. Kept separate from app.js so it can be dynamically
// imported from window.initMapKit — see index.html for why that matters.
import { BEACHES, DEFAULT_SLUG, beachForSlug } from "./beaches.js";

let map = null;
let pin = null;

const SPAN = { lat: 0.05, lon: 0.07 }; // roughly a 5-6 km view around the beach

function currentBeachFromHash() {
  return beachForSlug(location.hash.replace(/^#/, "")) ?? beachForSlug(DEFAULT_SLUG);
}

// The sheet covers the lower part of the screen (and its own height varies —
// see app.js's expand/collapse), so centering the region ON the beach
// coordinate would put the pin right underneath it. Shift the region's
// center south of the beach so the beach itself lands in whatever strip is
// actually visible above the sheet, read live off the DOM.
function regionFor(beach) {
  const sheetTop = document.querySelector(".sheet")?.getBoundingClientRect().top;
  const visibleFraction = sheetTop ? sheetTop / window.innerHeight : 0.4;
  const targetFraction = Math.max(0.06, Math.min(0.45, visibleFraction / 2));
  const centerLat = beach.lat - SPAN.lat * (0.5 - targetFraction);
  return new mapkit.CoordinateRegion(
    new mapkit.Coordinate(centerLat, beach.lon),
    new mapkit.CoordinateSpan(SPAN.lat, SPAN.lon)
  );
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
    instance.region = regionFor(initial);
    map = instance;
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
    map.setRegionAnimated(regionFor(beach), true);
  } catch (e) {
    console.error("mapkit center failed:", e);
  }
}
