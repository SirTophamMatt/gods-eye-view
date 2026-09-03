/**
 * Which service a fire station belongs to, from where it sits.
 *
 * Vicmap's gazetteer does not say. But the FRV Response Area boundary — which
 * this app already ships as a layer — IS that answer geographically: inside it
 * is Fire Rescue Victoria, outside it is CFA country. So the classification is
 * a point-in-polygon test against a file already in the build, not a new
 * dataset and not a guess.
 *
 * WHY IT IS WORTH SHOWING beside a travel time. FRV stations are career and
 * permanently staffed, so the gap between the page and the appliance rolling
 * is about a minute. CFA is overwhelmingly volunteer: members travel to the
 * station before the appliance moves at all, which routinely costs several
 * times what the Code 1 speed model saves on the drive. A reader shown "3 min"
 * with no idea which kind of station it is has been handed the smaller half of
 * the answer without being told.
 *
 * No turnout NUMBER is attached, deliberately — see `code1Response.js`. The
 * spread on the volunteer figure is wide enough that naming the brigade type
 * and letting a reader who knows the district apply their own is the honest
 * move.
 *
 * The boundary is a coarse instrument and the label says so ("likely"). Some
 * CFA brigades are integrated with career staff, and the response area is
 * drawn for response, not for employment. It separates the two regimes well
 * enough to be worth having and not well enough to be asserted.
 *
 * Kept free of Vite-only `?url` imports: the asset lives in
 * `brigadeResponse.js`, which is only ever reached through a dynamic import,
 * so this module (and everything that imports it) stays loadable under Node.
 */

import { parsePolygonFeatures, pointInPolygons } from './pointInPolygon.js';

/**
 * Build a memoized loader for the FRV response-area polygons.
 *
 * Failures are not cached, for the same reason the station lookup does not
 * cache them: a transient chunk error would otherwise label every station CFA
 * for the rest of the session, which is a WRONG answer rather than a missing
 * one — and wrong in the direction that overstates turnout.
 *
 * @param {string} url Bundled snapshot URL.
 * @returns {function(typeof fetch=): Promise<number[][][][]>} Loader.
 */
export function createFrvAreaLoader(url) {
  let pending = null;
  let polygons = null;

  return function loadFrvResponseArea(fetchImpl = globalThis.fetch) {
    if (polygons) return Promise.resolve(polygons);
    if (pending) return pending;

    pending = (async () => {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`HTTP ${response.status ?? '?'}`);
      const parsed = parsePolygonFeatures(await response.text());
      if (parsed.length === 0) throw new Error('FRV response area is empty');
      polygons = parsed;
      return parsed;
    })();

    pending = pending.finally(() => {
      if (!polygons) pending = null;
    });

    return pending;
  };
}

/**
 * Classify one station.
 *
 * The FRV/CFA question only has an answer in Victoria, and a quarter of the
 * gazetteer is not Victorian — Vicmap covers the border overlap, so 334 NSW
 * and 102 SA brigades ride along with the 1,288 VIC ones. Testing those
 * against a Victorian response-area boundary would put every one of them
 * outside it and label a NSW Rural Fire Brigade "CFA", confidently and
 * wrongly. So the state gates the test rather than the geometry deciding it.
 *
 * Interstate stations are kept rather than filtered: cross-border response is
 * real, and near Nelson or Mallacoota the nearest brigade genuinely is over
 * the line. They are named by state and nothing further is asserted about
 * them — SA and NSW run their own services under their own staffing models,
 * and this module has no data on either.
 *
 * @param {{latitude: number, longitude: number, state?: string}} at Station.
 * @param {number[][][][]} polygons FRV response-area rings.
 * @returns {'frv'|'cfa'|'nsw'|'sa'|null} Agency code, null when unknown.
 */
export function agencyAt(at, polygons) {
  const state = String(at?.state ?? '').trim().toUpperCase();
  if (state === 'NSW') return 'nsw';
  if (state === 'SA') return 'sa';
  // An unstated state is treated as Victorian: the gazetteer leaves it null on
  // a couple of records, and both sit well inside the state.
  if (state && state !== 'VIC') return null;
  return pointInPolygons(Number(at?.longitude), Number(at?.latitude), polygons) ? 'frv' : 'cfa';
}

/**
 * Short display label for an agency.
 *
 * "likely" on the CFA side is load-bearing: the boundary is drawn for response
 * rather than employment, and the FRV area takes in the regional integrated
 * stations (Ballarat City, Bendigo, Mildura, Cranbourne) as well as metro
 * Melbourne — 99 stations in all — so the split really does track career
 * staffing, but not perfectly enough to state as fact.
 *
 * @param {'frv'|'cfa'|'nsw'|'sa'|null} agency Agency code.
 * @returns {string} Label, or '' when unknown.
 */
export function agencyLabel(agency) {
  if (agency === 'frv') return 'FRV (career)';
  if (agency === 'cfa') return 'CFA (likely volunteer)';
  if (agency === 'nsw') return 'NSW (interstate)';
  if (agency === 'sa') return 'SA (interstate)';
  return '';
}

/**
 * Bare service code, for surfaces with a hard character budget.
 *
 * The annotation engine clamps a label at 80 characters, and
 * "Hampton Park Satellite Fire Station (Lynbrook)" spends 45 of them before
 * any metrics — the long form truncated mid-word to "CFA (li". The panel,
 * which has room, keeps `agencyLabel` and its qualifiers.
 *
 * @param {'frv'|'cfa'|'nsw'|'sa'|null} agency Agency code.
 * @returns {string} e.g. "CFA", or '' when unknown.
 */
export function agencyShort(agency) {
  if (agency === 'frv') return 'FRV';
  if (agency === 'cfa') return 'CFA';
  if (agency === 'nsw') return 'NSW';
  if (agency === 'sa') return 'SA';
  return '';
}

/**
 * Annotate stations with their agency.
 *
 * Best-effort: a loader failure returns the stations UNLABELLED rather than
 * throwing, because a missing badge costs a reader some context while a failed
 * action costs them the answer.
 *
 * @param {object[]} stations Stations with `latitude`/`longitude`.
 * @param {function(typeof fetch=): Promise<number[][][][]>} loadArea Loader.
 * @param {typeof fetch} [fetchImpl] Test seam.
 * @returns {Promise<object[]>} The same stations, each with `agency` when known.
 */
export async function withAgency(stations, loadArea, fetchImpl = globalThis.fetch) {
  let polygons;
  try {
    polygons = await loadArea(fetchImpl);
  } catch {
    return stations.map((station) => ({ ...station, agency: null }));
  }
  return stations.map((station) => ({ ...station, agency: agencyAt(station, polygons) }));
}
