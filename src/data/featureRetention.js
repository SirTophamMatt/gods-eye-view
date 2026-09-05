/**
 * Keep a vanished feature on screen for a while after its feed drops it.
 *
 * WHY THIS EXISTS. Passive Monitor's incident feed is a snapshot of what is
 * current, not a log. An incident that closes — or that merely fails to appear
 * in one poll because a collector was mid-run — disappears from the next
 * payload entirely. Redrawing straight from each payload makes markers blink
 * out mid-shift with nothing said, and the two causes are indistinguishable:
 * "this job finished" and "this poll missed it" look identical.
 *
 * So a feature absent from the current payload is HELD for `retentionMs` and
 * then dropped. Within that window it is still drawn, marked stale, and
 * carries how long it has been missing. That turns a blink into a fade with a
 * stated reason, and it rides out a single bad poll without a flicker.
 *
 * WHAT THIS IS NOT. It is not a history. Nothing here reconstructs an incident
 * that was never seen, and a held feature is never counted as current — the
 * reconcile result separates `live` from `retained` so a caller can label and
 * count them apart. It is a grace period, and the copy on top of it must say
 * so; a stale marker presented as current is worse than no marker.
 *
 * Pure: no DOM, no Cesium, no network, no clock of its own. `now` is passed in
 * so the whole retention window is testable without waiting for it.
 */

/** Marks a held feature in its properties, for styling and for the panel. */
export const STALE_PROPERTY = 'gevStale';
/** How long it has been missing, ms, alongside `gevStale`. */
export const STALE_FOR_PROPERTY = 'gevStaleForMs';

/**
 * A stable identity for one feature, across polls.
 *
 * Prefers an explicit id wherever the feed offers one, because that is the only
 * form that survives an incident being edited upstream. Passive Monitor's
 * hazard features carry none today, so the fallback composes the fields that do
 * not change as a job progresses: hazard, name, and position.
 *
 * `ts`, `status`, `detail` and `severity` are deliberately EXCLUDED. They are
 * exactly what changes when an incident is updated — folding them in would make
 * every status change read as "the old one vanished and a new one appeared",
 * which is the failure this module exists to prevent.
 *
 * Coordinates are rounded to ~1 m. Some feeds jitter the last decimal between
 * polls, and at full precision that jitter alone would break identity.
 *
 * @param {object} feature GeoJSON Feature.
 * @returns {string} Identity key.
 */
export function featureKey(feature) {
  const props = feature?.properties || {};
  const explicit = feature?.id ?? props.id ?? props.uuid ?? props.eventId;
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) {
    return `id:${String(explicit).trim()}`;
  }

  const hazard = String(props.hazard ?? '').trim();
  const name = String(props.name ?? '').trim();
  const coords = firstCoordinate(feature?.geometry);
  const where = coords
    ? `${coords[0].toFixed(5)},${coords[1].toFixed(5)}`
    : '';
  return `k:${hazard}|${name}|${where}`;
}

/**
 * The first coordinate pair of any geometry, as the feature's anchor.
 *
 * A polygon's first vertex is not its centroid, which does not matter here:
 * this is only ever compared against ITSELF on a later poll, so any
 * deterministic point on the geometry identifies it equally well.
 *
 * @param {object} geometry GeoJSON geometry.
 * @returns {[number, number]|null} [lon, lat], or null when there is none.
 */
function firstCoordinate(geometry) {
  let node = geometry?.coordinates;
  // Descend the nesting until the first pair of numbers.
  for (let depth = 0; depth < 5; depth += 1) {
    if (!Array.isArray(node)) return null;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      return [node[0], node[1]];
    }
    node = node[0];
  }
  return null;
}

/**
 * Track which features are current and which are being held.
 *
 * @param {object} [options]
 * @param {number} [options.retentionMs=0] Grace period. 0 disables retention
 *   entirely, which is the behaviour every layer had before this existed —
 *   the payload is passed through untouched.
 * @param {function(object): string} [options.keyOf] Identity function.
 * @returns {{reconcile: function, size: function, reset: function}}
 */
export function createRetentionTracker({ retentionMs = 0, keyOf = featureKey } = {}) {
  /** @type {Map<string, {feature: object, lastSeen: number}>} */
  const held = new Map();
  /**
   * Whether a payload has been seen at all yet.
   *
   * The FIRST reconcile is not a set of arrivals. Everything in it is new by
   * definition — the tracker has seen nothing — and reporting twenty-eight
   * "new incidents" the moment a layer is switched on would be both useless and
   * alarming to anything watching for arrivals. So the first payload is
   * absorbed silently and only later ones report additions.
   */
  let primed = false;

  return {
    /**
     * Merge a fresh payload with anything still inside its grace period.
     *
     * Live features always win: a feature that reappears is replaced by the
     * new copy, so an updated status is shown rather than the held one.
     *
     * @param {object[]} features The payload, as parsed.
     * @param {number} now Clock, injected.
     * @returns {{features: object[], live: number, retained: number, dropped: number, added: object[]}}
     */
    reconcile(features, now) {
      const incoming = Array.isArray(features) ? features : [];
      if (!(retentionMs > 0)) {
        return {
          features: incoming, live: incoming.length, retained: 0, dropped: 0, added: [],
        };
      }

      const seen = new Set();
      const added = [];
      for (const feature of incoming) {
        const key = keyOf(feature);
        seen.add(key);
        // New only if this tracker has never held it — and never on the first
        // payload, which is a starting state rather than a set of arrivals.
        if (primed && !held.has(key)) added.push(feature);
        held.set(key, { feature, lastSeen: now });
      }
      primed = true;

      const retained = [];
      let dropped = 0;
      for (const [key, entry] of held) {
        if (seen.has(key)) continue;
        const missingFor = now - entry.lastSeen;
        if (missingFor >= retentionMs) {
          held.delete(key);
          dropped += 1;
          continue;
        }
        retained.push(markStale(entry.feature, missingFor));
      }

      return {
        features: incoming.concat(retained),
        live: incoming.length,
        retained: retained.length,
        dropped,
        // Features present now that this tracker had never held. Empty on the
        // first payload; empty for a feature returning from its grace period,
        // which is a reappearance and not an arrival.
        added,
      };
    },

    /** How many features are currently tracked, live or held. */
    size: () => held.size,

    /** Forget everything, including that a payload was ever seen. */
    reset: () => { held.clear(); primed = false; },
  };
}

/**
 * A copy of `feature` flagged as held.
 *
 * Copied rather than mutated: the tracker keeps the original so that a feature
 * held across several polls reports its age from when it actually went missing,
 * not from the last time it was marked.
 *
 * @param {object} feature Feature to flag.
 * @param {number} missingForMs How long it has been absent.
 * @returns {object} A stale-marked copy.
 */
function markStale(feature, missingForMs) {
  return {
    ...feature,
    properties: {
      ...(feature?.properties || {}),
      [STALE_PROPERTY]: true,
      [STALE_FOR_PROPERTY]: Math.max(0, Math.round(missingForMs)),
    },
  };
}
