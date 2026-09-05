import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_FOR_PROPERTY,
  STALE_PROPERTY,
  createRetentionTracker,
  featureKey,
} from './featureRetention.js';

const TEN_MIN = 10 * 60 * 1000;

const incident = (name, lon, lat, extra = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { hazard: 'incident', name, ...extra },
});

test('identity survives the fields that change as a job progresses', () => {
  const before = incident('Skenes Creek Rd', 143.7, -38.7, {
    status: 'Responding', ts: '2026-09-05 01:00:00', severity: 1, detail: '2 resources',
  });
  const after = incident('Skenes Creek Rd', 143.7, -38.7, {
    status: 'Under Control', ts: '2026-09-05 01:40:00', severity: 2, detail: '6 resources',
  });
  assert.equal(featureKey(before), featureKey(after));
});

test('coordinate jitter below a metre does not break identity', () => {
  const a = incident('Bay St', 144.900001, -37.800001);
  const b = incident('Bay St', 144.900002, -37.800002);
  assert.equal(featureKey(a), featureKey(b));
});

test('an explicit id wins over the composite, so an upstream edit is survivable', () => {
  const a = { id: 'VIC-1234', ...incident('Old name', 143.7, -38.7) };
  const b = { id: 'VIC-1234', ...incident('Renamed after review', 143.9, -38.9) };
  assert.equal(featureKey(a), featureKey(b));
  assert.match(featureKey(a), /^id:VIC-1234$/);
});

test('different incidents at different places stay distinct', () => {
  assert.notEqual(
    featureKey(incident('A', 143.7, -38.7)),
    featureKey(incident('A', 145.1, -37.9)),
  );
  assert.notEqual(
    featureKey(incident('A', 143.7, -38.7)),
    featureKey(incident('B', 143.7, -38.7)),
  );
});

test('a polygon is identified by a deterministic vertex', () => {
  const poly = {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[144.9, -37.8], [145.0, -37.8], [145.0, -37.9]]] },
    properties: { hazard: 'burn-area', name: 'Planned burn' },
  };
  assert.equal(featureKey(poly), featureKey({ ...poly }));
  assert.match(featureKey(poly), /144\.90000,-37\.80000/);
});

test('retention off passes the payload straight through', () => {
  // This is every layer that is not Passive Monitor, and it must stay exactly
  // as it behaved before retention existed.
  const tracker = createRetentionTracker({ retentionMs: 0 });
  const payload = [incident('A', 143.7, -38.7)];
  const out = tracker.reconcile(payload, 1000);
  assert.equal(out.features, payload, 'the same array, untouched');
  assert.equal(out.retained, 0);
  assert.equal(tracker.size(), 0, 'nothing is tracked when retention is off');
});

test('a vanished feature is held, marked, and aged', () => {
  const tracker = createRetentionTracker({ retentionMs: TEN_MIN });
  const a = incident('A', 143.7, -38.7);
  const b = incident('B', 145.1, -37.9);

  tracker.reconcile([a, b], 0);
  const out = tracker.reconcile([a], 4 * 60 * 1000);

  assert.equal(out.live, 1);
  assert.equal(out.retained, 1);
  assert.equal(out.dropped, 0);
  assert.equal(out.features.length, 2, 'B is still drawn');

  const heldB = out.features.find((f) => f.properties.name === 'B');
  assert.equal(heldB.properties[STALE_PROPERTY], true);
  assert.equal(heldB.properties[STALE_FOR_PROPERTY], 4 * 60 * 1000);

  const liveA = out.features.find((f) => f.properties.name === 'A');
  assert.equal(liveA.properties[STALE_PROPERTY], undefined, 'a live feature is never marked');
});

test('the held copy does not corrupt the tracked original', () => {
  // Marking must not mutate what is held, or a feature's age would restart
  // from the last mark instead of from when it actually went missing.
  const tracker = createRetentionTracker({ retentionMs: TEN_MIN });
  const a = incident('A', 143.7, -38.7);
  tracker.reconcile([a], 0);
  tracker.reconcile([], 60_000);
  const second = tracker.reconcile([], 120_000);
  assert.equal(second.features[0].properties[STALE_FOR_PROPERTY], 120_000);
  assert.equal(a.properties[STALE_PROPERTY], undefined, 'the caller’s feature is untouched');
});

test('a held feature is dropped once the window closes', () => {
  const tracker = createRetentionTracker({ retentionMs: TEN_MIN });
  tracker.reconcile([incident('A', 143.7, -38.7)], 0);

  const justInside = tracker.reconcile([], TEN_MIN - 1);
  assert.equal(justInside.retained, 1, 'still held one millisecond short of the window');

  const atLimit = tracker.reconcile([], TEN_MIN);
  assert.equal(atLimit.retained, 0, 'the window is exclusive at its edge');
  assert.equal(atLimit.dropped, 1);
  assert.equal(tracker.size(), 0, 'and it stops being tracked');
});

test('a reappearing feature is restored live, not left stale', () => {
  const tracker = createRetentionTracker({ retentionMs: TEN_MIN });
  const a = incident('A', 143.7, -38.7, { status: 'Responding' });
  tracker.reconcile([a], 0);
  tracker.reconcile([], 60_000);

  const back = incident('A', 143.7, -38.7, { status: 'Under Control' });
  const out = tracker.reconcile([back], 120_000);

  assert.equal(out.retained, 0);
  assert.equal(out.features.length, 1);
  assert.equal(out.features[0].properties.status, 'Under Control', 'the fresh copy wins');
  assert.equal(out.features[0].properties[STALE_PROPERTY], undefined);
});

test('one missed poll does not blink the whole layer out', () => {
  // The case that motivated retention: a collector mid-run returns nothing.
  const tracker = createRetentionTracker({ retentionMs: TEN_MIN });
  const all = [incident('A', 143.7, -38.7), incident('B', 145.1, -37.9), incident('C', 144.2, -36.9)];
  tracker.reconcile(all, 0);

  const blank = tracker.reconcile([], 120_000);
  assert.equal(blank.features.length, 3, 'all three ride out the empty poll');
  assert.equal(blank.live, 0);
  assert.equal(blank.retained, 3);

  const recovered = tracker.reconcile(all, 240_000);
  assert.equal(recovered.live, 3);
  assert.equal(recovered.retained, 0);
});

test('a malformed payload is tolerated rather than thrown on', () => {
  const tracker = createRetentionTracker({ retentionMs: TEN_MIN });
  for (const bad of [null, undefined, 'nonsense', 42]) {
    const out = tracker.reconcile(bad, 0);
    assert.deepEqual(out.features, [], `${String(bad)} yields an empty payload`);
  }
  assert.equal(featureKey(null), 'k:||');
  assert.equal(featureKey({ properties: { hazard: 'incident', name: 'X' } }), 'k:incident|X|');
});
