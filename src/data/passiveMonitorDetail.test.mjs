import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _setBrigadeDepsForTest,
  offersBrigadeAction,
  showNearestBrigades,
} from './passiveMonitorDetail.js';

/**
 * Minimal DOM stand-in for the panel.
 *
 * The action only ever touches `querySelector`, `innerHTML` and `hidden`, so a
 * hand-rolled stub is both sufficient and honest about the coupling — pulling
 * in a DOM implementation would hide how small that surface is.
 */
function fakePanel() {
  const out = { innerHTML: '', hidden: true };
  const button = { disabled: false, textContent: 'Nearest brigades' };
  return {
    out,
    button,
    querySelector(selector) {
      if (selector === '.pm-detail-brigades') return out;
      return null;
    },
  };
}

const ORIGIN = { latitude: -37.53881, longitude: 143.82491 };

const STATIONS = [
  { name: 'Wendouree Fire Station', latitude: -37.5401, longitude: 143.8302, distanceKm: 0.52 },
  { name: 'Ballarat City Fire Station', latitude: -37.5622, longitude: 143.8503, distanceKm: 3.4 },
  { name: 'Sebastopol Fire Station', latitude: -37.5892, longitude: 143.8412, distanceKm: 5.8 },
];

test.afterEach(() => _setBrigadeDepsForTest());

test('the brigade action is offered for fire hazards and withheld from the rest', () => {
  const at = { latitude: -37.5, longitude: 143.8 };

  for (const hazard of ['incident', 'burn-area', 'warning']) {
    assert.equal(offersBrigadeAction({ hazard }, at), true, `${hazard} should offer it`);
  }
  // A brigade distance beside a river height or a battery of outage counts is
  // noise pretending to be intelligence.
  for (const hazard of ['flood', 'power', 'storm', 'weather-warning']) {
    assert.equal(offersBrigadeAction({ hazard }, at), false, `${hazard} should not offer it`);
  }
  // Unknown hazards stay out until someone decides they belong.
  assert.equal(offersBrigadeAction({ hazard: 'tsunami' }, at), false);
  assert.equal(offersBrigadeAction({}, at), false);

  // No position, no proximity question — a button that does nothing is worse
  // than no button.
  assert.equal(offersBrigadeAction({ hazard: 'incident' }, { latitude: NaN, longitude: 143.8 }), false);
  assert.equal(offersBrigadeAction({ hazard: 'incident' }, {}), false);
});

test('the action lists the stations and draws one line to each', async () => {
  const drawn = [];
  _setBrigadeDepsForTest({
    findNearest: async (origin, count) => {
      assert.deepEqual(origin, ORIGIN, 'the incident position is passed through');
      assert.equal(count, 3);
      return STATIONS;
    },
    annotations: () => ({ annotate: (specs, opts) => drawn.push({ specs, opts }) }),
  });

  const panel = fakePanel();
  await showNearestBrigades(panel, ORIGIN, panel.button);

  assert.equal(panel.out.hidden, false);
  for (const station of STATIONS) {
    assert.ok(panel.out.innerHTML.includes(station.name), `${station.name} is listed`);
  }
  assert.ok(panel.out.innerHTML.includes('0.5 km'), 'close range keeps its decimal');
  assert.ok(panel.out.innerHTML.includes('Nearest 3 stations'));
  assert.match(
    panel.out.innerHTML,
    /Straight-line distance\. Not a dispatch/,
    'the answer never pretends to be a turnout',
  );

  assert.equal(drawn.length, 1, 'one batched annotate call');
  const { specs, opts } = drawn[0];
  assert.equal(specs.length, 3);
  assert.equal(opts.clearPrevious, true, 'a second incident must not leave the first ones up');
  for (let i = 0; i < specs.length; i += 1) {
    assert.equal(specs[i].type, 'route');
    assert.equal(specs[i].color, 'green', 'resource green, not hazard red');
    assert.equal(specs[i].mode, 'car', 'an appliance drives — the engine would otherwise label it a walk');
    assert.deepEqual(specs[i].points[0], { latitude: ORIGIN.latitude, longitude: ORIGIN.longitude });
    assert.deepEqual(specs[i].points[1], {
      latitude: STATIONS[i].latitude,
      longitude: STATIONS[i].longitude,
    });
    // Name ONLY: the engine appends the routed distance and drive time, so a
    // straight-line figure here would print two numbers for one trip.
    assert.equal(specs[i].label, STATIONS[i].name);
  }

  assert.equal(panel.button.disabled, false, 'the control is released');
  assert.equal(panel.button.textContent, 'Nearest brigades');
});

test('station names are escaped, never interpolated as markup', async () => {
  // The gazetteer is a state dataset rather than a hostile one, but it is
  // still upstream text — the panel treats every external string the same way.
  _setBrigadeDepsForTest({
    findNearest: async () => [
      { name: '<img src=x onerror=alert(1)>', latitude: -37.5, longitude: 143.8, distanceKm: 1 },
    ],
    annotations: () => null,
  });

  const panel = fakePanel();
  await showNearestBrigades(panel, ORIGIN, panel.button);

  assert.ok(!panel.out.innerHTML.includes('<img'), 'no raw tag survives');
  assert.ok(panel.out.innerHTML.includes('&lt;img'), 'it is shown as text');
});

test('a failed lookup reports itself and releases the button', async () => {
  _setBrigadeDepsForTest({
    findNearest: async () => { throw new Error('HTTP 404'); },
    annotations: () => null,
  });

  const panel = fakePanel();
  await showNearestBrigades(panel, ORIGIN, panel.button);

  assert.match(panel.out.innerHTML, /Station list unavailable \(HTTP 404\)/);
  assert.equal(panel.button.disabled, false, 'a failure must not wedge the control');
});

test('an empty result says so rather than showing an empty list', async () => {
  _setBrigadeDepsForTest({ findNearest: async () => [], annotations: () => null });

  const panel = fakePanel();
  await showNearestBrigades(panel, ORIGIN, panel.button);

  assert.match(panel.out.innerHTML, /No fire stations found/);
});

test('a second click during the lookup is ignored', async () => {
  // The first click fetches ~374 KB. Without the guard the second click runs
  // the whole action again and appends a duplicate set of lines.
  let calls = 0;
  let release;
  _setBrigadeDepsForTest({
    findNearest: async () => {
      calls += 1;
      await new Promise((resolve) => { release = resolve; });
      return STATIONS;
    },
    annotations: () => null,
  });

  const panel = fakePanel();
  const first = showNearestBrigades(panel, ORIGIN, panel.button);
  await showNearestBrigades(panel, ORIGIN, panel.button); // lands mid-flight
  assert.equal(calls, 1, 'the in-flight lookup is not restarted');

  release();
  await first;
  assert.equal(calls, 1);
  assert.ok(panel.out.innerHTML.includes('Wendouree Fire Station'));
});

test('a missing annotation engine still leaves the reader an answer', async () => {
  // The panel can open before the engine initialises. The list is the answer;
  // the lines are the illustration.
  _setBrigadeDepsForTest({ findNearest: async () => STATIONS, annotations: () => null });

  const panel = fakePanel();
  await showNearestBrigades(panel, ORIGIN, panel.button);

  assert.ok(panel.out.innerHTML.includes('Ballarat City Fire Station'));
});
