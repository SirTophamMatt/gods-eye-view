/**
 * What Monitor Mode looks at next, and for how long.
 *
 * The ordering problem is the whole module. Two demands pull against each
 * other: an arrival should be seen NOW, and the standing set should be worked
 * through worst-first. Doing either alone gives a mode nobody would run — pure
 * severity parks on the one Emergency Warning forever, pure recency ignores it
 * the moment a grass fire is reported.
 *
 * So: arrivals interrupt, and the standing set cycles in PASSES. Within a pass
 * every target is visited once, worst first; when the pass completes the next
 * one begins, worst first again. That falls out of a single sort key — visits
 * ascending, then priority descending — rather than any explicit pass
 * bookkeeping, which is why there is none.
 *
 * Pure: no DOM, no Cesium, no timers. `now` is injected so a two-minute dwell
 * is testable without waiting two minutes.
 */

import { featureKey } from '../data/featureRetention.js';

/**
 * Warning levels, worst first. Passive Monitor writes these strings verbatim
 * from VicEmergency, and they are the operational ladder everyone already
 * reads — so they outrank the numeric severity where both exist.
 */
const LEVEL_RANK = Object.freeze({
  'emergency warning': 4,
  'watch and act': 3,
  advice: 2,
  'community information': 1,
});

/**
 * How long to hold on a target, by rank.
 *
 * Longer on the levels that carry more to read: an Emergency Warning has an
 * area, a headline and a population behind it, while a routine incident is a
 * street name and a resource count. Equal time would mean either skimming the
 * warning or staring at the grass fire.
 */
export const DWELL_MS = Object.freeze({
  4: 180_000, // Emergency Warning — 3 min
  3: 120_000, // Watch and Act — 2 min
  2: 90_000, //  Advice — 90 s
  1: 90_000,
  0: 90_000,
});

/** Ceiling on how many targets are tracked, so a bad feed cannot unbound this. */
const MAX_POOL = 500;

/**
 * Rank one feature, worst first.
 *
 * Prefers the named warning level and falls back to the numeric severity, so an
 * incident (which carries no level) still sorts sensibly against warnings that
 * do. Unknown or missing values sort last rather than throwing — a feed that
 * grows a new level should push it to the back of the queue, not off a cliff.
 *
 * @param {object} feature GeoJSON feature.
 * @returns {number} 0–4, higher is more urgent.
 */
