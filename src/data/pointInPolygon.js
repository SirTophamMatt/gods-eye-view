/**
 * Point-in-polygon over bundled GeoJSON, with holes.
 *
 * Kept free of Vite-only imports and of Cesium so it is testable on its own.
 * `neighborhoodPolygons.js` carries its own copy of the ray cast for the
 * annotation resolver's offline lookup; that one is entangled with per-city
 * lazy loading and name aliasing, so this is a clean separate implementation
 * rather than an extraction that would have to serve both.
 */

/**
 * Ray-casting point-in-ring. `ring` is `[[lon, lat], …]`.
 *
 * The half-open `(yi > lat) !== (yj > lat)` comparison is what keeps a point
 * exactly level with a shared vertex from being counted twice — the classic
 * failure that reports a point outside a polygon it sits inside.
 *
 * @param {number} lon Test longitude.
 * @param {number} lat Test latitude.
 * @param {number[][]} ring Closed or unclosed ring.
 * @returns {boolean} True when the point is inside the ring.
 */
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = ((yi > lat) !== (yj > lat))
      && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Whether a point falls inside any polygon, honouring holes.
 *
 * A point inside an outer ring but also inside one of that polygon's holes is
 * OUTSIDE it — an enclave cut out of the region really is not part of it.
 *
 * @param {number} lon Test longitude.
 * @param {number} lat Test latitude.
 * @param {number[][][][]} polygons Array of polygons, each `[outer, ...holes]`.
 * @returns {boolean} True when the point is inside one of them.
 */
export function pointInPolygons(lon, lat, polygons) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Array.isArray(polygons)) return false;
  for (const rings of polygons) {
    const outer = rings?.[0];
    if (!Array.isArray(outer) || outer.length < 3) continue;
    if (!pointInRing(lon, lat, outer)) continue;
    let inHole = false;
    for (let h = 1; h < rings.length; h += 1) {
      if (pointInRing(lon, lat, rings[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

/**
 * Parse a bundled snapshot into polygon ring arrays.
 *
 * Reads the same two wire formats the local-layer loader sniffs (JSON Lines
 * and a FeatureCollection) and skips a malformed row rather than throwing.
 * MultiPolygons are flattened into their parts.
 *
 * @param {string} text Raw snapshot body.
 * @returns {number[][][][]} Polygons, each `[outer, ...holes]`.
 */
export function parsePolygonFeatures(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  let features = null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && Array.isArray(parsed.features)) features = parsed.features;
    else if (Array.isArray(parsed)) features = parsed;
  } catch {
    // Expected for JSON Lines.
  }
  if (!features) {
    features = [];
    for (const line of trimmed.split('\n')) {
      if (!line.trim()) continue;
      try {
        features.push(JSON.parse(line));
      } catch {
        // Skip the row, keep the rest.
      }
    }
  }

  const polygons = [];
  for (const feature of features) {
    const geometry = feature?.geometry;
    if (geometry?.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
      polygons.push(geometry.coordinates);
    } else if (geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
      for (const part of geometry.coordinates) polygons.push(part);
    }
  }
  return polygons;
}
