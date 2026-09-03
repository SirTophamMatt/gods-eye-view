import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  formatDistanceKm,
  haversineKm,
  nearestStations,
  parseStations,
} from './nearestStations.js';

const SNAPSHOT = fileURLToPath(
  new URL('./local_data/vicmap-emergency/vicmap-fire-station.geojsonl', import.meta.url),
);

test('haversine matches known Victorian distances', () => {
  // Melbourne GPO → Ballarat GPO, ~100 km. Checked against a geodesic
  // calculator; the spherical approximation is within a few hundred metres
  // over this distance, which is far inside the error the answer already has.
  const km = haversineKm(-37.8136, 144.9631, -37.5622, 143.8503);
  assert.ok(Math.abs(km - 100.5) < 1.5, `expected ~100.5 km, got ${km.toFixed(2)}`);

  assert.equal(haversineKm(-37.8, 144.9, -37.8, 144.9), 0, 'a point is zero from itself');

  // Symmetry, and no NaN from the sqrt when the points are near-identical.
  const a = haversineKm(-37.5, 143.8, -37.50001, 143.80001);
  const b = haversineKm(-37.50001, 143.80001, -37.5, 143.8);
  assert.equal(a, b);
  assert.ok(Number.isFinite(a) && a < 0.01);
});

test('nearest stations are ordered, capped, and deterministic on ties', () => {
  const origin = { latitude: -37.5, longitude: 143.85 };
  const stations = [
    { name: 'Far', latitude: -38.5, longitude: 143.85 },
    { name: 'Near', latitude: -37.51, longitude: 143.85 },
    { name: 'Middle', latitude: -37.7, longitude: 143.85 },
  ];

  const result = nearestStations(origin, stations, 2);
  assert.deepEqual(result.map((s) => s.name), ['Near', 'Middle']);
  assert.ok(result[0].distanceKm < result[1].distanceKm);
  assert.ok(Number.isFinite(result[0].distanceKm));

  // Two stations exactly equidistant must not swap between calls, or the panel
  // appears to change its mind when the same incident is re-clicked.
  const tied = [
    { name: 'Zulu', latitude: -37.6, longitude: 143.85 },
    { name: 'Alpha', latitude: -37.4, longitude: 143.85 },
  ];
  assert.deepEqual(nearestStations(origin, tied, 2).map((s) => s.name), ['Alpha', 'Zulu']);
  assert.deepEqual(nearestStations(origin, tied, 2).map((s) => s.name), ['Alpha', 'Zulu']);
});

test('a bad origin or empty list yields nothing rather than throwing', () => {
  const stations = [{ name: 'A', latitude: -37.5, longitude: 143.8 }];
  assert.deepEqual(nearestStations({ latitude: NaN, longitude: 143.8 }, stations), []);
  assert.deepEqual(nearestStations(null, stations), []);
  assert.deepEqual(nearestStations({ latitude: -37.5, longitude: 143.8 }, []), []);
  assert.deepEqual(nearestStations({ latitude: -37.5, longitude: 143.8 }, stations, 0), []);
});

test('parseStations reads JSON Lines, a FeatureCollection, and survives a bad row', () => {
  const line = (name, lon, lat) => JSON.stringify({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { name },
  });

  assert.equal(parseStations(`${line('A', 143.8, -37.5)}\n${line('B', 144.0, -37.6)}`).length, 2);

  const collection = JSON.stringify({
    type: 'FeatureCollection',
    features: [JSON.parse(line('A', 143.8, -37.5))],
  });
  assert.deepEqual(
    parseStations(collection),
    [{ name: 'A', latitude: -37.5, longitude: 143.8, state: null }],
    'a record with no state reads as null, not as absent',
  );

  // `state` is carried through: a quarter of the gazetteer is interstate and
  // the agency classifier reads this field rather than the geometry.
  const nsw = JSON.stringify({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [149.9, -37.06] },
    properties: { name: 'Eden Fire Station', state: 'NSW' },
  });
  assert.equal(parseStations(nsw)[0].state, 'NSW');

  // One malformed row costs that row, not the whole action.
  const withJunk = `${line('A', 143.8, -37.5)}\n{ not json\n${line('B', 144.0, -37.6)}`;
  assert.deepEqual(parseStations(withJunk).map((s) => s.name), ['A', 'B']);

  // A nameless or geometryless record is dropped: it would otherwise become
  // the nearest station to half the state at 0,0.
  const bad = JSON.stringify({ type: 'Feature', geometry: null, properties: { name: 'Ghost' } });
  const unnamed = JSON.stringify({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [143.8, -37.5] },
    properties: {},
  });
  assert.deepEqual(parseStations(`${bad}\n${unnamed}`), []);
  assert.deepEqual(parseStations(''), []);
});

test('distances read at the precision they actually have', () => {
  assert.equal(formatDistanceKm(4.23), '4.2 km', 'close range keeps a decimal');
  assert.equal(formatDistanceKm(9.99), '10.0 km');
  assert.equal(formatDistanceKm(19.4), '19 km', 'beyond 10 km a decimal is false precision');
  assert.equal(formatDistanceKm(NaN), '');
});

test('the snapshot holds no duplicate station records', () => {
  // The gazetteer repeats 29 names, 21 of them at identical coordinates — one
  // station recorded twice. Left in, a duplicate spends one of the three slots
  // in a "nearest brigades" answer and lists the same brigade twice, which is
  // what it did before the exporter started collapsing them.
  const stations = parseStations(readFileSync(SNAPSHOT, 'utf8'));
  const seen = new Set();
  const repeats = [];
  for (const station of stations) {
    const key = `${station.name}|${station.longitude.toFixed(3)}|${station.latitude.toFixed(3)}`;
    if (seen.has(key)) repeats.push(station.name);
    seen.add(key);
  }
  assert.deepEqual(repeats, [], 'a name at the same point must appear once');

  // But a name genuinely shared by two DIFFERENT places is kept: there are two
  // Cooma fire stations 364 km apart, and collapsing them by name alone would
  // lose a real brigade.
  const cooma = stations.filter((s) => s.name === 'Cooma Fire Station');
  assert.equal(cooma.length, 2, 'distinct places sharing a name both survive');
});

test('the committed station snapshot answers a real Victorian query', () => {
  // An end-to-end check against the shipped gazetteer, not a fixture: this is
  // what catches a bad export that parses fine but has lost its names or put
  // the whole state in the Atlantic.
  const stations = parseStations(readFileSync(SNAPSHOT, 'utf8'));
  assert.ok(stations.length > 1500, `expected the full network, got ${stations.length}`);

  for (const station of stations) {
    assert.ok(station.longitude > 140 && station.longitude < 151, `${station.name} is outside Victoria`);
    assert.ok(station.latitude > -40 && station.latitude < -33, `${station.name} is outside Victoria`);
  }

  // Ballarat: a real town with a real brigade. The nearest station to the CBD
  // should be within a few kilometres and named for somewhere nearby.
  const nearBallarat = nearestStations({ latitude: -37.5622, longitude: 143.8503 }, stations, 3);
  assert.equal(nearBallarat.length, 3);
  assert.ok(
    nearBallarat[0].distanceKm < 5,
    `nearest station to Ballarat is ${nearBallarat[0].distanceKm.toFixed(1)} km away`,
  );
  assert.ok(
    nearBallarat.every((s) => /fire station/i.test(s.name)),
    `expected station names, got ${nearBallarat.map((s) => s.name).join(', ')}`,
  );
});
