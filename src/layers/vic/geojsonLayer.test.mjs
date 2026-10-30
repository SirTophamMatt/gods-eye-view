import test from 'node:test';
import assert from 'node:assert/strict';
import { localGeoJsonServices } from '../../app/localGeojsonServices.js';
import { getContextStore } from '../../data/contextStore.js';
import {
  collectHoleRings,
  createVicGeoJsonLayer,
  firstCoordinateOf,
  parseGeojsonFeatures,
  resolveLayerSource,
  vicLabelPriority,
  vicOverlayCopy,
} from './geojsonLayer.js';

const point = (id, lon, lat, properties = {}) => ({
  type: 'Feature',
  id,
  properties: { name: id, ...properties },
  geometry: { type: 'Point', coordinates: [lon, lat] },
});
// Layer tests use small polygons: Cesium draws a point's default pin on a
// canvas, which Node does not have.
const area = (id, lon, lat, properties = {}) => ({
  type: 'Feature',
  id,
  properties: { name: id, ...properties },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [lon, lat],
        [lon + 0.01, lat],
        [lon, lat + 0.01],
        [lon, lat],
      ],
    ],
  },
});

test('a payload may be a FeatureCollection, a bare array or JSON Lines', () => {
  const a = point('a', 145, -37);
  const b = point('b', 146, -38);
  const collection = JSON.stringify({
    type: 'FeatureCollection',
    features: [a, b],
  });
  assert.deepEqual(parseGeojsonFeatures(collection), [a, b]);
  assert.deepEqual(parseGeojsonFeatures(JSON.stringify([a, b])), [a, b]);
  const lines = `${JSON.stringify(a)}\n\n${JSON.stringify(b)}\n`;
  assert.deepEqual(parseGeojsonFeatures(lines), [a, b]);
  assert.deepEqual(parseGeojsonFeatures(JSON.stringify(a)), [a]);
  assert.deepEqual(parseGeojsonFeatures('  '), []);
});

test('card copy carries status and detail, and says when a record is held', () => {
  assert.deepEqual(
    vicOverlayCopy(
      { name: 'Mt Buller', status: 'Watch and Act', detail: '296 ha' },
      'local-pm-incident',
    ),
    { title: 'Mt Buller', details: ['Watch and Act', '296 ha'] },
  );
  // A status that repeats the title is dropped.
  assert.deepEqual(
    vicOverlayCopy({ name: 'Advice', status: 'advice' }, 'local-pm-warn-advice')
      .details,
    [],
  );
  assert.deepEqual(
    vicOverlayCopy(
      { name: 'X', gevStale: true, gevStaleForMs: 4 * 60000 },
      'local-pm-incident',
    ).details,
    ['NOT IN LAST UPDATE · 4 min'],
  );
  assert.equal(vicOverlayCopy({}, 'local-vicmap-lga').title, 'Boundary');
  assert.equal(
    vicOverlayCopy({}, 'local-vicmap-fire-station').title,
    'Feature',
  );
});

test('an exporter priority outranks the name heuristic', () => {
  assert.equal(vicLabelPriority({ name: 'A', priority: 12.5 }), 12.5);
  assert.equal(vicLabelPriority({ name: 'A' }), 1000);
  assert.equal(vicLabelPriority({}), 0);
});

test('geometry helpers find an anchor and every nested hole ring', () => {
  assert.deepEqual(
    firstCoordinateOf({
      coordinates: [
        [
          [1, 2],
          [3, 4],
        ],
      ],
    }),
    [1, 2],
  );
  assert.equal(firstCoordinateOf(null), null);
  const ring = (n) => ({ positions: Array.from({ length: n }, () => ({})) });
  const hierarchy = { holes: [{ ...ring(4), holes: [ring(3)] }, ring(2)] };
  assert.equal(collectHoleRings(hierarchy).length, 2);
});

test('a fixed URL is a snapshot; a resolver decides live at runtime', async () => {
  assert.deepEqual(await resolveLayerSource('/a.geojsonl'), {
    url: '/a.geojsonl',
    live: false,
  });
  assert.deepEqual(
    await resolveLayerSource(async () => ({ url: '/api/x', live: true })),
    { url: '/api/x', live: true },
  );
});

