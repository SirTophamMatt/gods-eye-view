#!/usr/bin/env node
/**
 * Export Vicmap Admin administrative boundaries into God's Eye View layers.
 *
 * Vicmap Admin (data.vic.gov.au, CC BY 4.0) is the state's authoritative
 * administrative-boundary product, published as a public ArcGIS FeatureServer.
 * It is the reference geometry the Passive Monitor hazard layers are implicitly
 * issued against: a total fire ban is declared for a TFB district, a warning is
 * escalated within an EMV region, a brigade responds inside a CFA district.
 * Drawing those units turns a scatter of hazard points into a picture of who
 * owns what.
 *
 * This is a SNAPSHOT exporter, like scripts/export-passive-monitor.mjs, and for
 * a stronger reason: boundaries are reference data, not live state. The upstream
 * refreshes weekly and almost always changes nothing, so paying a runtime
 * dependency on a state ArcGIS instance — on every page load, for geometry that
 * moves once a year — buys nothing. Re-run this script when a boundary actually
 * changes (council amalgamation, ward redistribution) and commit the result.
 *
 * The emitted property contract is the SAME normalized core the Passive Monitor
 * layers use, so `createLocalGeoJsonLayer` renders both with one code path:
 *
 *   name      display label ("Greater Shepparton City")
 *   status    what kind of unit this is ("Local government area")
 *   detail    one-line context ("LGA 328")
 *   priority  label importance — see MULTIPART SPLITTING below
 *   source    provenance string
 *
 * Usage:
 *   node scripts/export-vicmap-admin.mjs
 *   node scripts/export-vicmap-admin.mjs --tolerance 0.0005
 *   node scripts/export-vicmap-admin.mjs --only lga,cfa-tfb
 *
 * GENERALISATION. The server generalises for us via `maxAllowableOffset`, in
 * degrees. The default 0.001 (~110 m at this latitude) is chosen for how these
 * layers are actually looked at: reference furniture under a state-wide or
 * metro-wide camera, never a cadastral boundary you would survey to. It cuts
 * the LGA layer from tens of megabytes of full-resolution coastline to a few
 * hundred kilobytes. Lower it only if a specific layer visibly polygonises.
 *
 * MULTIPART SPLITTING. Cesium's GeoJsonDataSource already expands a
 * MultiPolygon into one entity per part, and every part inherits the parent's
 * properties — so an LGA with a dozen offshore islands would ask for a dozen
 * identical labels. This script splits multiparts itself instead, which is the
 * only place with the geometry in hand to score them: each part carries a
 * `priority` proportional to its share of the feature's area, so the mainland
 * body wins its collision cell and a sand island does not compete with it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchArcgisLayer, roundPoint } from './lib/vicmap-arcgis.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../src/data/local_data/vicmap-admin');

const SERVICE
  = 'https://services-ap1.arcgis.com/P744lA0wf4LlBZ84/arcgis/rest/services/Vicmap_Admin/FeatureServer';

const DEFAULT_TOLERANCE = 0.001;

const SOURCE = 'Vicmap Admin';

/** Words a title-cased boundary name leaves lowercase unless they lead it. */
const TITLE_CASE_MINOR_WORDS = new Set(['and', 'of', 'the', 'on', 'in', 'at', 'upon']);

/**
 * Title-case a SHOUTED source name, leaving already-mixed-case values alone.
 * Vicmap is inconsistent about this — `em_region` arrives as "Loddon Mallee"
 * while `delwp_region` arrives as "LODDON MALLEE" — and the label overlay is
 * hard to read in all caps.
 * @param {string} value Raw attribute value.
 * @returns {string} Display-cased name.
 */
function titleCase(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text !== text.toUpperCase()) return text; // already mixed case; trust it
  return text
    .toLowerCase()
    .replace(/[a-z][a-z']*/g, (word, offset) => (
      // "WEST AND SOUTH GIPPSLAND" reads wrong as "West And South Gippsland".
      // Never at offset 0: a district really can be named "The …".
      offset > 0 && TITLE_CASE_MINOR_WORDS.has(word)
        ? word
        : word[0].toUpperCase() + word.slice(1)
    ));
}

/**
 * The seven boundary layers this exporter publishes.
 *
 * `layer` is the FeatureServer layer id — NOT its position in the service's
 * layer list, which is not sorted. `name`/`status`/`detail` map raw Vicmap
 * attributes onto the shared property contract.
 */
