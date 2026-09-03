import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REGISTERED_LAYER_IDS } from './layerState.js';

/**
 * Contract tests for the committed Vicmap Admin boundary snapshots.
 *
 * These files are produced by a script that talks to a live state ArcGIS
 * service (scripts/export-vicmap-admin.mjs), so the failure mode worth
 * guarding is a BAD EXPORT landing in the repo: a truncated page, an upstream
 * schema change that empties a name column, a tolerance typo that ships full-
 * resolution cadastre. None of those throw at runtime — they render as a
 * silently thinner layer — so the shape of the data is asserted here instead.
 *
 * They read the files rather than importing localLayers.js, which cannot load
 * outside Vite (its `?url` asset imports).
 */

const DIR = fileURLToPath(new URL('./local_data/vicmap-admin/', import.meta.url));

/** Every layer the exporter publishes, keyed by file, with its expected scale. */
const EXPECTED = new Map([
  ['vicmap-lga', { minParts: 80, maxParts: 200, minNames: 79 }],
  ['vicmap-cfa-district', { minParts: 21, maxParts: 120, minNames: 21 }],
  ['vicmap-cfa-tfb', { minParts: 9, maxParts: 60, minNames: 9 }],
  ['vicmap-delwp-region', { minParts: 6, maxParts: 60, minNames: 6 }],
  ['vicmap-emv-region', { minParts: 8, maxParts: 60, minNames: 8 }],
  ['vicmap-frv-district', { minParts: 11, maxParts: 120, minNames: 11 }],
  ['vicmap-frv-response', { minParts: 1, maxParts: 80, minNames: 1 }],
]);

/**
 * Victoria's extent with slack. Catches the two ways a query goes wrong
 * quietly: a missing `outSR=4326` (Web Mercator metres, off by 10^7) and a
 * dropped `where` clause pulling a neighbouring state's tiles.
 */
const VIC_BBOX = { west: 140.5, south: -39.5, east: 150.5, north: -33.5 };

function readLayer(key) {
  const text = readFileSync(`${DIR}${key}.geojsonl`, 'utf8').trim();
  assert.notEqual(text, '', `${key} is empty — the export produced no features`);
  return text.split('\n').map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${key} line ${index + 1} is not JSON: ${error.message}`);
    }
  });
}

test('every exported boundary layer is registered for share links', () => {
  const files = readdirSync(DIR)
    .filter((name) => name.endsWith('.geojsonl'))
    .map((name) => name.replace(/\.geojsonl$/, ''));

  assert.deepEqual(
    [...files].sort(),
    [...EXPECTED.keys()].sort(),
    'the committed files and the expectations above must not drift apart',
  );

  for (const key of files) {
    // vicmap-lga → local-vicmap-lga. A layer added to the exporter but not to
    // LAYER_STATE_REGISTRY throws at boot in finalizeRegistrations(); this
    // catches it at test time with the name of the layer that is missing.
    const layerId = `local-${key}`;
    assert.ok(
      REGISTERED_LAYER_IDS.includes(layerId),
      `${layerId} has a snapshot but no layer-state registry entry`,
    );
  }
});

test('boundary snapshots carry the shared property contract', () => {
  for (const [key, scale] of EXPECTED) {
    const features = readLayer(key);
    assert.ok(
      features.length >= scale.minParts && features.length <= scale.maxParts,
      `${key} has ${features.length} parts, outside the expected ${scale.minParts}–${scale.maxParts}`,
    );

    const names = new Set();
    for (const feature of features) {
      const props = feature.properties || {};
      assert.equal(feature.type, 'Feature', `${key}: every line is a Feature`);
      assert.ok(props.name, `${key}: every boundary is named`);
      assert.ok(props.status, `${key}: every boundary states what kind of unit it is`);
      assert.ok(
        Number.isInteger(props.priority) && props.priority >= 0 && props.priority <= 1000,
        `${key}: ${props.name} has priority ${props.priority}, outside 0–1000`,
      );
      assert.match(props.source, /^Vicmap Admin · /, `${key}: provenance is carried per feature`);
      names.add(props.name);
    }

    assert.ok(
      names.size >= scale.minNames,
      `${key} names only ${names.size} distinct boundaries, expected at least ${scale.minNames}`,
    );
  }
});

test('boundary geometry is closed, single-part, and inside Victoria', () => {
  for (const key of EXPECTED.keys()) {
    for (const feature of readLayer(key)) {
      const { type, coordinates } = feature.geometry || {};
      // Single-part deliberately: the exporter splits multiparts so each part
      // can carry its own label priority. A MultiPolygon here means that split
      // regressed and a council's islands are competing with its mainland.
      assert.equal(type, 'Polygon', `${key}: ${feature.properties.name} must be a single part`);
      assert.ok(coordinates.length >= 1, `${key}: ${feature.properties.name} has no rings`);

      for (const ring of coordinates) {
        assert.ok(ring.length >= 4, `${key}: a ring needs at least 4 positions`);
        assert.deepEqual(
          ring[0],
          ring[ring.length - 1],
          `${key}: ${feature.properties.name} has an unclosed ring`,
        );
        for (const [lon, lat] of ring) {
          assert.ok(
            lon >= VIC_BBOX.west && lon <= VIC_BBOX.east
              && lat >= VIC_BBOX.south && lat <= VIC_BBOX.north,
            `${key}: ${feature.properties.name} has a vertex at ${lon},${lat} outside Victoria`,
          );
        }
      }
    }
  }
});

test('boundary snapshots stay generalised enough to bundle', () => {
  // The whole set exists to be shipped in the build. Full-resolution Vicmap
  // coastline is tens of megabytes; the committed export is ~1.6 MB. A blown
  // budget here means someone re-ran the exporter with a smaller --tolerance
  // and did not notice what it cost.
  let bytes = 0;
  for (const key of EXPECTED.keys()) {
    bytes += Buffer.byteLength(readFileSync(`${DIR}${key}.geojsonl`, 'utf8'), 'utf8');
  }
  const megabytes = bytes / 1024 / 1024;
  assert.ok(megabytes < 4, `boundary snapshots total ${megabytes.toFixed(1)} MB, over the 4 MB budget`);
});
