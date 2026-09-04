import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CFA_METRO_DISTRICTS,
  SDS_CFA_METRO_S,
  SDS_CFA_RURAL_S,
  SDS_FRV_S,
  cfaDistrictNumber,
  createCfaDistrictLoader,
  formatClock,
  sdsForStation,
  withTurnoutStandard,
} from './turnoutStandard.js';

/** A unit square around (145, -38), as one named district part. */
const square = (name, lon, lat) => ({
  name,
  rings: [[[lon - 0.5, lat - 0.5], [lon + 0.5, lat - 0.5], [lon + 0.5, lat + 0.5], [lon - 0.5, lat + 0.5]]],
});

const DISTRICTS = [square('CFA District 8', 145, -38), square('CFA District 11', 147, -38)];

test('the three standards are the published figures', () => {
  assert.equal(SDS_FRV_S, 90);
  assert.equal(SDS_CFA_METRO_S, 4 * 60);
  assert.equal(SDS_CFA_RURAL_S, 8 * 60);
  assert.deepEqual([...CFA_METRO_DISTRICTS], [7, 8, 13, 14]);
});

test('an FRV station takes the career standard without touching the districts', () => {
  // Passing NO districts proves the FRV branch never needs them — the boundary
  // load can fail and a career station still charts correctly.
  const sds = sdsForStation({ agency: 'frv', longitude: 145, latitude: -38 }, undefined);
  assert.equal(sds.seconds, SDS_FRV_S);
  assert.equal(sds.basis, 'frv-career');
});

test('a CFA station in Districts 7/8/13/14 takes the 4-minute metro figure', () => {
  const sds = sdsForStation({ agency: 'cfa', longitude: 145, latitude: -38 }, DISTRICTS);
  assert.equal(sds.seconds, SDS_CFA_METRO_S);
  assert.equal(sds.basis, 'cfa-metro');
  assert.equal(sds.districtNumber, 8);
  assert.match(sds.label, /D8 metro/);
});

test('a CFA station in any other district takes the 8-minute figure', () => {
  const sds = sdsForStation({ agency: 'cfa', longitude: 147, latitude: -38 }, DISTRICTS);
  assert.equal(sds.seconds, SDS_CFA_RURAL_S);
  assert.equal(sds.basis, 'cfa-rural');
  assert.equal(sds.districtNumber, 11);
});

test('an unresolved district yields NO standard rather than the rural default', () => {
  // The failure mode this guards: defaulting to 8 minutes would charge a metro
  // brigade four extra minutes it was never given, silently and plausibly.
  const sds = sdsForStation({ agency: 'cfa', longitude: 100, latitude: 0 }, DISTRICTS);
  assert.equal(sds.seconds, null);
  assert.equal(sds.basis, null);
});

test('interstate and unclassified stations claim no standard', () => {
  for (const agency of ['nsw', 'sa', null, undefined, '']) {
    const sds = sdsForStation({ agency, longitude: 145, latitude: -38 }, DISTRICTS);
    assert.equal(sds.seconds, null, `agency ${String(agency)} should carry no standard`);
  }
});

test('the district number survives a cosmetic upstream rename', () => {
  assert.equal(cfaDistrictNumber('CFA District 7'), 7);
  assert.equal(cfaDistrictNumber('CFA District 07'), 7);
  assert.equal(cfaDistrictNumber('District 14'), 14);
  assert.equal(cfaDistrictNumber('Metropolitan'), null);
  assert.equal(cfaDistrictNumber(null), null);
});

test('a district-load failure leaves stations unstandardised, not defaulted', () => {
  const stations = [{ name: 'A', agency: 'cfa', longitude: 145, latitude: -38 }];
  return withTurnoutStandard(stations, () => Promise.reject(new Error('offline')))
    .then((out) => {
      assert.equal(out.length, 1);
      assert.equal(out[0].sds.seconds, null);
      assert.equal(out[0].name, 'A', 'the station itself survives the failure');
    });
});

test('a failed district load is not cached, so the next call can succeed', async () => {
  let calls = 0;
  const loader = createCfaDistrictLoader('districts.geojsonl');
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503 };
    return { ok: true, text: async () => JSON.stringify({ type: 'Feature', properties: { name: 'CFA District 7' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] } }) };
  };

  await assert.rejects(() => loader(fetchImpl));
  const districts = await loader(fetchImpl);
  assert.equal(districts.length, 1);
  assert.equal(districts[0].name, 'CFA District 7');
  assert.equal(calls, 2, 'the failure must not have been cached');
});

test('a successful district load is cached', async () => {
  let calls = 0;
  const loader = createCfaDistrictLoader('districts.geojsonl');
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, text: async () => JSON.stringify({ type: 'Feature', properties: { name: 'CFA District 13' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] } }) };
  };
  await loader(fetchImpl);
  await loader(fetchImpl);
  assert.equal(calls, 1);
});

test('the clock keeps seconds, because 1:30 and 4:00 are the whole point', () => {
  assert.equal(formatClock(90), '1:30');
  assert.equal(formatClock(240), '4:00');
  assert.equal(formatClock(480), '8:00');
  assert.equal(formatClock(724), '12:04');
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(null), '');
  assert.equal(formatClock(-5), '');
});