function harness(t, options) {
  const previousWindow = globalThis.window;
  const events = [];
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  const sources = new Set();
  const listeners = new Set();
  const event = {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const viewer = {
    selectedEntity: undefined,
    dataSources: {
      async add(source) {
        sources.add(source);
        return source;
      },
      remove(source) {
        return sources.delete(source);
      },
    },
    scene: { canvas: {}, preRender: event, requestRender() {} },
    camera: { moveEnd: event },
  };
  const layer = createVicGeoJsonLayer(
    {
      id: 'local-pm-incident',
      name: 'PM Incidents',
      color: '#00d1b2',
      screenSpaceEventHandlerFactory: () => ({
        setInputAction() {},
        destroy() {},
      }),
      ...options,
    },
    {
      ...localGeoJsonServices,
      overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    },
  );
  t.after(() => {
    layer.destroy(viewer);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  return { layer, viewer, sources, events };
}

const feed = (responses) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return {
      ok: true,
      text: async () =>
        JSON.stringify({ type: 'FeatureCollection', features: next }),
    };
  };
  return { calls, fetchImpl };
};

const contextFor = (layerId, name) =>
  [...getContextStore().entities.values()].find(
    (record) => record.layerId === layerId && record.properties?.name === name,
  );

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test('a snapshot loads once and never polls', async (t) => {
  const { calls, fetchImpl } = feed([
    [area('a', 145, -37), area('b', 146, -38)],
  ]);
  const env = harness(t, {
    url: '/snapshot.geojsonl',
    fetchImpl,
    refreshMs: 40,
  });
  await env.layer.enable(env.viewer);
  await tick();
  await env.layer.update(env.viewer);
  assert.equal(calls.length, 1);
  assert.equal(env.layer.getStats().count, 2);
  assert.equal(env.layer.isLive(), false);
  assert.equal(env.events.length, 1, 'enable announces its load');
});

test('a live poll holds a dropped feature, marked, and announces what arrived', async (t) => {
  const { calls, fetchImpl } = feed([
    [area('a', 145, -37), area('b', 146, -38)],
    [area('a', 145, -37), area('c', 147, -36)],
  ]);
  const env = harness(t, {
    url: async () => ({
      url: '/api/passive-monitor/geojson/pm-incident',
      live: true,
    }),
    liveSource: 'Passive Monitor · LIVE',
    fetchImpl,
    refreshMs: 40,
    retentionMs: 600_000,
  });
  await env.layer.enable(env.viewer);
  assert.equal(env.layer.source, 'Passive Monitor · LIVE');
  // The lifecycle's immediate post-enable update is deduped.
  await env.layer.update(env.viewer);
  assert.equal(calls.length, 1);

  await tick();
  await env.layer.update(env.viewer);
  assert.equal(calls.length, 2);
  assert.deepEqual(env.layer.getStats().count, 3);
  assert.equal(env.layer.getStats().retained, 1);
  assert.equal(env.sources.size, 1, 'the previous source is swapped out');
  assert.equal(contextFor('local-pm-incident', 'b').properties.gevStale, true);
  const announced = env.events
    .filter((event) => event.type === 'gev:layer-refreshed')
    .at(-1);
  assert.deepEqual(
    announced.detail.added.map((feature) => feature.properties.name),
    ['c'],
  );
});

test('a failed poll keeps the last good data and reports the failure', async (t) => {
  const { fetchImpl } = feed([
    [area('a', 145, -37)],
    new TypeError('fetch failed'),
  ]);
  const env = harness(t, {
    url: async () => ({ url: '/api/live', live: true }),
    fetchImpl,
    refreshMs: 40,
  });
  await env.layer.enable(env.viewer);
  const before = [...env.sources][0];
  await tick();
  await env.layer.update(env.viewer);
  assert.equal(env.layer.getStats().count, 1);
  assert.match(env.layer.getStats().error, /live update failed/);
  assert.equal([...env.sources][0], before);
});

test('an open selection follows its feature across a refresh', async (t) => {
  const { fetchImpl } = feed([
    [area('a', 145, -37, { status: 'Going' }), area('b', 146, -38)],
    [area('a', 145, -37, { status: 'Contained' }), area('b', 146, -38)],
  ]);
  const env = harness(t, {
    url: async () => ({ url: '/api/live', live: true }),
    fetchImpl,
    refreshMs: 40,
  });
  await env.layer.enable(env.viewer);
  const first = contextFor('local-pm-incident', 'a');
  env.viewer.selectedEntity = first.entity;
  getContextStore().selectedEntityId = first.id;
  await tick();
  await env.layer.update(env.viewer);
  const after = contextFor('local-pm-incident', 'a');
  assert.equal(after.id, first.id, 'the context id is stable across polls');
  assert.notEqual(after.entity, first.entity);
  assert.equal(env.viewer.selectedEntity, after.entity);
  assert.equal(getContextStore().selectedEntityId, first.id);
  assert.equal(after.properties.status, 'Contained');
  const reselected = env.events
    .filter((event) => event.type === 'gev:entity-selected')
    .at(-1);
  assert.equal(reselected.detail.properties.status, 'Contained');
});
