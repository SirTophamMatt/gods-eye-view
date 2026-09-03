#!/usr/bin/env node
/**
 * Export Victorian fire stations into a God's Eye View layer.
 *
 * Source is Vicmap Features of Interest (data.vic.gov.au, CC BY 4.0), the
 * state's authoritative gazetteer of named places and facilities. Its FOI_POINT
 * layer carries every emergency facility in Victoria under a `feature_type` of
 * "emergency facility", of which `feature_subtype = 'fire station'` is 1,727
 * points — essentially the whole CFA and FRV station network.
 *
 * Why a separate script from export-vicmap-admin.mjs: different service,
 * different geometry, different presentation. The boundaries are polygons that
 * needed a whole new render mode; these are points, which the local-layer
 * loader has drawn since the datacenters layer. They share only the transport,
 * which is `lib/vicmap-arcgis.mjs`.
 *
 * Usage:
 *   node scripts/export-vicmap-emergency.mjs
 *
 * WHAT THIS IS NOT. A station is a building, not a dispatch. Victoria turns out
 * brigades by response area and turnout agreement, not by proximity — which is
 * what the CFA district and FRV response area boundary layers encode. A layer
 * of stations answers "what is near this fire"; it does not answer "who is
 * coming". Keep that distinction in any UI built on top of it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchArcgisLayer, roundPoint } from './lib/vicmap-arcgis.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../src/data/local_data/vicmap-emergency');

const SERVICE
  = 'https://services-ap1.arcgis.com/P744lA0wf4LlBZ84/arcgis/rest/services/Vicmap_Features_of_Interest/FeatureServer';

/** FOI_POINT — every named point feature in the gazetteer. */
const FOI_POINT_LAYER = 1;

/**
 * Only `fire station`, deliberately narrow.
 *
 * The subtype vocabulary also holds `fire lookout` (a tower, unstaffed, not a
 * responding unit) and `fire station (forest industry)` (private plantation
 * depots, not part of the public network). Both would inflate the count and
 * neither is a brigade, so a "nearest station" answer that included them would
 * be quietly wrong in the bush — which is exactly where it matters.
 */
const WHERE = "feature_subtype = 'fire station'";

const SOURCE = 'Vicmap Features of Interest';

/**
 * Records whose name is a placeholder rather than a station.
 *
 * The gazetteer carries a handful of rows like "FIRE SERVICES INFRASTRUCTURE -
 * MINIMAL" with a null `auth_org_code` — an administrative marker, not a
 * building anyone responds from. They are dropped by name because that is the
 * field that actually distinguishes them; `auth_org_code` is null on some
 * genuine stations too, so filtering on it would take real ones with it.
 */
const PLACEHOLDER_NAME = /^fire services infrastructure\b/i;

/** Title-case a SHOUTED gazetteer name, leaving mixed-case values alone. */
function titleCase(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text !== text.toUpperCase()) return text;
  return text.toLowerCase().replace(/[a-z][a-z']*/g, (word, offset) => (
    offset > 0 && TITLE_CASE_MINOR_WORDS.has(word)
      ? word
      : word[0].toUpperCase() + word.slice(1)
  ));
}

const TITLE_CASE_MINOR_WORDS = new Set(['and', 'of', 'the', 'on', 'in', 'at', 'upon']);

/**
 * Station name for display.
 *
 * `name_label` is the gazetteer's own display casing ("Plenty Fire Station")
 * and is preferred; `name` is the SHOUTED key and is title-cased as a fallback.
 * The trailing "Fire Station" is kept rather than stripped — on a globe already
 * showing hazards, "Plenty" alone does not read as a brigade.
 *
 * @param {object} attrs Raw FOI attributes.
 * @returns {string} Display name, or '' when the record has none.
 */
function stationName(attrs) {
  const label = String(attrs.name_label ?? '').trim();
  const name = titleCase(attrs.name);
  const chosen = label || name;
  if (!chosen || PLACEHOLDER_NAME.test(chosen)) return '';
  return chosen;
}

/**
 * Turn one FOI point into the shared local-layer property contract.
 * @param {object} feature Raw GeoJSON feature from ArcGIS.
 * @returns {object[]} Zero or one normalized feature.
 */
function normalizeFeature(feature) {
  const attrs = feature?.properties || {};
  const name = stationName(attrs);
  if (!name) return [];

  const coordinates = feature?.geometry?.coordinates;
  // A gazetteer row with no point is meaningless here and would land at 0,0 —
  // in the Atlantic — as the nearest station to everything in the west of the
  // state if it survived into a proximity search.
  if (!Array.isArray(coordinates) || !Number.isFinite(Number(coordinates[0]))
    || !Number.isFinite(Number(coordinates[1]))) return [];

  // Vicmap's gazetteer covers the border overlap, so a quarter of these are
  // NOT Victorian: 334 NSW and 102 SA against 1,289 VIC on the last run. They
  // are KEPT, because cross-border response is real — a fire at Nelson or
  // Mallacoota may genuinely be closest to an SA or NSW brigade, and mutual
  // aid exists — but the state has to travel with them. Without it the
  // FRV/CFA classifier, which is a Victorian instrument, would confidently
  // label a NSW Rural Fire Brigade as CFA.
  const state = String(attrs.state ?? '').trim().toUpperCase() || null;

  return [{
    type: 'Feature',
    geometry: { type: 'Point', coordinates: roundPoint(coordinates) },
    properties: {
      name,
      status: 'Fire station',
      detail: '',
      state,
      source: `${SOURCE} · Fire Stations`,
    },
  }];
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Vicmap fire stations → ${OUT_DIR}`);

  const raw = await fetchArcgisLayer({
    service: SERVICE,
    layer: FOI_POINT_LAYER,
    where: WHERE,
    onRetry: (message) => console.warn(`    ${message}`),
  });
  const features = raw.flatMap(normalizeFeature);
  const body = features.map((f) => JSON.stringify(f)).join('\n');
  const file = resolve(OUT_DIR, 'vicmap-fire-station.geojsonl');
  writeFileSync(file, features.length ? `${body}\n` : '', 'utf8');

  const dropped = raw.length - features.length;
  console.log(
    `  fire-station   ${String(features.length).padStart(5)} stations`
    + `${dropped ? ` (${dropped} placeholder/geometryless dropped)` : ''}`
    + `  ${(Buffer.byteLength(body, 'utf8') / 1024).toFixed(0)} KB`,
  );

  // Printed every run so the border overlap stays visible. A silent shift in
  // the VIC:NSW:SA mix means the upstream filter changed under us.
  const byState = new Map();
  for (const f of features) {
    const key = f.properties.state || 'unknown';
    byState.set(key, (byState.get(key) || 0) + 1);
  }
  const mix = [...byState].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
  console.log(`  by state       ${mix}`);
}

main().catch((error) => {
  console.error(`export-vicmap-emergency failed: ${error.message}`);
  process.exitCode = 1;
});
