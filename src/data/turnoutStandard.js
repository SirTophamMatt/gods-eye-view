/**
 * Turnout under the Service Delivery Standard — the half `code1Response.js`
 * deliberately left out.
 *
 * That module models the DRIVE and says, in as many words, that turnout is
 * often the larger half and that inventing a figure for it would be worse than
 * naming the brigade type. That reasoning stands for a *measured* turnout: the
 * spread on what a volunteer brigade actually achieves is enormous, and no
 * average describes a particular Tuesday at 3am.
 *
 * This module is not that number. It is the STANDARD — the time the service
 * plans against — which is a published, fixed quantity rather than an
 * estimate, and which is exactly what an incident timeline needs on its left
 * half. "The standard says this appliance should be rolling by T+4:00" is a
 * statement about policy, and it is true whether or not the brigade made it.
 * Nothing here predicts a brigade's actual turnout, and the copy must not
 * present it as one.
 *
 * THE THREE FIGURES.
 *
 *   FRV — 90 seconds. Career, permanently staffed, crew already on station.
 *   Corroborated by the State Road Rescue Arrangements' 1.5-minute standard
 *   for paid on-station crews.
 *
 *   CFA in Districts 7, 8, 13 and 14 — 4 minutes. The outer-metropolitan
 *   districts around Melbourne that are not FRV: dense, close to members'
 *   homes, and standing to a tighter figure than the rest of the state.
 *
 *   CFA elsewhere — 8 minutes. Members travel to the station before the
 *   appliance moves. Corroborated by the same State Road Rescue Arrangements
 *   figure of 8 minutes for volunteers.
 *
 * The 4-minute metro-district figure is operator-supplied and is the one
 * number here with no public citation behind it; the district LIST it applies
 * to is the load-bearing part and is stated, not inferred.
 *
 * WHICH DISTRICT is the station's, not the incident's. A brigade turns out
 * from its own station under its own district's standard, and near a district
 * boundary the two genuinely differ.
 *
 * Kept free of Vite-only `?url` imports so it stays loadable under Node — the
 * asset lives in `brigadeResponse.js`, matching how `stationAgency.js` is
 * wired for the same reason.
 */

import { nameAtPoint, parseNamedPolygonFeatures } from './pointInPolygon.js';

/** FRV career turnout standard, seconds. */
export const SDS_FRV_S = 90;
/** CFA outer-metro district turnout standard, seconds. */
export const SDS_CFA_METRO_S = 240;
/** CFA turnout standard everywhere else, seconds. */
export const SDS_CFA_RURAL_S = 480;

/**
 * The CFA districts that stand to the 4-minute figure — outer metropolitan
 * Melbourne, outside the FRV response area.
 */
export const CFA_METRO_DISTRICTS = Object.freeze([7, 8, 13, 14]);

const METRO_SET = new Set(CFA_METRO_DISTRICTS);

/**
 * The district number out of a Vicmap district name.
 *
 * Vicmap writes them as "CFA District 7". Parsed rather than matched whole so
 * a cosmetic upstream rename ("CFA District 07", "District 7") still resolves;
 * the number is the identity here, not the string.
 *
 * @param {string} name Vicmap `name` property.
 * @returns {number|null} District number, or null when there is none.
 */
export function cfaDistrictNumber(name) {
  const match = /(\d+)/.exec(String(name ?? ''));
  if (!match) return null;
  const number = Number.parseInt(match[1], 10);
  return Number.isFinite(number) ? number : null;
}

/**
 * Build a memoized loader for the CFA district polygons, keeping their names.
 *
 * Failures are not cached, for the reason `createFrvAreaLoader` gives: a
 * transient chunk error would otherwise pin every CFA station at the rural
 * 8-minute figure for the rest of the session. That is a WRONG answer rather
 * than a missing one, and wrong in the direction that overstates turnout.
 *
 * @param {string} url Bundled snapshot URL.
 * @returns {function(typeof fetch=): Promise<{name: string, rings: number[][][]}[]>} Loader.
 */
export function createCfaDistrictLoader(url) {
  let pending = null;
  let districts = null;

  return function loadCfaDistricts(fetchImpl = globalThis.fetch) {
    if (districts) return Promise.resolve(districts);
    if (pending) return pending;

    pending = (async () => {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`HTTP ${response.status ?? '?'}`);
      const parsed = parseNamedPolygonFeatures(await response.text());
      if (parsed.length === 0) throw new Error('CFA district set is empty');
      districts = parsed;
      return parsed;
    })();

    pending = pending.finally(() => {
      if (!districts) pending = null;
    });

    return pending;
  };
}

/**
 * The turnout standard for one station.
 *
 * Returns a null `seconds` rather than a default whenever the standard is not
 * knowable — an interstate brigade under another service's arrangements, an
 * unclassified station, or a CFA station whose district did not resolve. The
 * timeline draws those with no SDS block at all, which reads as "not known"
 * instead of quietly charging them the rural figure.
 *
 * @param {{agency?: string, latitude: number, longitude: number}} station Station.
 * @param {{name: string, rings: number[][][]}[]} [districts] CFA district parts.
 * @returns {{seconds: number|null, basis: string|null, districtNumber: number|null, label: string}}
 */
export function sdsForStation(station, districts) {
  const agency = String(station?.agency ?? '');

  if (agency === 'frv') {
    return {
      seconds: SDS_FRV_S,
      basis: 'frv-career',
      districtNumber: null,
      label: 'FRV career standard',
    };
  }

  if (agency !== 'cfa') {
    // NSW, SA, or unclassified. Neither figure applies and neither is claimed.
    return { seconds: null, basis: null, districtNumber: null, label: '' };
  }

  const districtName = nameAtPoint(
    Number(station?.longitude),
    Number(station?.latitude),
    districts,
  );
  const districtNumber = cfaDistrictNumber(districtName);

  if (districtNumber === null) {
    return { seconds: null, basis: null, districtNumber: null, label: 'CFA district unresolved' };
  }

  const metro = METRO_SET.has(districtNumber);
  return {
    seconds: metro ? SDS_CFA_METRO_S : SDS_CFA_RURAL_S,
    basis: metro ? 'cfa-metro' : 'cfa-rural',
    districtNumber,
    label: `CFA D${districtNumber} ${metro ? 'metro' : 'rural'} standard`,
  };
}

/**
 * Annotate stations with their turnout standard.
 *
 * Best-effort in the same shape as `withAgency`: a loader failure leaves every
 * station's `sds` null rather than throwing, so the timeline degrades to
 * travel-only instead of the whole action failing.
 *
 * @param {object[]} stations Stations carrying `agency` and a position.
 * @param {function(typeof fetch=): Promise<object[]>} loadDistricts Loader.
 * @param {typeof fetch} [fetchImpl] Test seam.
 * @returns {Promise<object[]>} The same stations, each with an `sds` record.
 */
export async function withTurnoutStandard(stations, loadDistricts, fetchImpl = globalThis.fetch) {
  let districts = null;
  try {
    districts = await loadDistricts(fetchImpl);
  } catch {
    districts = null;
  }
  return stations.map((station) => ({ ...station, sds: sdsForStation(station, districts) }));
}

/**
 * Duration as a response clock — "1:30", "8:00", "12:04".
 *
 * Minutes and seconds, not `formatMinutes`' rounded minutes: the whole point
 * of the SDS block is that 90 seconds and 4 minutes are different-sized
 * things, and rounding both to whole minutes hides the smaller one.
 *
 * @param {number} seconds Duration.
 * @returns {string} Clock string, or '' when there is no duration.
 */
export function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}
