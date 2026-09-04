/**
 * How far down the station list a given response size reaches.
 *
 * The nearest-brigades action has always answered one question: what is close
 * to this fire. A response size turns that into a rougher but more useful one:
 * if this job escalates to a Make Tankers 15, roughly which brigades supply
 * it? The answer is still proximity — see the standing caveat in
 * `nearestStations.js` that Victoria turns out by response area and turnout
 * agreement, not by distance — so this widens the list, it does not dispatch.
 *
 * THE ONE-TO-ONE ASSUMPTION, which is the whole model and is worth stating
 * plainly: one station contributes one appliance. A "Make Tankers 15" is read
 * as the fifteen nearest brigades, a 3rd Alarm as nine nearby stations. Real
 * responses break this in both directions — a large brigade turns out two
 * tankers, a small one has no crew at 2pm on a weekday and turns out none —
 * so the depth of the list is indicative, never a strike-team roster.
 *
 * FRV / GARS. The Greater Alarm Response System escalates by alarm level
 * rather than by appliance count, so FRV-area incidents get alarm levels in
 * place of tanker counts. Only two cells of that table are public, and they
 * are marked as such:
 *
 *   1st Alarm, non-structure — 2 primary appliances.  [published by FRV]
 *   3rd Alarm, structure     — 9 primary appliances,  [published by FRV]
 *                              plus a ladder platform, BA support, commanders
 *                              and an assistant chief fire officer.
 *
 * Everything else in the structure-fire ladder below is THIS APP'S OWN even
 * ramp — three appliances per alarm — chosen because it passes exactly through
 * the one published structure figure. It is labelled `sourced: false` and the
 * UI marks it estimated. It is a placeholder for the real response cards, not
 * a reconstruction of them: if you hold the actual GARS tables, replace
 * `GARS_APPLIANCES` and delete this paragraph.
 */

/** Nearest-brigades default, unchanged from before response sizes existed. */
export const DEFAULT_PLAN_ID = 'general';

/**
 * Primary appliances per GARS alarm level, structure fire.
 * Index 2 (3rd Alarm) is FRV-published; the rest are the app's even ramp.
 */
export const GARS_APPLIANCES = Object.freeze([3, 6, 9, 12, 15]);

/** The alarm level whose figure comes from FRV rather than from the ramp. */
const GARS_SOURCED_LEVEL = 3;

const ORDINAL = Object.freeze(['1st', '2nd', '3rd', '4th', '5th']);

/**
 * Every response size, in escalation order.
 *
 * `scope` gates an option to where its vocabulary means something: Make
 * Tankers is CFA language and alarm levels are FRV's, so a CFA-country fire is
 * not offered a 4th Alarm and a city job is not offered a Make Tankers 25.
 * `'any'` shows everywhere.
 */
export const RESPONSE_PLANS = Object.freeze([
  Object.freeze({
    id: 'general',
    label: 'General response',
    short: 'General',
    stations: 3,
    scope: 'any',
    sourced: true,
    note: 'The three nearest stations.',
  }),
  ...[5, 10, 15, 20, 25].map((tankers) => Object.freeze({
    id: `mt${tankers}`,
    label: `Make Tankers ${tankers}`,
    short: `MT${tankers}`,
    stations: tankers,
    scope: 'cfa',
    sourced: true,
    note: `${tankers} tankers requested — the ${tankers} nearest stations, one appliance each.`,
  })),
  ...GARS_APPLIANCES.map((appliances, index) => Object.freeze({
    id: `gars${index + 1}`,
    label: `${ORDINAL[index]} Alarm (GARS)`,
    short: `${ORDINAL[index]} Alarm`,
    stations: appliances,
    scope: 'frv',
    sourced: index + 1 === GARS_SOURCED_LEVEL,
    note: index + 1 === GARS_SOURCED_LEVEL
      ? `${appliances} primary appliances plus ladder platform and BA — FRV published figure.`
      : `${appliances} primary appliances — estimated, not an FRV published figure.`,
  })),
]);

const BY_ID = new Map(RESPONSE_PLANS.map((plan) => [plan.id, plan]));

/**
 * Resolve a plan id, falling back to the general response.
 *
 * Total by design, like `resolveVoiceModel`: a stale id from a previous build
 * or a hand-edited control degrades to three stations rather than throwing
 * inside a click handler.
 *
 * @param {unknown} id Plan id.
 * @returns {object} A frozen plan record.
 */
export function resolvePlan(id) {
  const key = typeof id === 'string' ? id.trim().toLowerCase() : '';
  return BY_ID.get(key) || BY_ID.get(DEFAULT_PLAN_ID);
}

/**
 * The plans worth offering for an incident, by whose ground it is on.
 *
 * The general response is always first and always present — it is the one
 * answer that needs no vocabulary at all, and the only one available when the
 * FRV boundary failed to load and `inFrvArea` is null.
 *
 * @param {boolean|null} inFrvArea Whether the incident sits in the FRV
 *   response area; null when the boundary could not be resolved.
 * @returns {object[]} Plans to show, in escalation order.
 */
export function plansFor(inFrvArea) {
  if (inFrvArea === null || inFrvArea === undefined) {
    return RESPONSE_PLANS.filter((plan) => plan.scope === 'any');
  }
  const wanted = inFrvArea ? 'frv' : 'cfa';
  return RESPONSE_PLANS.filter((plan) => plan.scope === 'any' || plan.scope === wanted);
}

/**
 * How many stations a plan asks for, clamped to what the action will fetch.
 *
 * The ceiling is not cosmetic. Each station beyond the first costs one call to
 * the `/api/route` proxy, which rate-limits at 60 a minute per client — so an
 * unbounded plan could spend a reader's whole routing budget on one click and
 * leave the map unable to draw a route afterwards.
 *
 * @param {object} plan A resolved plan.
 * @param {number} [ceiling=25] Hard cap.
 * @returns {number} Station count, at least one.
 */
export function stationCount(plan, ceiling = 25) {
  const wanted = Number(plan?.stations);
  if (!Number.isFinite(wanted)) return 1;
  return Math.max(1, Math.min(Math.floor(ceiling), Math.floor(wanted)));
}
