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
 *
 * The result node answers `querySelector` too, for the timeline chart host and
 * the response-size control. `withNodes: false` drops that method, which is how
 * the "the list survives without the chart" case is driven: the action must
 * degrade to the station list rather than reporting a failure.
 */
function fakePanel({ withNodes = true } = {}) {
  const nodes = new Map();
  const out = { innerHTML: '', hidden: true };
  if (withNodes) {
    out.querySelector = (selector) => {
      if (!nodes.has(selector)) {
        nodes.set(selector, {
          innerHTML: '',
          isConnected: true,
          listeners: {},
          addEventListener(type, handler) { this.listeners[type] = handler; },
        });
      }
      return nodes.get(selector);
    };
  }
  const button = { disabled: false, textContent: 'Response timeline' };
  return {
    out,
    button,
    nodes,
    querySelector(selector) {
      if (selector === '.pm-detail-brigades') return out;
      return null;
    },
  };
}

const ORIGIN = { latitude: -37.53881, longitude: 143.82491 };

const STATIONS = [
  {
    name: 'Wendouree Fire Station', latitude: -37.5401, longitude: 143.8302,
    distanceKm: 0.52, roadDistanceM: 900, code1S: 95, agency: 'cfa',
  },
  {
    name: 'Ballarat City Fire Station', latitude: -37.5622, longitude: 143.8503,
    distanceKm: 3.4, roadDistanceM: 4400, code1S: 260, agency: 'frv',
  },
  {
    name: 'Sebastopol Fire Station', latitude: -37.5892, longitude: 143.8412,
    distanceKm: 5.8, roadDistanceM: 7100, code1S: 400, agency: 'cfa',
  },
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
  assert.ok(panel.out.innerHTML.includes('2 min'), 'the Code 1 time is the headline figure');
  assert.ok(panel.out.innerHTML.includes('0.9 km by road'), 'the road distance sits under it');
  assert.ok(panel.out.innerHTML.includes('FRV (career)'), 'career stations are marked');
  assert.ok(panel.out.innerHTML.includes('CFA (likely volunteer)'), 'and volunteer ones');
  assert.ok(panel.out.innerHTML.includes('Response timeline · 3 stations'));
  assert.match(
    panel.out.innerHTML,
    /SDS is the turnout STANDARD/,
    'the left half never pretends to be a measured turnout',
  );
  assert.match(
    panel.out.innerHTML,
    /not a position report/,
    'nor does the marker pretend to be one',
  );
  assert.match(
    panel.out.innerHTML,
    /Nearest is not dispatched/,
    'nor a dispatch',
  );

  assert.equal(drawn.length, 1, 'one batched annotate call');
  const { specs, opts } = drawn[0];
  assert.equal(specs.length, 6, 'a pin and a route for each of the three stations');
  assert.equal(opts.clearPrevious, true, 'a second incident must not leave the first ones up');
  for (let i = 0; i < STATIONS.length; i += 1) {
    const pin = specs[i * 2];
    const route = specs[(i * 2) + 1];

    // The PIN carries the name, at the station. A route's own caption is drawn
    // at the path MIDPOINT, which stranded the words "Cranbourne Fire Station"
    // in a paddock 672 m from the station and 577 m from the fire — naming a
    // place at neither end of the line that reaches it.
    assert.equal(pin.type, 'pin');
    assert.equal(pin.color, 'green', 'resource green, not hazard red');
    assert.equal(pin.latitude, STATIONS[i].latitude);
    assert.equal(pin.longitude, STATIONS[i].longitude);
    assert.ok(pin.label.startsWith(STATIONS[i].name));
    assert.match(pin.label, /Code 1/, 'the model is named, never left as a bare time');

    assert.equal(route.type, 'route');
    assert.equal(route.color, 'green');
    assert.equal(route.mode, 'car', 'an appliance drives — the engine would otherwise label it a walk');
    // Station FIRST — the appliance travels from the brigade to the fire, and
    // OSRM routes are direction-dependent, so reversing this can change both
    // the path drawn and the time quoted.
    assert.deepEqual(route.points[0], {
      latitude: STATIONS[i].latitude,
      longitude: STATIONS[i].longitude,
    });
    assert.deepEqual(route.points[1], { latitude: ORIGIN.latitude, longitude: ORIGIN.longitude });
    // The caller composes the whole label and suppresses the engine's own
    // metrics: its suffix is the ORDINARY car-profile time, and two travel
    // times on one line is worse than either alone.
    assert.equal(route.metrics, false);
    assert.equal(route.label, null, 'the pin owns the caption; a captioned route repeats it');
  }

  // A bare "2 min" beside a fire reads as a response time to anyone who does
  // not know how it was computed.
  assert.equal(specs[0].label, 'Wendouree Fire Station · 2 min Code 1 · CFA');
  assert.equal(specs[2].label, 'Ballarat City Fire Station · 4 min Code 1 · FRV');

  // The engine clamps a label at 80 characters and truncates mid-word, so a
  // line that overruns loses its agency code rather than wrapping.
  for (const spec of specs) {
    if (spec.label) assert.ok(spec.label.length <= 80, `${spec.label.length} chars: ${spec.label}`);
  }

  assert.equal(panel.button.disabled, false, 'the control is released');
  assert.equal(panel.button.textContent, 'Response timeline');
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

test('the response size drives how many stations are asked for', async () => {
  const asked = [];
  _setBrigadeDepsForTest({
    findNearest: async (origin, count) => { asked.push(count); return STATIONS; },
    inFrvArea: async () => false,
    annotations: () => null,
  });

  const panel = fakePanel();
  await showNearestBrigades(panel, ORIGIN, panel.button);
  await showNearestBrigades(panel, ORIGIN, panel.button, { planId: 'mt15' });
  await showNearestBrigades(panel, ORIGIN, panel.button, { planId: 'mt25' });

  assert.deepEqual(asked, [3, 15, 25]);
});

test('the menu offers the vocabulary of the ground the incident is on', async () => {
  _setBrigadeDepsForTest({
    findNearest: async () => STATIONS,
    inFrvArea: async () => true,
    annotations: () => null,
  });

  const panel = fakePanel();
  await showNearestBrigades(panel, ORIGIN, panel.button);

  assert.match(panel.out.innerHTML, /Alarm \(GARS\)/, 'an FRV job gets alarm levels');
  assert.ok(!panel.out.innerHTML.includes('Make Tankers'), 'and no Make Tankers');
  // Only the FRV-published figure is offered unqualified.
  assert.match(panel.out.innerHTML, /1st Alarm \(GARS\) \(est\.\)/);
  assert.ok(
    !panel.out.innerHTML.includes('3rd Alarm (GARS) (est.)'),
    'the published 3rd Alarm figure is not marked estimated',
  );
});

test('a size held over from the other agency falls back rather than showing empty', async () => {
  _setBrigadeDepsForTest({
    findNearest: async () => STATIONS,
    inFrvArea: async () => true,
    annotations: () => null,
  });

  const panel = fakePanel();
  await showNearestBrigades(panel, ORIGIN, panel.button, { planId: 'mt25' });

  // The results are still the 25 that plan asked for; only the CONTROL resets,
  // because "Make Tankers 25" is not in an FRV menu to select.
  assert.match(panel.out.innerHTML, /value="general" selected/);
});

test('the turnout standard reaches the station sub-line', async () => {
  _setBrigadeDepsForTest({
    findNearest: async () => [{
      ...STATIONS[0],
      sds: { seconds: 240, label: 'CFA D8 metro standard' },
    }],
    inFrvArea: async () => false,
    annotations: () => null,
  });

  const panel = fakePanel();
  await showNearestBrigades(panel, ORIGIN, panel.button);

  assert.match(panel.out.innerHTML, /SDS 4:00/);
});

test('a known incident time produces an elapsed marker and per-station status', async () => {
  const created = new Date(Date.now() - 200_000).toISOString();
  _setBrigadeDepsForTest({
    findNearest: async () => [{
      ...STATIONS[0],
      code1S: 95,
      sds: { seconds: 240, label: 'CFA D8 metro standard' },
    }],
    inFrvArea: async () => false,
    annotations: () => null,
  });

  const panel = fakePanel();
  await showNearestBrigades(panel, ORIGIN, panel.button, { incidentTime: created });

  // 200 s elapsed against a 240 s standard: still turning out.
  assert.match(panel.out.innerHTML, /turning out/);
  assert.match(panel.out.innerHTML, /Elapsed measured from the record’s own timestamp/);
  const host = panel.nodes.get('.rt-chart-host');
  assert.match(host.innerHTML, /rt-now/, 'the marker is drawn into the chart host');
});

test('an unusable incident time charts the plan and claims no elapsed marker', async () => {
  _setBrigadeDepsForTest({
    findNearest: async () => [{ ...STATIONS[0], sds: { seconds: 240, label: '' } }],
    inFrvArea: async () => false,
    annotations: () => null,
  });

  const panel = fakePanel();
  await showNearestBrigades(panel, ORIGIN, panel.button, { incidentTime: 'some time ago' });

  assert.match(panel.out.innerHTML, /No usable incident timestamp/);
  const host = panel.nodes.get('.rt-chart-host');
  assert.ok(!host.innerHTML.includes('rt-now'), 'no marker without an origin');
  assert.match(host.innerHTML, /--rt-sds/, 'but the plan is still charted');
});

test('a bare wall-clock timestamp says the zone was assumed', async () => {
  _setBrigadeDepsForTest({
    findNearest: async () => [{ ...STATIONS[0], sds: { seconds: 240, label: '' } }],
    inFrvArea: async () => false,
    annotations: () => null,
  });

  const panel = fakePanel();
  await showNearestBrigades(panel, ORIGIN, panel.button, { incidentTime: '2026-09-01 23:56:31' });

  assert.match(panel.out.innerHTML, /read as Melbourne local time/);
});

test('the globe is capped even when the panel lists a full strike team', async () => {
  const drawn = [];
  const many = Array.from({ length: 25 }, (unused, index) => ({
    name: `Station ${index + 1}`,
    latitude: -37.5 - (index * 0.01),
    longitude: 143.8,
    distanceKm: index + 1,
    agency: 'cfa',
    sds: { seconds: 480, label: '' },
  }));
  _setBrigadeDepsForTest({
    findNearest: async () => many,
    inFrvArea: async () => false,
    annotations: () => ({ annotate: (specs) => drawn.push(specs) }),
  });

  const panel = fakePanel();
  await showNearestBrigades(panel, ORIGIN, panel.button, { planId: 'mt25' });

  assert.ok(panel.out.innerHTML.includes('Station 25'), 'every station is still listed');
  assert.equal(drawn[0].length, 20, 'a pin and a route for the first ten only');
});

test('the list survives a host that cannot be queried for the chart', async () => {
  _setBrigadeDepsForTest({
    findNearest: async () => STATIONS,
    inFrvArea: async () => false,
    annotations: () => null,
  });

  const panel = fakePanel({ withNodes: false });
  await showNearestBrigades(panel, ORIGIN, panel.button);

  assert.ok(panel.out.innerHTML.includes('Wendouree Fire Station'), 'the answer survives');
  assert.ok(!panel.out.innerHTML.includes('Station list unavailable'), 'and is not reported as a failure');
});
