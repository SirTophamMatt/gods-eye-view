import test from 'node:test';
import assert from 'node:assert/strict';
import { localGeoJsonServices } from '../../app/localGeojsonServices.js';
import { REGISTERED_LAYER_IDS, REGISTRY_BY_ID } from '../../data/layerState.js';
import {
  createPassiveMonitorStatus,
  createVicLayers,
  floodGaugeStyle,
  vicSnapshotUrl,
} from './catalog.js';
import { VIC_LAYER_IDS } from './layerIds.js';

const layers = () =>
  createVicLayers(localGeoJsonServices, {
    isPassiveMonitorLive: async () => false,
  });

test('the catalog builds exactly the ids the panel and voice manifest name', () => {
  assert.deepEqual(
    layers().map((layer) => layer.id),
    [...VIC_LAYER_IDS],
  );
});

test('every Victorian layer has a fork-range share token', () => {
  for (const id of VIC_LAYER_IDS) {
    assert.ok(REGISTERED_LAYER_IDS.includes(id), id);
    assert.match(REGISTRY_BY_ID.get(id).token, /^z[0-9a-z]$/, id);
  }
});

test('only Passive Monitor layers poll; boundaries and stations are static', () => {
  for (const layer of layers()) {
    const expected = layer.id.startsWith('local-pm-') ? 120_000 : 0;
    assert.equal(layer.updateInterval, expected, layer.id);
  }
});

test('snapshot URLs resolve for every bundled dataset', () => {
  assert.match(vicSnapshotUrl('pm-flood'), /pm-flood\.geojsonl$/);
  assert.match(
    vicSnapshotUrl('vicmap-fire-station'),
    /vicmap-fire-station\.geojsonl$/,
  );
  assert.throws(() => vicSnapshotUrl('nope'), /Unknown Victorian dataset/);
});

test('Passive Monitor status is asked once and fails closed to the snapshots', async () => {
  let calls = 0;
  const live = createPassiveMonitorStatus(async () => {
    calls++;
    return { ok: true, json: async () => ({ live: true }) };
  });
  assert.equal(await live(), true);
  assert.equal(await live(), true);
  assert.equal(calls, 1);
  const down = createPassiveMonitorStatus(async () => {
    throw new TypeError('fetch failed');
  });
  assert.equal(await down(), false);
  const refused = createPassiveMonitorStatus(async () => ({ ok: false }));
  assert.equal(await refused(), false);
});

test('flood gauges grow and redden with severity', () => {
  assert.deepEqual(floodGaugeStyle({ severity: 0 }), {
    color: '#2ea8ff',
    pixelSize: 8,
  });
  assert.deepEqual(floodGaugeStyle({ severity: 3 }), {
    color: '#d62728',
    pixelSize: 20,
  });
  assert.deepEqual(floodGaugeStyle({}), { color: '#2ea8ff', pixelSize: 8 });
});
