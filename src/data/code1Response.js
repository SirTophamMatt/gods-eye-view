/**
 * Code 1 (lights-and-sirens) travel-time model.
 *
 * The route proxy returns the OSRM car profile's ordinary-traffic duration.
 * That is the right number for a delivery van and the wrong one for an
 * appliance under priority, so this re-times a route under a simple, stated
 * model: every segment is driven `SPEED_UPLIFT` faster than the routing
 * engine's speed for it, capped at `MAX_SPEED_KMH`.
 *
 * WHAT THE UPLIFT IS APPLIED TO, precisely, because it is not what it looks
 * like. OSRM's `speed` annotation is its own modelled speed for the segment —
 * already scaled BELOW the posted limit by the car profile, and already
 * carrying whatever junction penalty it charged there. So this is 20% above
 * OSRM's number, NOT 20% above the sign. The proxy exposes no `maxspeed`
 * tags, so a literal "limit + 20%" is not available to compute. In practice
 * the two land near each other — OSRM's conservatism roughly cancels the gap —
 * but they are not the same quantity and the difference is the model's, not
 * the road's.
 *
 * TWO WAYS THIS IS OPTIMISTIC, both worth remembering before quoting it:
 *
 *   Intersections. There is no separable "does not stop at the lights" term
 *   here. OSRM folds junction delay into segment durations, so raising every
 *   segment lifts some of it, unevenly and by accident rather than by design.
 *   And the real behaviour is not "does not stop": the road-rule exemption
 *   requires proceeding with due care, so an appliance slows to clear a red
 *   rather than driving through it.
 *
 *   Turnout. This is DRIVE time from the station, and drive time is often the
 *   smaller half. A career station rolls in about a minute; a volunteer
 *   brigade's members travel to the station first, which routinely costs
 *   several times what this whole model saves. `stationAgency.js` is what
 *   tells those apart — nothing here models turnout, deliberately, because the
 *   spread on the volunteer figure is wide enough that inventing one would be
 *   worse than naming the brigade type and letting a reader who knows their
 *   district apply their own.
 */

/** Fraction above the routing engine's segment speed. */
export const SPEED_UPLIFT = 1.2;
/** Ceiling, km/h — no appliance is driven faster than this on a response. */
export const MAX_SPEED_KMH = 110;

const KMH_TO_MS = 1 / 3.6;

/**
 * Re-time a route under the Code 1 model.
 *
 * @param {object} route Route proxy payload (`distanceM`, `durationS`, optional `annotation`).
 * @param {object} [options]
 * @param {number} [options.uplift] Speed multiplier.
 * @param {number} [options.capKmh] Speed ceiling in km/h.
 * @returns {{durationS: number, basis: 'segments'|'average'}|null}
 *   `basis` names which path produced the number; null when the route carries
 *   no usable timing at all.
 */
export function code1Duration(route, { uplift = SPEED_UPLIFT, capKmh = MAX_SPEED_KMH } = {}) {
  const cap = capKmh * KMH_TO_MS;
  const ann = route?.annotation;

  if (Array.isArray(ann?.speed) && Array.isArray(ann?.distance)
    && ann.speed.length === ann.distance.length && ann.speed.length > 0) {
    let total = 0;
    for (let i = 0; i < ann.distance.length; i += 1) {
      const distance = Number(ann.distance[i]);
      const speed = Number(ann.speed[i]);
      if (!Number.isFinite(distance) || distance <= 0) continue;
      const driven = Math.min(Number.isFinite(speed) ? speed * uplift : 0, cap);
      // A zero-speed segment is OSRM reporting a stop, not a road that cannot
      // be driven. Falling back to its own duration keeps the segment in the
      // total instead of making the route look free.
      total += driven > 0 ? distance / driven : Number(ann.duration?.[i]) || 0;
    }
    if (total > 0) return { durationS: total, basis: 'segments' };
  }

  // No annotation: re-time the route as one segment at its average speed.
  // This UNDERESTIMATES the saving on a mixed route — the cap that should bite
  // only on the highway stretch gets applied to a suburban average — so it is
  // the fallback, not the method, and `basis` says which one ran.
  const distanceM = Number(route?.distanceM);
  const durationS = Number(route?.durationS);
  if (!Number.isFinite(distanceM) || !Number.isFinite(durationS) || durationS <= 0) return null;
  const driven = Math.min((distanceM / durationS) * uplift, cap);
  if (!(driven > 0)) return null;
  return { durationS: distanceM / driven, basis: 'average' };
}

/**
 * Travel time for display. Always at least a minute: a sub-60-second response
 * rounds to "0 min", which reads as an error rather than as "very close".
 * @param {number} seconds Duration.
 * @returns {string} e.g. "3 min".
 */
export function formatMinutes(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}
