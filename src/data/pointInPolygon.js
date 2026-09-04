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
 * Read the feature list out of a bundled snapshot.
 *
 * Reads the same two wire formats the local-layer loader sniffs (JSON Lines
 * and a FeatureCollection) and skips a malformed row rather than throwing.
 * Shared by both parsers below so the sniffing lives in one place.
 *
 * @param {string} text Raw snapshot body.
 * @returns {object[]} GeoJSON features.
 */
function readFeatures(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && Array.isArray(parsed.features)) return parsed.features;
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Expected for JSON Lines.
  }

  const features = [];
  for (const line of trimmed.split('\n')) {
    if (!line.trim()) continue;
    try {
      features.push(JSON.parse(line));
    } catch {
      // Skip the row, keep the rest.
    }
  }
  return features;
}

/** Every polygon part of one feature, as `[outer, ...holes]` rings. */
function featureParts(feature) {
  const geometry = feature?.geometry;
  if (geometry?.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
    return [geometry.coordinates];
  }
  if (geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }
  return [];
}

/**
 * Parse a bundled snapshot into polygon ring arrays.
 *
 * MultiPolygons are flattened into their parts. Use this when the only
 * question is inside-or-outside; `parseNamedPolygonFeatures` keeps the
 * property that says WHICH region was hit.
 *
 * @param {string} text Raw snapshot body.
 * @returns {number[][][][]} Polygons, each `[outer, ...holes]`.
 */
export function parsePolygonFeatures(text) {
  const polygons = [];
  for (const feature of readFeatures(text)) {
    for (const part of featureParts(feature)) polygons.push(part);
  }
  return polygons;
}

/**
 * Parse a snapshot keeping each part's name, for "which region is this in?".
 *
 * The plain parser above throws the properties away, which is right for a
 * single-region boundary like the FRV response area and useless for a
 * partitioned one like the 21 CFA districts — there the answer IS the name.
 *
 * Parts are kept separate rather than grouped by name: a multipart district
 * tests the same either way, and flattening keeps the hit test a single loop.
 *
 * @param {string} text Raw snapshot body.
 * @param {function(object): string} [nameOf] Reads the name from properties.
 * @returns {{name: string, rings: number[][][]}[]} Named polygon parts.
 */
export function parseNamedPolygonFeatures(text, nameOf = (props) => props?.name) {
  const named = [];
  for (const feature of readFeatures(text)) {
    const name = String(nameOf(feature?.properties || {}) ?? '').trim();
    if (!name) continue;
    for (const rings of featureParts(feature)) named.push({ name, rings });
  }
  return named;
}

/**
 * The name of the first named polygon containing a point, honouring holes.
 *
 * @param {number} lon Test longitude.
 * @param {number} lat Test latitude.
 * @param {{name: string, rings: number[][][]}[]} named Named polygon parts.
 * @returns {string|null} The region name, or null when the point is in none.
 */
export function nameAtPoint(lon, lat, named) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Array.isArray(named)) return null;
  for (const entry of named) {
    if (pointInPolygons(lon, lat, [entry?.rings])) return entry.name;
  }
  return null;
}
