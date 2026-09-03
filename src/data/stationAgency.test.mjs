import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  agencyAt,
  agencyLabel,
  createFrvAreaLoader,
  withAgency,
} from './stationAgency.js';
import { parsePolygonFeatures, pointInPolygons, pointInRing } from './pointInPolygon.js';

const FRV_AREA = fileURLToPath(
  new URL('./local_data/vicmap-admin/vicmap-frv-response.geojsonl', import.meta.url),
);
const STATIONS = fileURLToPath(
  new URL('./local_data/vicmap-emergency/vicmap-fire-station.geojsonl', import.meta.url),
);

/** A unit square with a square hole cut out of its middle. */
const HOLED = [[
  [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
  [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
]];

test('point-in-polygon honours holes and edges', () => {
  assert.equal(pointInPolygons(2, 2, HOLED), true, 'inside the outer ring');
  assert.equal(pointInPolygons(5, 5, HOLED), false, 'inside a hole is OUTSIDE the region');
  assert.equal(pointInPolygons(12, 5, HOLED), false, 'outside entirely');

  // A point level with a shared vertex must not be double-counted — the
  // classic ray-cast bug that reports an interior point as outside.
  const diamond = [[0, 5], [5, 0], [10, 5], [5, 10], [0, 5]];
  assert.equal(pointInRing(5, 5, diamond), true);
  assert.equal(pointInRing(-1, 5, diamond), false);

  assert.equal(pointInPolygons(NaN, 5, HOLED), false);
  assert.equal(pointInPolygons(5, 5, null), false);
});

test('agency labels name the confidence they actually have', () => {
  assert.equal(agencyLabel('frv'), 'FRV (career)');
  // "likely" is load-bearing: the boundary is drawn for response, not
  // employment, and integrated brigades carry career staff outside it.
  assert.match(agencyLabel('cfa'), /likely/);
  assert.equal(agencyLabel(null), '');
  assert.equal(agencyLabel('unknown'), '');
});

test('the shipped FRV boundary classifies real Victorian stations', () => {
  const polygons = parsePolygonFeatures(readFileSync(FRV_AREA, 'utf8'));
  assert.ok(polygons.length > 0, 'the response area parses');

  const named = (name) => {
    const line = readFileSync(STATIONS, 'utf8')
      .split('\n')
      .map((l) => (l.trim() ? JSON.parse(l) : null))
      .find((f) => f?.properties?.name === name);
    assert.ok(line, `${name} is in the gazetteer`);
    const [longitude, latitude] = line.geometry.coordinates;
    return { name, latitude, longitude, state: line.properties.state };
  };

  // Metro Melbourne is FRV, and so are the regional INTEGRATED stations —
  // Ballarat City, Bendigo, Mildura, Cranbourne — which is the split actually
  // tracking career staffing rather than a simple city/country line. 99 of the
  // 1,726 stations fall inside.
  assert.equal(agencyAt(named('Brunswick Fire Station'), polygons), 'frv');
  assert.equal(agencyAt(named('Mildura Fire Station'), polygons), 'frv', 'an integrated regional station');

  // Wendouree sits beside Ballarat City and is NOT integrated: the boundary
  // discriminates at that scale, which is the whole reason it is worth using.
  assert.equal(agencyAt(named('Wendouree Fire Station'), polygons), 'cfa');
  assert.equal(agencyAt(named('Skye Fire Station'), polygons), 'cfa');
});

test('interstate stations are named by state, never classified as CFA', () => {
  // A quarter of the gazetteer is not Victorian. Testing a NSW brigade against
  // a Victorian response-area boundary puts it outside and would label it CFA
  // — confidently wrong about a service this module knows nothing about.
  const polygons = parsePolygonFeatures(readFileSync(FRV_AREA, 'utf8'));

  assert.equal(agencyAt({ latitude: -37.06, longitude: 149.9, state: 'NSW' }, polygons), 'nsw');
  assert.equal(agencyAt({ latitude: -37.0, longitude: 140.7, state: 'SA' }, polygons), 'sa');
  assert.match(agencyLabel('nsw'), /interstate/);
  assert.match(agencyLabel('sa'), /interstate/);

  // A null state is treated as Victorian — the gazetteer leaves it blank on a
  // couple of records, and both sit well inside the state.
  assert.equal(agencyAt({ latitude: -37.8, longitude: 144.96, state: null }, polygons), 'frv');

  // Every interstate station in the shipped snapshot classifies as such.
  const stations = readFileSync(STATIONS, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const misclassified = stations.filter((f) => {
    const state = f.properties.state;
    if (state !== 'NSW' && state !== 'SA') return false;
    const [longitude, latitude] = f.geometry.coordinates;
    const agency = agencyAt({ latitude, longitude, state }, polygons);
    return agency === 'cfa' || agency === 'frv';
  });
  assert.equal(misclassified.length, 0, 'no interstate brigade is labelled a Victorian one');
});

test('a boundary that will not load leaves stations unlabelled, not mislabelled', async () => {
  // Failing open to "cfa" would be a WRONG answer in the direction that
  // overstates turnout, which is worse than no badge at all.
  const failing = createFrvAreaLoader('/nope.geojsonl');
  const stations = [{ name: 'A', latitude: -37.8, longitude: 144.96 }];
  const result = await withAgency(stations, failing, async () => ({ ok: false, status: 404 }));
  assert.equal(result[0].agency, null);
  assert.equal(agencyLabel(result[0].agency), '');
});

test('the loader caches a success and retries a failure', async () => {
  const body = readFileSync(FRV_AREA, 'utf8');
  let calls = 0;
  const load = createFrvAreaLoader('/frv.geojsonl');
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient');
    return { ok: true, status: 200, text: async () => body };
  };

  await assert.rejects(load(flaky), /transient/);
  const polygons = await load(flaky);
  assert.ok(polygons.length > 0, 'the retry succeeds rather than caching the failure');

  await load(flaky);
  assert.equal(calls, 2, 'and the success is cached');
});