export function targetPriority(feature) {
  const props = feature?.properties || {};
  const level = String(props.warningLevel ?? '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LEVEL_RANK, level)) return LEVEL_RANK[level];
  const severity = Number(props.severity);
  if (!Number.isFinite(severity)) return 0;
  return Math.max(0, Math.min(3, Math.floor(severity)));
}

/**
 * How long to dwell on one feature.
 * @param {object} feature GeoJSON feature.
 * @returns {number} Milliseconds.
 */
export function dwellMsFor(feature) {
  return DWELL_MS[targetPriority(feature)] ?? DWELL_MS[0];
}

/**
 * Whether a feature is worth stopping on at all.
 *
 * A held record — one the feed has dropped and retention is still drawing — is
 * excluded. Flying an operator to something that may already be closed, and
 * dwelling three minutes on it, is the worst possible use of the mode's
 * attention. It stays visible on the globe; it just stops being a destination.
 *
 * @param {object} feature GeoJSON feature.
 * @returns {boolean}
 */
export function isVisitable(feature) {
  if (!feature?.properties) return false;
  if (feature.properties.gevStale) return false;
  return Boolean(featureCentroid(feature));
}

/**
 * A representative point to fly to.
 *
 * Points give their own coordinate. Polygons give the mean of their outer ring,
 * which is not a true centroid and does not need to be: it is a camera target,
 * and for the concave shapes VicEmergency issues the vertex average sits closer
 * to the mass of the area than a bounding-box centre does.
 *
 * @param {object} feature GeoJSON feature.
 * @returns {{lat: number, lon: number}|null} Target, or null when unusable.
 */
export function featureCentroid(feature) {
  const geometry = feature?.geometry;
  const coords = geometry?.coordinates;
  if (!Array.isArray(coords)) return null;

  if (geometry.type === 'Point') {
    const [lon, lat] = coords;
    return Number.isFinite(lon) && Number.isFinite(lat) ? { lat, lon } : null;
  }

  const ring = geometry.type === 'Polygon' ? coords[0]
    : geometry.type === 'MultiPolygon' ? coords[0]?.[0]
      : geometry.type === 'LineString' ? coords
        : null;
  if (!Array.isArray(ring) || ring.length === 0) return null;

  let lonSum = 0;
  let latSum = 0;
  let n = 0;
  for (const point of ring) {
    if (!Array.isArray(point)) continue;
    const [lon, lat] = point;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    lonSum += lon;
    latSum += lat;
    n += 1;
  }
  return n > 0 ? { lat: latSum / n, lon: lonSum / n } : null;
}

/**
 * Build the queue.
 *
 * @param {object} [options]
 * @param {function(): number} [options.now] Injected clock.
 * @param {function(object): string} [options.keyOf] Identity function.
 * @returns {object} Queue.
 */
export function createMonitorQueue({ now = Date.now, keyOf = featureKey } = {}) {
  /** Everything currently visitable, by key. */
  const pool = new Map();
  /** Visit bookkeeping, kept across pool churn so a pass survives a poll. */
  const visits = new Map();
  /** Arrival keys awaiting their interrupt, worst-first at the time of use. */
  const pending = new Set();

  const rememberVisit = (key) => {
    const prior = visits.get(key) || { count: 0, at: 0 };
    visits.set(key, { count: prior.count + 1, at: now() });
  };

  /** Drop bookkeeping for anything no longer in the pool, bounded. */
  const forgetDeparted = () => {
    for (const key of [...visits.keys()]) {
      if (!pool.has(key)) visits.delete(key);
    }
    for (const key of [...pending]) {
      if (!pool.has(key)) pending.delete(key);
    }
  };

  return {
    /**
     * Replace the standing set.
     *
     * Visit history is kept for anything that survives, so a poll landing
     * mid-pass does not restart the pass.
     *
     * @param {object[]} features Everything currently drawn.
     * @returns {number} How many are visitable.
     */
    setPool(features) {
      pool.clear();
      for (const feature of Array.isArray(features) ? features : []) {
        if (pool.size >= MAX_POOL) break;
        if (!isVisitable(feature)) continue;
        pool.set(keyOf(feature), feature);
      }
      forgetDeparted();
      return pool.size;
    },

    /**
     * Register arrivals. They jump the queue on the next `next()`.
     *
     * An arrival already in the pending set is not re-added — a feature cannot
     * be doubly new, and the retention tracker only reports it once anyway.
     *
     * @param {object[]} features Arrivals, from the retention tracker.
     * @returns {number} How many will actually be jumped to.
     */
    enqueueNew(features) {
      let queued = 0;
      for (const feature of Array.isArray(features) ? features : []) {
        if (!isVisitable(feature)) continue;
        const key = keyOf(feature);
        pool.set(key, feature);
        if (!pending.has(key)) {
          pending.add(key);
          queued += 1;
        }
      }
      return queued;
    },

    /**
     * The next target, or null when there is nothing to look at.
     *
     * Arrivals first, worst-first among themselves. Otherwise the standing set,
     * sorted by visits ascending then priority descending — which walks a pass
     * worst-first and starts the next pass when the current one completes,
     * without any explicit notion of a pass.
     *
     * @returns {{feature: object, key: string, reason: 'new'|'cycle', dwellMs: number}|null}
     */
    next() {
      const rank = (key) => targetPriority(pool.get(key));

      if (pending.size > 0) {
        const key = [...pending].sort((a, b) => rank(b) - rank(a) || a.localeCompare(b))[0];
        pending.delete(key);
        const feature = pool.get(key);
        if (feature) {
          rememberVisit(key);
          return { feature, key, reason: 'new', dwellMs: dwellMsFor(feature) };
        }
      }

      if (pool.size === 0) return null;
      const key = [...pool.keys()].sort((a, b) => {
        const va = visits.get(a)?.count || 0;
        const vb = visits.get(b)?.count || 0;
        if (va !== vb) return va - vb;
        const pa = rank(a);
        const pb = rank(b);
        if (pa !== pb) return pb - pa;
        return a.localeCompare(b);
      })[0];

      const feature = pool.get(key);
      rememberVisit(key);
      return { feature, key, reason: 'cycle', dwellMs: dwellMsFor(feature) };
    },

    /** How many arrivals are waiting to interrupt. */
    pendingCount: () => pending.size,

    /** How many targets are in the standing set. */
    size: () => pool.size,

    /** Forget the pass, keeping the pool. Used when the mode restarts. */
    resetCycle() {
      visits.clear();
      pending.clear();
    },
  };
}
