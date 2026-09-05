import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DWELL_MS,
  createMonitorQueue,
  dwellMsFor,
  featureCentroid,
  isVisitable,
  targetPriority,
} from './monitorQueue.js';

const at = (name, lon, lat, props = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { hazard: 'incident', name, ...props },
});

const warning = (name, level, lon = 145, lat = -37.8) => at(name, lon, lat, {
  hazard: 'warning', warningLevel: level, severity: 3,
});

test('the warning ladder outranks the numeric severity', () => {
  assert.equal(targetPriority(warning('A', 'Emergency Warning')), 4);
  assert.equal(targetPriority(warning('B', 'Watch and Act')), 3);
  assert.equal(targetPriority(warning('C', 'Advice')), 2);
  assert.equal(targetPriority(warning('D', 'Community Information')), 1);
  // Case and spacing come from a feed, not from us.
  assert.equal(targetPriority(warning('E', '  EMERGENCY WARNING ')), 4);
});

test('an incident falls back to severity, and nonsense sorts last', () => {
  assert.equal(targetPriority(at('X', 145, -37.8, { severity: 3 })), 3);
  assert.equal(targetPriority(at('Y', 145, -37.8, { severity: 0 })), 0);
  assert.equal(targetPriority(at('Z', 145, -37.8, { severity: 'high' })), 0);
  assert.equal(targetPriority(warning('W', 'Some New Level Google Invented')), 3, 'falls to severity');
  assert.equal(targetPriority(null), 0);
});

test('dwell scales with rank, so a warning gets more than a grass fire', () => {
  assert.equal(dwellMsFor(warning('A', 'Emergency Warning')), DWELL_MS[4]);
  assert.equal(dwellMsFor(warning('B', 'Watch and Act')), DWELL_MS[3]);
  assert.equal(dwellMsFor(at('C', 145, -37.8, { severity: 1 })), DWELL_MS[1]);
  assert.ok(DWELL_MS[4] > DWELL_MS[3] && DWELL_MS[3] > DWELL_MS[2]);
});

test('a polygon is targetable by its ring average', () => {
  const poly = {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[144, -37], [146, -37], [146, -39], [144, -39]]] },
    properties: { hazard: 'warning', warningLevel: 'Advice' },
  };
  assert.deepEqual(featureCentroid(poly), { lat: -38, lon: 145 });
  assert.ok(isVisitable(poly));
});

test('a held record is drawn but never visited', () => {
  // Flying an operator to something that may already be closed, and dwelling
  // three minutes on it, is the worst possible use of the mode's attention.
  const stale = at('Closed?', 145, -37.8, { gevStale: true, gevStaleForMs: 120000 });
  assert.equal(isVisitable(stale), false);

  const queue = createMonitorQueue();
  queue.setPool([stale, at('Live', 146, -37.9)]);
  assert.equal(queue.size(), 1);
  assert.equal(queue.next().feature.properties.name, 'Live');
});

test('a feature with no usable geometry is not a destination', () => {
  assert.equal(isVisitable({ properties: { name: 'X' }, geometry: null }), false);
  assert.equal(isVisitable({ properties: { name: 'X' }, geometry: { type: 'Point', coordinates: ['a', 'b'] } }), false);
  assert.equal(featureCentroid({ geometry: { type: 'Polygon', coordinates: [[]] } }), null);
});

test('a pass works worst-first, then starts again worst-first', () => {
  const queue = createMonitorQueue();
  queue.setPool([
    at('incident', 145.0, -37.0, { severity: 1 }),
    warning('advice', 'Advice', 145.1, -37.1),
    warning('emergency', 'Emergency Warning', 145.2, -37.2),
    warning('watch', 'Watch and Act', 145.3, -37.3),
  ]);

  const pass1 = [queue.next(), queue.next(), queue.next(), queue.next()].map((t) => t.feature.properties.name);
  assert.deepEqual(pass1, ['emergency', 'watch', 'advice', 'incident']);

  // The pass completed; the next one restarts at the top rather than parking
  // on the Emergency Warning forever.
  const pass2 = [queue.next(), queue.next()].map((t) => t.feature.properties.name);
  assert.deepEqual(pass2, ['emergency', 'watch']);
});

test('an arrival interrupts the pass, then the pass resumes where it was', () => {
  const queue = createMonitorQueue();
  queue.setPool([
    warning('emergency', 'Emergency Warning', 145.2, -37.2),
    warning('watch', 'Watch and Act', 145.3, -37.3),
    warning('advice', 'Advice', 145.1, -37.1),
  ]);

  assert.equal(queue.next().feature.properties.name, 'emergency');

  const fresh = at('new-job', 146, -38, { severity: 1 });
  assert.equal(queue.enqueueNew([fresh]), 1);
  const interrupt = queue.next();
  assert.equal(interrupt.feature.properties.name, 'new-job');
  assert.equal(interrupt.reason, 'new', 'and it says why it jumped');

  // Back to the pass: watch and advice are still unvisited.
  assert.equal(queue.next().feature.properties.name, 'watch');
  assert.equal(queue.next().feature.properties.name, 'advice');
});

test('several arrivals at once are taken worst-first', () => {
  const queue = createMonitorQueue();
  queue.setPool([at('standing', 145, -37, { severity: 0 })]);
  queue.enqueueNew([
    at('minor', 146, -38, { severity: 1 }),
    warning('major', 'Emergency Warning', 146.1, -38.1),
    warning('mid', 'Advice', 146.2, -38.2),
  ]);
  const order = [queue.next(), queue.next(), queue.next()].map((t) => t.feature.properties.name);
  assert.deepEqual(order, ['major', 'mid', 'minor']);
});

test('an arrival is jumped to once, not every time', () => {
  const queue = createMonitorQueue();
  queue.setPool([at('standing', 145, -37)]);
  queue.enqueueNew([at('fresh', 146, -38)]);
  queue.enqueueNew([at('fresh', 146, -38)]); // same feature, reported twice
  assert.equal(queue.pendingCount(), 1);
  assert.equal(queue.next().reason, 'new');
  assert.equal(queue.next().reason, 'cycle', 'it is standing set from then on');
});

test('a poll landing mid-pass does not restart the pass', () => {
  const queue = createMonitorQueue();
  const a = warning('a', 'Emergency Warning', 145.1, -37.1);
  const b = warning('b', 'Watch and Act', 145.2, -37.2);
  const c = warning('c', 'Advice', 145.3, -37.3);
  queue.setPool([a, b, c]);
  assert.equal(queue.next().feature.properties.name, 'a');

  queue.setPool([a, b, c]); // the 2-minute poll re-supplies the same set
  assert.equal(queue.next().feature.properties.name, 'b', 'a is not shown twice');
});

test('an empty or all-stale pool has nothing to look at', () => {
  const queue = createMonitorQueue();
  assert.equal(queue.next(), null);
  queue.setPool([at('gone', 145, -37, { gevStale: true })]);
  assert.equal(queue.next(), null);
});

test('the pool is bounded, so a runaway feed cannot unbound the queue', () => {
  const queue = createMonitorQueue();
  const many = Array.from({ length: 900 }, (unused, i) => at(`x${i}`, 145 + (i / 1000), -37));
  assert.equal(queue.setPool(many), 500);
});

test('departed targets stop being tracked', () => {
  const queue = createMonitorQueue();
  const a = at('a', 145, -37);
  const b = at('b', 146, -38);
  queue.setPool([a, b]);
  queue.next();
  queue.setPool([b]);
  assert.equal(queue.size(), 1);
  assert.equal(queue.next().feature.properties.name, 'b');
});
