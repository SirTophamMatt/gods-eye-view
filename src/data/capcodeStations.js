/**
 * Resolve a pager capcode's alias to a fire station on the globe.
 *
 * This is the join neither system provides. PagerMon's `capcodes` table maps a
 * pager address to an `alias` and an `agency` and stops there — it holds no
 * coordinates. The Vicmap gazetteer holds 1,288 Victorian stations with
 * coordinates and no capcodes. The only thing connecting them is the brigade's
 * name, written by two different parties for two different purposes.
 *
 * EXACT MATCHING ON A NORMALISED NAME, AND NOTHING CLEVERER. Fuzzy matching is
 * the obvious idea and the wrong one here: the failure it produces is a page
 * for one brigade drawn on top of a different brigade, which is worse than a
 * page that does not appear at all. "Officer" and "Officer South" are real
 * separate stations 4 km apart; so are "Bendigo" and "Bendigo District". A
 * near-miss that silently picks one is indistinguishable, on a map, from a
 * fact. So a name either normalises onto exactly one station or it does not
 * resolve, and the unresolved ones are COUNTED and reportable rather than
 * dropped quietly — see `resolveCapcodes`.
 *
 * The two sides are normalised the same way, which is what makes the match
 * work at all: the gazetteer writes "Wendouree Fire Station" and a PagerMon
 * operator writes "WENDOUREE" or "CFA WENDOUREE" or "Wendouree FS". Strip the
 * agency and facility words off both and all four become "WENDOUREE".
 *
 * Where normalisation genuinely cannot bridge the two — a brigade the operator
 * named something the gazetteer has never heard of — an override map is the
 * answer, not a looser matcher. `OVERRIDES` is empty on purpose: it should be
 * filled from a real capcode export, one verified line at a time.
 */

/**
 * Words that describe the FACILITY or the AGENCY rather than the place.
 *
 * Removed from both sides before matching.
 *
 * SATELLITE and RURAL are deliberately NOT here, though both look like noise.
 * A satellite station is a second physical location of the same brigade, and
 * 85 of them share their parent's place name — stripping the word collapsed
 * "Anglesea Fire Station" onto "Anglesea Satellite Fire Station (Anglesea)"
 * and made BOTH unresolvable as ambiguous. Keeping it, an alias of "ANGLESEA"
 * lands on the main station and "ANGLESEA SATELLITE" lands on the satellite,
 * which is what each of them means. "Beechworth Rural" is the same story with
 * one pair. Dropping a word that distinguishes two real places does not make
 * matching more forgiving; it makes two brigades unmatchable.
 */
const NOISE_TOKENS = new Set([
  'FIRE', 'STATION', 'STN', 'FS',
  'BRIGADE', 'BDE', 'RFB',
  'CFA', 'FRV', 'MFB', 'SES',
  'COUNTRY', 'AUTHORITY',
  'VIC', 'VICTORIA',
]);

/**
 * Token rewrites applied before noise removal.
 *
 * SATELITE → SATELLITE fixes a misspelling in the GAZETTEER itself (Melbourne
 * Airport Satelite Fire Station). Normalising the source's typo away is what
 * lets a correctly-spelled alias reach it.
 */
const TOKEN_ALIASES = new Map([
  ['MT', 'MOUNT'],
  ['STH', 'SOUTH'],
  ['NTH', 'NORTH'],
  ['E', 'EAST'],
  ['W', 'WEST'],
  ['SATELITE', 'SATELLITE'],
]);

/**
 * Verified capcode-alias → station-name corrections.
 *
 * Deliberately empty. Every entry here is a human assertion that two names
 * mean the same brigade, and that assertion should be made against a real
 * capcode list by someone who knows the district — not guessed at now to make
 * a hit rate look better than it is.
 *
 * Keys are normalised aliases (run `normalizeName` on the raw alias); values
 * are the station's exact `name` from the gazetteer.
 * @type {Map<string, string>}
 */
export const OVERRIDES = new Map([]);

/**
 * Normalise a brigade or station name to its comparable core.
 *
 * Parenthetical text is dropped: the gazetteer uses it for the satellite
 * station's host locality ("Haddon Satellite Fire Station (Smythes Creek)"),
 * which is a different place name from the brigade's own and would never
 * appear in an alias.
 *
 * @param {string} raw Station name or capcode alias.
 * @returns {string} Normalised key, possibly empty.
 */
export function normalizeName(raw) {
  const text = String(raw ?? '')
    .toUpperCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  if (!text) return '';

  const tokens = [];
  for (const token of text.split(' ')) {
    const mapped = TOKEN_ALIASES.get(token) || token;
    if (NOISE_TOKENS.has(mapped)) continue;
    tokens.push(mapped);
  }
  return tokens.join(' ');
}

