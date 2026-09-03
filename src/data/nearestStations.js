/**
 * Proximity maths for the "nearest fire stations" action.
 *
 * Kept free of Vite-only imports (no `?url` assets) and of the DOM, so the
 * part that decides WHICH stations get named is unit-testable on its own. The
 * fetching half lives in `fireStationLookup.js`.
 *
 * ON WHAT "NEAREST" MEANS. These are straight-line distances. Two honest
 * limits follow, and both belong in any copy written on top of this:
 *
 *   1. Crow-flies is not drive time. In the Otways or the alpine country the
 *      third-nearest station by air is regularly the first by road.
 *   2. Nearest is not responding. Victoria turns out brigades by response area
 *      and turnout agreement — which is what the CFA district and FRV response
 *      area layers encode — not by proximity. This answers "what is near this
 *      fire", never "who is coming".
 *
 * The distances are still worth showing: on a globe already displaying a fire,
 * "the three nearest stations are 4, 11 and 19 km away" is a real answer to a
 * real question, as long as it is not dressed up as a dispatch.
 */

/** Mean Earth radius (km), the standard spherical approximation. */
const EARTH_RADIUS_KM = 6371.0088;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance between two points, in kilometres.
 *
 * Haversine on a sphere, not an ellipsoid: across a state two degrees of
 * latitude tall the spherical error is well under a percent, which is far
 * smaller than the road-versus-air error already inherent in the answer.
 *
 * @param {number} aLat Latitude of the first point, degrees.
 * @param {number} aLon Longitude of the first point, degrees.
 * @param {number} bLat Latitude of the second point, degrees.
 * @param {number} bLon Longitude of the second point, degrees.
 * @returns {number} Distance in kilometres.
 */
export function haversineKm(aLat, aLon, bLat, bLon) {
  const dLat = toRadians(bLat - aLat);
  const dLon = toRadians(bLon - aLon);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);
  const h = (Math.sin(dLat / 2) ** 2)
    + (Math.cos(lat1) * Math.cos(lat2) * (Math.sin(dLon / 2) ** 2));
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Parse a bundled station snapshot into plain records.
 *
 * Accepts the same two wire formats the local-layer loader sniffs — JSON Lines
 * and a FeatureCollection — so a future live endpoint is a URL swap here too.
 * A malformed line is skipped rather than thrown: one bad row in a gazetteer
 * should cost that row, not the whole action.
 *
 * @param {string} text Raw snapshot body.
 * @returns {{name: string, latitude: number, longitude: number}[]} Stations.
 */
export function parseStations(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  let features = null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && Array.isArray(parsed.features)) features = parsed.features;
    else if (Array.isArray(parsed)) features = parsed;
  } catch {
    // Expected for JSON Lines, which is not one document.
  }
  if (!features) {
    features = [];
    for (const line of trimmed.split('\n')) {
      if (!line.trim()) continue;
      try {
        features.push(JSON.parse(line));
      } catch {
        // Skip the row, keep the layer.
      }
    }
  }

  const stations = [];
  for (const feature of features) {
    const coordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(coordinates)) continue;
    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    const name = String(feature?.properties?.name || '').trim();
    if (!name) continue;
    stations.push({ name, latitude, longitude });
  }
  return stations;
}

/**
 * The `count` stations closest to `origin`, nearest first.
 *
 * A full sort of ~1,700 records is microseconds and is what keeps this
 * readable; a partial-selection algorithm would buy nothing measurable.
 *
 * Ties are broken by name so the same incident always produces the same three
 * stations. Without it two equidistant stations swap places between calls and
 * the panel appears to change its mind on a re-click.
 *
 * @param {{latitude: number, longitude: number}} origin Incident position.
 * @param {{name: string, latitude: number, longitude: number}[]} stations Candidates.
 * @param {number} [count=3] How many to return.
 * @returns {{name: string, latitude: number, longitude: number, distanceKm: number}[]}
 */
export function nearestStations(origin, stations, count = 3) {
  const lat = Number(origin?.latitude);
  const lon = Number(origin?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  if (!Array.isArray(stations) || stations.length === 0) return [];
  const limit = Math.max(0, Math.floor(Number(count) || 0));
  if (limit === 0) return [];

  return stations
    .map((station) => ({
      ...station,
      distanceKm: haversineKm(lat, lon, station.latitude, station.longitude),
    }))
    .sort((a, b) => (a.distanceKm - b.distanceKm) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Distance for display. Sub-10 km gets a decimal because that is the range
 * where the difference between 4.2 and 4.8 km is worth reading; beyond that it
 * is false precision on a straight-line estimate.
 * @param {number} km Distance in kilometres.
 * @returns {string} e.g. "4.2 km", "19 km".
 */
export function formatDistanceKm(km) {
  if (!Number.isFinite(km)) return '';
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}
