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

// Dark map at night, light muted map by day — tied to actual Toronto time,
// not the visitor's system theme (the sheet below handles that separately).
function isNightInToronto() {
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
    instance.region = new mapkitGlobal.CoordinateRegion(
      new mapkitGlobal.Coordinate(initial.lat, initial.lon),
      new mapkitGlobal.CoordinateSpan(SPAN.lat, SPAN.lon)
    );

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
    map.setRegionAnimated(
      new mapkit.CoordinateRegion(
        new mapkit.Coordinate(beach.lat, beach.lon),
        new mapkit.CoordinateSpan(SPAN.lat, SPAN.lon)
      ),
      true
    );
  } catch (e) {
    console.error("mapkit center failed:", e);
  }
}