/**
 * Every key a station should answer to.
 *
 * "Clarkefield And District Fire Station" is one brigade an operator may well
 * have entered as just "CLARKEFIELD", so the "AND DISTRICT" suffix yields a
 * second key. The suffix is only stripped from the END — "Bendigo District"
 * is not "Bendigo", and a mid-name "district" is part of the place.
 *
 * @param {string} name Station name from the gazetteer.
 * @returns {string[]} Distinct normalised keys.
 */
export function stationKeys(name) {
  const primary = normalizeName(name);
  if (!primary) return [];
  const keys = [primary];
  const trimmed = primary.replace(/\s+AND\s+DISTRICT$/, '').trim();
  if (trimmed && trimmed !== primary) keys.push(trimmed);
  return keys;
}

/**
 * Build the lookup index over a station list.
 *
 * A key claimed by two different stations is marked AMBIGUOUS and resolves to
 * nothing. Two brigades whose names normalise together cannot be told apart by
 * name, and picking the first is picking at random.
 *
 * @param {object[]} stations Stations with `name`, `latitude`, `longitude`.
 * @returns {{byKey: Map<string, object|null>, ambiguous: string[]}}
 *   `byKey` maps a key to its station, or to null where the key is ambiguous.
 */
export function buildStationIndex(stations) {
  const byKey = new Map();
  const ambiguous = new Set();

  for (const station of Array.isArray(stations) ? stations : []) {
    for (const key of stationKeys(station?.name)) {
      if (!byKey.has(key)) {
        byKey.set(key, station);
        continue;
      }
      const existing = byKey.get(key);
      // The same station listed twice is not a conflict; a different one is.
      if (existing && existing.name === station.name
        && existing.latitude === station.latitude
        && existing.longitude === station.longitude) continue;
      byKey.set(key, null);
      ambiguous.add(key);
    }
  }

  return { byKey, ambiguous: [...ambiguous].sort() };
}

/**
 * Resolve one capcode alias against a built index.
 * @param {string} alias Raw capcode alias.
 * @param {{byKey: Map<string, object|null>}} index From `buildStationIndex`.
 * @param {Map<string, string>} [overrides] Verified corrections.
 * @returns {{station: object|null, key: string, reason: 'matched'|'override'|'ambiguous'|'unknown'|'empty'}}
 */
export function resolveCapcode(alias, index, overrides = OVERRIDES) {
  const key = normalizeName(alias);
  if (!key) return { station: null, key, reason: 'empty' };

  const override = overrides.get(key);
  if (override) {
    const station = index.byKey.get(normalizeName(override));
    if (station) return { station, key, reason: 'override' };
  }

  if (!index.byKey.has(key)) return { station: null, key, reason: 'unknown' };
  const station = index.byKey.get(key);
  // Present but null is the ambiguity marker the index writes.
  if (!station) return { station: null, key, reason: 'ambiguous' };
  return { station, key, reason: 'matched' };
}

/**
 * Resolve a whole capcode table and report how well it went.
 *
 * The report is the point. A resolver that quietly places 40% of brigades and
 * says nothing looks identical, on screen, to one that places all of them —
 * the pages for the missing 60% simply never appear, and nothing indicates
 * they are missing. `unresolved` is what turns that into a fixable list.
 *
 * @param {{address: string, alias: string, agency?: string}[]} capcodes PagerMon capcodes.
 * @param {object[]} stations Gazetteer stations.
 * @param {Map<string, string>} [overrides] Verified corrections.
 * @returns {{resolved: Map<string, object>, unresolved: object[], stats: object}}
 *   `resolved` is keyed by capcode ADDRESS, which is what a page carries.
 */
export function resolveCapcodes(capcodes, stations, overrides = OVERRIDES) {
  const index = buildStationIndex(stations);
  const resolved = new Map();
  const unresolved = [];
  const stats = {
    total: 0, matched: 0, override: 0, ambiguous: 0, unknown: 0, empty: 0,
  };

  for (const capcode of Array.isArray(capcodes) ? capcodes : []) {
    const address = String(capcode?.address ?? '').trim();
    if (!address) continue;
    stats.total += 1;
    const outcome = resolveCapcode(capcode?.alias, index, overrides);
    stats[outcome.reason] += 1;
    if (outcome.station) {
      resolved.set(address, {
        address,
        alias: String(capcode?.alias ?? '').trim(),
        agency: String(capcode?.agency ?? '').trim() || null,
        name: outcome.station.name,
        latitude: outcome.station.latitude,
        longitude: outcome.station.longitude,
      });
    } else {
      unresolved.push({
        address,
        alias: String(capcode?.alias ?? '').trim(),
        key: outcome.key,
        reason: outcome.reason,
      });
    }
  }

  stats.hitRate = stats.total > 0
    ? Math.round(((stats.matched + stats.override) / stats.total) * 100)
    : 0;
  return { resolved, unresolved, stats };
}
