import fireStationUrl from './local_data/vicmap-emergency/vicmap-fire-station.geojsonl?url';
import { nearestStations, parseStations } from './nearestStations.js';

/**
 * Station lookup for the detail panel's "nearest brigades" action.
 *
 * Reads the SAME bundled snapshot the `local-vicmap-fire-station` layer draws,
 * but independently of it. Requiring the layer to be switched on first would
 * make the button work or not work depending on unrelated state, and "nothing
 * happened" is the worst possible response to a click on a fire.
 *
 * The whole file is 374 KB and is fetched at most once per session, on the
 * first click rather than at boot — nobody who never asks for a brigade should
 * pay for the gazetteer.
 */

/** @type {Promise<object[]>|null} In-flight or settled successful load. */
let _pending = null;
/** @type {object[]|null} Parsed stations, once. */
let _stations = null;

/**
 * Load and cache the station list.
 *
 * Failures are deliberately NOT cached. A transient chunk-load error would
 * otherwise pin an empty list for the rest of the session, and every later
 * click would report "no stations found" — indistinguishable, to the reader,
 * from a state with no fire stations in it.
 *
 * @param {typeof fetch} [fetchImpl] Test seam.
 * @returns {Promise<{name: string, latitude: number, longitude: number}[]>}
 */
export function loadFireStations(fetchImpl = globalThis.fetch) {
  if (_stations) return Promise.resolve(_stations);
  if (_pending) return _pending;

  _pending = (async () => {
    const response = await fetchImpl(fireStationUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status ?? '?'}`);
    const parsed = parseStations(await response.text());
    if (parsed.length === 0) throw new Error('station snapshot is empty');
    _stations = parsed;
    return parsed;
  })();

  _pending = _pending.finally(() => {
    // Clear the in-flight handle either way; `_stations` is what makes a
    // SUCCESS sticky, so this only un-sticks failures.
    if (!_stations) _pending = null;
  });

  return _pending;
}

/**
 * The stations nearest a position, loading the snapshot on first use.
 * @param {{latitude: number, longitude: number}} origin Incident position.
 * @param {number} [count=3] How many to return.
 * @param {typeof fetch} [fetchImpl] Test seam.
 * @returns {Promise<object[]>} Nearest stations with `distanceKm`.
 */
export async function findNearestFireStations(origin, count = 3, fetchImpl = globalThis.fetch) {
  const stations = await loadFireStations(fetchImpl);
  return nearestStations(origin, stations, count);
}

/** Drop the cache. Tests only. */
export function _resetFireStationCacheForTest() {
  _pending = null;
  _stations = null;
}
