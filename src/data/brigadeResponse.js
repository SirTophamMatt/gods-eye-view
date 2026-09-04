import { findNearestFireStations } from './fireStationLookup.js';
import { code1Duration } from './code1Response.js';
import { createFrvAreaLoader, withAgency } from './stationAgency.js';
import { createCfaDistrictLoader, withTurnoutStandard } from './turnoutStandard.js';
import { pointInPolygons } from './pointInPolygon.js';
import frvResponseUrl from './local_data/vicmap-admin/vicmap-frv-response.geojsonl?url';
import cfaDistrictUrl from './local_data/vicmap-admin/vicmap-cfa-district.geojsonl?url';

/** One memoized FRV-boundary load for the session. */
const loadFrvArea = createFrvAreaLoader(frvResponseUrl);
/** One memoized CFA-district load for the session. */
const loadCfaDistricts = createCfaDistrictLoader(cfaDistrictUrl);

/**
 * Assemble the nearest-brigades answer: which stations, whose they are, how
 * long the standard gives them to turn out, and how long the drive takes.
 *
 * Four sources, each degrading on its own so a partial failure still leaves a
 * usable answer:
 *
 *   stations   the bundled gazetteer — REQUIRED. Without it there is no answer
 *              at all, so a failure here throws and the panel says so.
 *   agency     the FRV response-area boundary. Optional: a missing badge costs
 *              context, not the answer.
 *   districts  the CFA district partition, which sets the turnout standard.
 *              Optional: without it a station keeps its agency badge and the
 *              timeline simply has no SDS block for it.
 *   route      the /api/route proxy, per station. Optional: without it a
 *              station keeps its straight-line distance and simply carries no
 *              travel time, which is honest — we would otherwise be quoting a
 *              drive time computed from a line through paddocks.
 *
 * The ranking stays straight-line even though road distances get fetched. It
 * is what is always available, it is what 1,705 candidates can be sorted by
 * without routing any of them, and re-sorting afterwards would make the list
 * disagree with the count that produced it. The road figures are shown, not
 * ranked on — and they routinely disagree with the air ordering, which is the
 * useful part.
 */

/**
 * How many route lookups one action is allowed to make.
 *
 * Raised from 3 when response sizes arrived: a Make Tankers 25 wants a drive
 * time for all 25 or its timeline is mostly empty bars. The proxy rate-limits
 * at 60 requests a minute per client, so 25 is a third of the budget on one
 * click — which is why it is also the hard ceiling on a plan's station count.
 */
export const MAX_ROUTE_REQUESTS = 25;

/**
 * Routes in flight at once.
 *
 * The proxy forwards to the public FOSSGIS OSRM servers. Twenty-five at once
 * is a burst those are entitled to shed, and the fan-out buys little: the
 * whole set lands in well under a second at four deep, and a shed request
 * costs a whole bar.
 */
const ROUTE_CONCURRENCY = 4;

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
 * Run `worker` over `items` at most `limit` at a time, keeping input order.
 *
 * @param {any[]} items Work items.
 * @param {number} limit Concurrency.
 * @param {function(any, number): Promise<any>} worker Per-item task.
 * @returns {Promise<any[]>} Results, in the order of `items`.
 */
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Whether an incident sits inside the FRV response area.
 *
 * Drives which response vocabulary the panel offers — alarm levels on FRV
 * ground, Make Tankers on CFA ground. Returns null rather than false when the
 * boundary fails to load, because "we do not know" and "it is CFA country" ask
 * for different menus and conflating them would offer a city job a Make
 * Tankers 25.
 *
 * @param {{latitude: number, longitude: number}} origin Incident position.
 * @param {typeof fetch} [fetchImpl] Test seam.
 * @returns {Promise<boolean|null>} Inside, outside, or unknown.
 */
export async function incidentInFrvArea(origin, fetchImpl = globalThis.fetch) {
  try {
    const polygons = await loadFrvArea(fetchImpl);
    return pointInPolygons(Number(origin?.longitude), Number(origin?.latitude), polygons);
  } catch {
    return null;
  }
}

/**
 * The nearest brigades to an incident, with agency, turnout standard, and
 * Code 1 travel time.
 *
 * @param {{latitude: number, longitude: number}} origin Incident position.
 * @param {number} [count=3] How many stations.
 * @param {typeof fetch} [fetchImpl] Test seam.
 * @returns {Promise<object[]>} Stations with `distanceKm`, `agency`, `sds`,
 *   and — where routing resolved — `roadDistanceM`, `code1S`, `code1Basis`.
 */
export async function nearestBrigades(origin, count = 3, fetchImpl = globalThis.fetch) {
  const nearest = await findNearestFireStations(origin, count, fetchImpl);
  if (nearest.length === 0) return [];

  const withBadges = await withAgency(nearest, loadFrvArea, fetchImpl);
  // The standard depends on the agency badge, so this has to follow it.
  const withStandards = await withTurnoutStandard(withBadges, loadCfaDistricts, fetchImpl);

  const routable = withStandards.slice(0, MAX_ROUTE_REQUESTS);
  const routed = await mapWithLimit(routable, ROUTE_CONCURRENCY, async (station) => {
    // Station → incident, which is the direction an appliance actually
    // travels. Not cosmetic: OSRM routes are direction-dependent, so
    // one-way streets, turn restrictions and divided carriageways can give
    // the reverse trip a different path and a different time.
    const route = await fetchRoute(station, origin, fetchImpl);
    if (!route) return station;
    const code1 = code1Duration(route);
    return {
      ...station,
      roadDistanceM: Number.isFinite(route.distanceM) ? route.distanceM : null,
      code1S: code1?.durationS ?? null,
      code1Basis: code1?.basis ?? null,
    };
  });

  return routed.concat(withStandards.slice(MAX_ROUTE_REQUESTS));
}
