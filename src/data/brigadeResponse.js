import { findNearestFireStations } from './fireStationLookup.js';
import { code1Duration } from './code1Response.js';
import { createFrvAreaLoader, withAgency } from './stationAgency.js';
import frvResponseUrl from './local_data/vicmap-admin/vicmap-frv-response.geojsonl?url';

/** One memoized FRV-boundary load for the session. */
const loadFrvArea = createFrvAreaLoader(frvResponseUrl);

/**
 * Assemble the nearest-brigades answer: which stations, whose they are, and
 * how long an appliance takes to reach the incident under priority.
 *
 * Three sources, each degrading on its own so a partial failure still leaves a
 * usable answer:
 *
 *   stations   the bundled gazetteer — REQUIRED. Without it there is no answer
 *              at all, so a failure here throws and the panel says so.
 *   agency     the FRV response-area boundary. Optional: a missing badge costs
 *              context, not the answer.
 *   route      the /api/route proxy, per station. Optional: without it a
 *              station keeps its straight-line distance and simply carries no
 *              travel time, which is honest — we would otherwise be quoting a
 *              drive time computed from a line through paddocks.
 *
 * The ranking stays straight-line even though road distances get fetched. It
 * is what is always available, it is what 1,726 candidates can be sorted by
 * without routing any of them, and re-sorting the three afterwards would make
 * the list disagree with the count that produced it. The road figures are
 * shown, not ranked on — and they routinely disagree with the air ordering,
 * which is the useful part.
 */

/** How many route lookups one action is allowed to make. */
const MAX_ROUTE_REQUESTS = 3;

/**
 * Road route between two points via the app's proxy.
 * @param {{latitude: number, longitude: number}} from Origin.
 * @param {{latitude: number, longitude: number}} to Destination.
 * @param {typeof fetch} fetchImpl Test seam.
 * @returns {Promise<object|null>} Route payload, or null when unavailable.
 */
async function fetchRoute(from, to, fetchImpl) {
  const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  try {
    const response = await fetchImpl(`/api/route?profile=car&coords=${encodeURIComponent(coords)}`);
    if (!response.ok) return null;
    const body = await response.json();
    // The proxy answers failures with HTTP 200 and `ok: false`, so the status
    // alone would let an error body through as a route.
    return body?.ok === true ? body : null;
  } catch {
    return null;
  }
}

/**
 * The nearest brigades to an incident, with agency and Code 1 travel time.
 *
 * @param {{latitude: number, longitude: number}} origin Incident position.
 * @param {number} [count=3] How many stations.
 * @param {typeof fetch} [fetchImpl] Test seam.
 * @returns {Promise<object[]>} Stations with `distanceKm`, `agency`,
 *   and — where routing resolved — `roadDistanceM`, `code1S`, `code1Basis`.
 */
export async function nearestBrigades(origin, count = 3, fetchImpl = globalThis.fetch) {
  const nearest = await findNearestFireStations(origin, count, fetchImpl);
  if (nearest.length === 0) return [];

  const withBadges = await withAgency(nearest, loadFrvArea, fetchImpl);

  // Parallel, and bounded by the caller's count — the proxy rate-limits at 60
  // requests a minute and a runaway here would spend that budget on one click.
  const routed = await Promise.all(
    withBadges.slice(0, MAX_ROUTE_REQUESTS).map(async (station) => {
      const route = await fetchRoute(origin, station, fetchImpl);
      if (!route) return station;
      const code1 = code1Duration(route);
      return {
        ...station,
        roadDistanceM: Number.isFinite(route.distanceM) ? route.distanceM : null,
        code1S: code1?.durationS ?? null,
        code1Basis: code1?.basis ?? null,
      };
    }),
  );

  return routed.concat(withBadges.slice(MAX_ROUTE_REQUESTS));
}
