import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approximateAreaKm2,
  formatAreaKm2,
  ringsOf,
  summarizeInside,
  summaryLines,
} from './polygonSummary.js';

/** A 1° box around (145, -37): roughly 111 km by 89 km at that latitude. */
const BOX = {
  type: 'Feature',
  properties: { hazard: 'warning', warningLevel: 'Watch and Act', name: 'Test area' },
  geometry: { type: 'Polygon', coordinates: [[[144.5, -37.5], [145.5, -37.5], [145.5, -36.5], [144.5, -36.5], [144.5, -37.5]]] },
};

const rec = (name, lat, lon) => ({ name, lat, lon });

test('rings are extracted for both polygon shapes, and nothing else', () => {
  assert.equal(ringsOf(BOX).length, 1);
  const multi = { geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1]]], [[[5, 5], [6, 5], [6, 6]]]] } };
  assert.equal(ringsOf(multi).length, 2, 'each part is testable, not just the first');
  assert.deepEqual(ringsOf({ geometry: { type: 'Point', coordinates: [1, 2] } }), []);
  assert.deepEqual(ringsOf(null), []);
});

test('records inside the ring are counted and named', () => {
  const summary = summarizeInside(BOX, [
    {
      key: 'stations',
      label: 'Fire stations',
      records: [
        rec('Inside A', -37.0, 145.0),
        rec('Inside B', -36.8, 144.9),
        rec('Outside', -38.5, 143.0),
      ],
    },
  ]);
  assert.equal(summary.groups[0].count, 2);
  assert.deepEqual(summary.groups[0].examples, ['Inside A', 'Inside B']);
  assert.equal(summary.total, 2);
});

test('a hole is cut out, so an excluded township is not counted', () => {
  const withHole = {
    ...BOX,
    geometry: {
      type: 'Polygon',
      coordinates: [
        BOX.geometry.coordinates[0],
        [[144.9, -37.1], [145.1, -37.1], [145.1, -36.9], [144.9, -36.9], [144.9, -37.1]],
      ],
    },
  };
  const summary = summarizeInside(withHole, [
    { key: 'x', label: 'Things', records: [rec('In the hole', -37.0, 145.0), rec('In the ring', -36.6, 144.6)] },
  ]);
  assert.equal(summary.groups[0].count, 1);
  assert.deepEqual(summary.groups[0].examples, ['In the ring']);
});

test('a layer that is OFF is reported as off, never as zero', () => {
  // "No fire stations in the warning area" and "the stations layer isn't
  // loaded" are opposite conclusions. They must not render the same way.
  const summary = summarizeInside(BOX, [
    { key: 'stations', label: 'Fire stations', enabled: false, records: [rec('Would match', -37, 145)] },
    { key: 'flights', label: 'Flights', records: [] },
  ]);
  assert.equal(summary.groups[0].enabled, false);
  assert.equal(summary.groups[0].count, 0);
  assert.equal(summary.total, 0, 'an off layer contributes nothing to the total');

  const lines = summaryLines(summary);
  assert.equal(lines[0], 'Fire stations: layer off');
  assert.equal(lines[1], 'Flights: none');
});

test('an empty group is still listed, because zero is a finding', () => {
  const lines = summaryLines(summarizeInside(BOX, [{ key: 'q', label: 'Fire stations', records: [] }]));
  assert.deepEqual(lines, ['Fire stations: none']);
});

test('more matches than examples are marked as truncated', () => {
  const many = Array.from({ length: 9 }, (unused, i) => rec(`Station ${i}`, -37, 145));
  const lines = summaryLines(summarizeInside(BOX, [{ key: 's', label: 'Stations', records: many }]));
  assert.match(lines[0], /^Stations: 9 — Station 0, Station 1, Station 2…$/);
});

test('records are read from either coordinate convention', () => {
  const summary = summarizeInside(BOX, [
    { key: 'a', label: 'A', records: [{ name: 'latlon', latitude: -37, longitude: 145 }] },
    { key: 'b', label: 'B', records: [{ name: 'shorthand', lat: -37, lon: 145 }] },
  ]);
  assert.equal(summary.groups[0].count, 1, 'latitude/longitude');
  assert.equal(summary.groups[1].count, 1, 'lat/lon');
});

test('malformed records are skipped rather than counted or thrown on', () => {
  const summary = summarizeInside(BOX, [
    { key: 'a', label: 'A', records: [null, {}, { lat: 'x', lon: 'y' }, rec('good', -37, 145)] },
  ]);
  assert.equal(summary.groups[0].count, 1);
});

test('a feature with no polygon reports no area and counts nothing', () => {
  const point = { geometry: { type: 'Point', coordinates: [145, -37] }, properties: {} };
  const summary = summarizeInside(point, [{ key: 'a', label: 'A', records: [rec('x', -37, 145)] }]);
  assert.equal(summary.hasArea, false);
  assert.equal(summary.areaKm2, null);
  assert.equal(summary.groups[0].count, 0, 'containment is meaningless without an area');
});

test('area is in the right order of magnitude for a one-degree box', () => {
  // 1° lat ≈ 111 km; 1° lon at -37° ≈ 89 km. So ~9,900 km².
  const km2 = approximateAreaKm2(BOX);
  assert.ok(km2 > 9_000 && km2 < 10_500, `expected ~9,900 km², got ${Math.round(km2)}`);
});

test('a hole reduces the reported area', () => {
  const withHole = {
    geometry: {
      type: 'Polygon',
      coordinates: [
        BOX.geometry.coordinates[0],
        [[144.9, -37.1], [145.1, -37.1], [145.1, -36.9], [144.9, -36.9], [144.9, -37.1]],
      ],
    },
  };
  assert.ok(approximateAreaKm2(withHole) < approximateAreaKm2(BOX));
});

test('area formatting keeps a decimal only where it means something', () => {
  assert.equal(formatAreaKm2(8.42), '8.4 km²');
  assert.equal(formatAreaKm2(1240.4), '1,240 km²');
  assert.equal(formatAreaKm2(0), '');
  assert.equal(formatAreaKm2(null), '');
});
