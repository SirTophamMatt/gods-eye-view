import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PLAN_ID,
  GARS_APPLIANCES,
  RESPONSE_PLANS,
  plansFor,
  resolvePlan,
  stationCount,
} from './responsePlan.js';

test('the default is the three-station general response it has always been', () => {
  const plan = resolvePlan(DEFAULT_PLAN_ID);
  assert.equal(plan.stations, 3);
  assert.equal(plan.scope, 'any');
});

test('Make Tankers reads its own number', () => {
  for (const tankers of [5, 10, 15, 20, 25]) {
    const plan = resolvePlan(`mt${tankers}`);
    assert.equal(plan.stations, tankers);
    assert.equal(plan.scope, 'cfa');
  }
});

test('an unknown, empty or hostile plan id degrades to the general response', () => {
  // Total by design: a stale id from a previous build reaches this inside a
  // click handler, where throwing would lose the whole answer.
  for (const id of ['mt7', '', null, undefined, 42, 'constructor', '__proto__', 'toString']) {
    assert.equal(resolvePlan(id).id, DEFAULT_PLAN_ID, `${String(id)} should fall back`);
  }
});

test('the menu speaks the vocabulary of the ground the incident is on', () => {
  const frv = plansFor(true).map((plan) => plan.id);
  assert.ok(frv.includes('general'));
  assert.ok(frv.includes('gars3'), 'FRV ground offers alarm levels');
  assert.ok(!frv.some((id) => id.startsWith('mt')), 'FRV ground offers no Make Tankers');

  const cfa = plansFor(false).map((plan) => plan.id);
  assert.ok(cfa.includes('mt15'), 'CFA ground offers Make Tankers');
  assert.ok(!cfa.some((id) => id.startsWith('gars')), 'CFA ground offers no alarm levels');
});

test('an unresolved boundary offers only what needs no agency vocabulary', () => {
  // "We do not know" must not be conflated with "it is CFA country", which
  // would offer a city job a Make Tankers 25.
  for (const unknown of [null, undefined]) {
    const ids = plansFor(unknown).map((plan) => plan.id);
    assert.deepEqual(ids, ['general']);
  }
});

test('only the FRV-published GARS figure claims to be sourced', () => {
  const gars = RESPONSE_PLANS.filter((plan) => plan.id.startsWith('gars'));
  assert.equal(gars.length, 5, 'alarm levels run to the 5th');
  const sourced = gars.filter((plan) => plan.sourced).map((plan) => plan.id);
  assert.deepEqual(sourced, ['gars3'], 'the 3rd Alarm figure is the only published one');
  for (const plan of gars) {
    if (plan.sourced) continue;
    assert.match(plan.note, /estimated/, 'every unsourced level says so in its note');
  }
});

test('the estimated GARS ramp passes through the one published figure', () => {
  assert.equal(GARS_APPLIANCES[2], 9, '3rd Alarm structure is nine primary appliances');
  const steps = GARS_APPLIANCES.slice(1).map((n, i) => n - GARS_APPLIANCES[i]);
  assert.ok(steps.every((step) => step === steps[0]), 'the ramp is even, as documented');
});

test('the station count is clamped to what the route budget will bear', () => {
  assert.equal(stationCount(resolvePlan('mt25')), 25);
  assert.equal(stationCount({ stations: 400 }), 25, 'a runaway plan cannot drain the proxy');
  assert.equal(stationCount({ stations: 0 }), 1);
  assert.equal(stationCount({ stations: 'many' }), 1);
  assert.equal(stationCount(null), 1);
});