const LAYERS = [
  {
    key: 'lga',
    layer: 9,
    title: 'Local Government Areas',
    // The property-aligned variant, not the topo-aligned twin at layer 10:
    // property alignment is what every other Victorian dataset keys against,
    // so an LGA drawn here matches an LGA named in a warning.
    name: (a) => titleCase(a.lga_official_name || a.lga_name),
    status: () => 'Local government area',
    detail: (a) => (a.lga_code ? `LGA ${a.lga_code}` : ''),
  },
  {
    key: 'cfa-district',
    layer: 3,
    title: 'CFA Districts',
    // `cfa_district` is a zero-padded code ("02"), not a name — the district
    // has no other identifier, so the number IS the label.
    name: (a) => {
      const code = String(a.cfa_district ?? '').trim().replace(/^0+/, '');
      return code ? `CFA District ${code}` : '';
    },
    status: () => 'CFA district',
    detail: () => '',
  },
  {
    key: 'cfa-tfb',
    layer: 1,
    title: 'CFA Total Fire Ban Districts',
    name: (a) => titleCase(a.tfb_district),
    status: () => 'Total fire ban district',
    detail: () => '',
  },
  {
    key: 'delwp-region',
    layer: 0,
    title: 'DELWP Regions',
    name: (a) => titleCase(a.delwp_region),
    status: () => 'DELWP region',
    detail: (a) => (a.delwp_region_code ? `Region ${a.delwp_region_code}` : ''),
  },
  {
    key: 'emv-region',
    layer: 4,
    title: 'Emergency Management Regions',
    name: (a) => titleCase(a.em_region),
    status: () => 'Emergency management region',
    detail: () => '',
  },
  {
    key: 'frv-district',
    layer: 6,
    title: 'FRV Districts',
    // District names repeat across the marine/land split ("Central" appears
    // twice), so the marine flag has to reach the label or the two are
    // indistinguishable on the globe.
    name: (a) => {
      const district = titleCase(a.district);
      if (!district) return '';
      return a.marine === 'Y' ? `FRV ${district} (Marine)` : `FRV ${district}`;
    },
    status: () => 'FRV district',
    detail: (a) => (a.marine === 'Y' ? 'Marine district' : ''),
  },
  {
    key: 'frv-response',
    layer: 8,
    title: 'FRV Response Area',
    // A single dissolved polygon: the whole FRV footprint. Its value is the
    // edge — everything outside it is CFA country.
    name: () => 'FRV Response Area',
    status: () => 'Fire Rescue Victoria response area',
    detail: () => '',
  },
];

function parseArgs(argv) {
  const args = { tolerance: DEFAULT_TOLERANCE, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--tolerance') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`--tolerance must be a non-negative number, got "${argv[i + 1]}"`);
      }
      args.tolerance = value;
      i += 1;
    } else if (argv[i] === '--only') {
      args.only = String(argv[i + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    }
  }
  return args;
}

function roundRing(ring) {
  return ring.map(roundPoint);
}

/**
 * Split a feature's geometry into single Polygon parts.
 * A Polygon is one part; a MultiPolygon is one part per member.
 * @param {object} geometry GeoJSON geometry.
 * @returns {number[][][][]} Array of polygons, each an array of rings.
 */
function polygonParts(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

/**
 * Twice the signed area of a ring, in square degrees.
 *
 * Unprojected and therefore not a real area — but this is only ever used to
 * RANK parts of the same feature against each other, over a state two degrees
 * of latitude tall, where the projection error is a near-constant factor that
 * cancels out of the ratio.
 * @param {number[][]} ring Closed or unclosed ring.
 * @returns {number} Absolute shoelace area.
 */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
  }
  return Math.abs(sum / 2);
}

/** A polygon's area net of its holes. */
function polygonArea(rings) {
  if (!rings.length) return 0;
  return rings.reduce(
    (total, ring, index) => (index === 0 ? ringArea(ring) : total - ringArea(ring)),
    0,
  );
}

/**
 * Turn one Vicmap feature into one output line per polygon part.
 * @param {object} feature Raw GeoJSON feature from ArcGIS.
 * @param {object} spec Layer spec from LAYERS.
 * @returns {object[]} Normalized single-Polygon features.
 */
function normalizeFeature(feature, spec) {
  const attrs = feature?.properties || {};
  const name = spec.name(attrs);
  if (!name) return []; // an unnamed boundary has nothing to say; drop it

  const parts = polygonParts(feature.geometry).filter((rings) => rings.length > 0);
  if (parts.length === 0) return [];

  const areas = parts.map(polygonArea);
  const largest = Math.max(...areas, 0);

  return parts.map((rings, index) => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: rings.map(roundRing) },
    properties: {
      name,
      status: spec.status(attrs),
      detail: spec.detail(attrs),
      // 1000 for the main body, scaled down for outliers. Integer so the
      // label arbiter's comparisons stay exact.
      priority: largest > 0 ? Math.round((areas[index] / largest) * 1000) : 1000,
      source: `${SOURCE} · ${spec.title}`,
    },
  }));
}

async function exportLayer(spec, tolerance) {
  const raw = await fetchArcgisLayer({
    service: SERVICE,
    layer: spec.layer,
    tolerance,
    onRetry: (message) => console.warn(`    ${message}`),
  });
  const features = raw.flatMap((feature) => normalizeFeature(feature, spec));
  const body = features.map((f) => JSON.stringify(f)).join('\n');
  const file = resolve(OUT_DIR, `vicmap-${spec.key}.geojsonl`);
  writeFileSync(file, features.length ? `${body}\n` : '', 'utf8');
  return { file, source: raw.length, written: features.length, bytes: Buffer.byteLength(body, 'utf8') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const specs = args.only
    ? LAYERS.filter((spec) => args.only.includes(spec.key))
    : LAYERS;
  if (specs.length === 0) {
    throw new Error(`--only matched no layers. Known keys: ${LAYERS.map((s) => s.key).join(', ')}`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Vicmap Admin → ${OUT_DIR}  (tolerance ${args.tolerance}°)`);

  let totalBytes = 0;
  for (const spec of specs) {
    const result = await exportLayer(spec, args.tolerance);
    totalBytes += result.bytes;
    const parts = result.written === result.source
      ? `${result.written}`
      : `${result.written} parts from ${result.source}`;
    console.log(
      `  ${spec.key.padEnd(14)} ${String(parts).padStart(22)}  ${(result.bytes / 1024).toFixed(0)} KB`,
    );
  }
  console.log(`  ${'total'.padEnd(14)} ${''.padStart(22)}  ${(totalBytes / 1024).toFixed(0)} KB`);
}

main().catch((error) => {
  console.error(`export-vicmap-admin failed: ${error.message}`);
  process.exitCode = 1;
});
