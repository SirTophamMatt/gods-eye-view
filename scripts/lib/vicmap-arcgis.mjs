/**
 * Shared client for the State of Victoria's public ArcGIS FeatureServers.
 *
 * Both Vicmap exporters — `export-vicmap-admin.mjs` (boundaries) and
 * `export-vicmap-emergency.mjs` (fire stations) — read from the same ArcGIS
 * organisation, and the awkward parts of talking to it are identical: pages
 * that terminate on a flag rather than a count, failures that arrive as HTTP
 * 200 with an `error` body, and cold requests that stall long past any
 * reasonable timeout. That is enough shared behaviour to be worth one
 * implementation; when the service changes, one place changes.
 *
 * This module is deliberately transport only. What a layer MEANS — its
 * attributes, its label, its priority — belongs to the exporter that owns it.
 */

/** Server's own ceiling is 2000, but a generalised 2000-feature page times out. */
export const PAGE_SIZE = 500;

/**
 * Generalising a dissolved region boundary is genuinely expensive upstream —
 * a warm request for the CFA districts takes ~27 s — and a cold one sometimes
 * stalls well past that. Long timeout, and retry rather than fail the run:
 * this is a public service with no SLA, and losing a whole export to one cold
 * cache means re-fetching every layer that already worked.
 */
export const REQUEST_TIMEOUT_MS = 180_000;
export const REQUEST_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = 5_000;

/** Coordinate decimals kept on the wire. 5 dp ≈ 1 m — finer than any tolerance. */
export const COORD_DECIMALS = 5;

/**
 * Round one coordinate pair; drops the z ArcGIS sometimes appends.
 * @param {number[]} point `[lon, lat]`, possibly with a third element.
 * @returns {number[]} `[lon, lat]` rounded to COORD_DECIMALS.
 */
export function roundPoint(point) {
  return [
    Number(Number(point[0]).toFixed(COORD_DECIMALS)),
    Number(Number(point[1]).toFixed(COORD_DECIMALS)),
  ];
}

/**
 * One page of a layer's features as GeoJSON, with bounded retries.
 *
 * @param {object} options
 * @param {string} options.service FeatureServer base URL.
 * @param {number} options.layer FeatureServer layer id.
 * @param {number} options.offset Result offset.
 * @param {string} [options.where] Attribute filter (default: everything).
 * @param {number} [options.tolerance] `maxAllowableOffset` in degrees; 0 disables.
 * @param {number} [options.pageSize] Records per request.
 * @param {function(string):void} [options.onRetry] Called with the retry reason.
 * @returns {Promise<object>} Parsed FeatureCollection.
 */
export async function fetchArcgisPage({
  service,
  layer,
  offset,
  where = '1=1',
  tolerance = 0,
  pageSize = PAGE_SIZE,
  onRetry = () => {},
}) {
  const params = new URLSearchParams({
    where,
    outFields: '*',
    outSR: '4326',
    returnGeometry: 'true',
    resultOffset: String(offset),
    resultRecordCount: String(pageSize),
    f: 'geojson',
  });
  // Offset 0 means "no generalisation" to ArcGIS, so omit it rather than
  // sending a value the server would silently treat as full resolution.
  if (tolerance > 0) params.set('maxAllowableOffset', String(tolerance));

  const url = `${service}/${layer}/query?${params}`;
  let lastError = null;
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      // ArcGIS reports failure with HTTP 200 and an `error` object, so a status
      // check alone would hand an empty FeatureCollection to the writer and
      // silently truncate the layer.
      if (body?.error) {
        const detail = body.error.details?.join('; ') || body.error.message || 'unknown';
        throw new Error(`ArcGIS ${body.error.code}: ${detail}`);
      }
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < REQUEST_ATTEMPTS) {
        onRetry(`retry ${attempt}/${REQUEST_ATTEMPTS - 1} after ${error.message}`);
        await new Promise((done) => { setTimeout(done, RETRY_BACKOFF_MS * attempt); });
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * Every feature of a layer, paged until the server stops saying there is more.
 * Takes the same options as `fetchArcgisPage` minus `offset`.
 * @param {object} options
 * @returns {Promise<object[]>} GeoJSON features.
 */
export async function fetchArcgisLayer(options) {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const features = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchArcgisPage({ ...options, offset, pageSize });
    const batch = Array.isArray(page?.features) ? page.features : [];
    features.push(...batch);
    // `exceededTransferLimit` rides on `properties` for f=geojson (it is a
    // top-level flag for f=json), and a short page is the other terminator.
    const more = page?.properties?.exceededTransferLimit === true
      || page?.exceededTransferLimit === true;
    if (!more || batch.length === 0) break;
  }
  return features;
}
