#!/usr/bin/env node
/**
 * Export Passive Monitor's georeferenced state into God's Eye View layers.
 *
 * Passive Monitor (github.com/SirTophamMatt/PassiveMotintor) polls Victorian
 * emergency sources — CFA/FRV fire incidents, BoM flood gauges, radar-derived
 * storm cells, distributor power outages — into a SQLite database in which
 * nearly every table already carries `latitude` / `longitude`, and the fire and
 * storm tables additionally carry raw GeoJSON geometry. That makes the database
 * a spatial product that has simply never been drawn on a globe.
 *
 * This script reads that database READ-ONLY and writes one `.geojsonl` file per
 * hazard into `src/data/local_data/passive-monitor/`, which the existing local
 * layer registry (`src/data/localLayers.js`) already knows how to render.
 *
 * It is a SNAPSHOT exporter, deliberately. The point of phase one is to find out
 * whether the data reads as a useful intelligence product when it is spatial;
 * committing a snapshot answers that without standing up any live plumbing. The
 * emitted property contract is the same one a future live
 * `/api/intel/geojson` endpoint should serve, so the layer code does not change
 * when the source is swapped.
 *
 * Usage:
 *   node scripts/export-passive-monitor.mjs --db "<path to unified_monitor.db>"
 *   node scripts/export-passive-monitor.mjs --db <path> --include-resolved
 *
 * Every feature carries a normalized core so one renderer can style them all:
 *   name      display label
 *   hazard    fire | flood | storm | power
 *   severity  3 critical · 2 major · 1 notable · 0 background
 *   status    short human state ("Watch and Act", "Minor flooding")
 *   detail    one-line context ("296 ha · 12 resources")
 *   ts        ISO-ish source timestamp
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../src/data/local_data/passive-monitor');

function parseArgs(argv) {
  const args = { db: null, includeResolved: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db') {
      args.db = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--include-resolved') {
      args.includeResolved = true;
    }
  }
  return args;
}

/** Victoria's bounding box, with slack. Guards against 0/0 and swapped pairs. */
function validCoord(lat, lon) {
  return (
    Number.isFinite(lat)
    && Number.isFinite(lon)
    && lat >= -90 && lat <= 90
    && lon >= -180 && lon <= 180
    && !(lat === 0 && lon === 0)
  );
}

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** Join non-empty parts with a middot, dropping duplicates. */
function detailLine(parts) {
  const seen = new Set();
  return parts
    .map(clean)
    .filter((part) => {
      if (!part || seen.has(part.toLowerCase())) return false;
      seen.add(part.toLowerCase());
      return true;
    })
    .join(' · ');
}

/**
 * Parse a geometry column that holds raw GeoJSON. Passive Monitor stores these
 * verbatim from the upstream feed, so a malformed one must not abort the export.
 */
function parseGeometry(raw) {
  const text = clean(raw);
  if (!text) return null;
  try {
    const geo = JSON.parse(text);
    if (!geo || typeof geo !== 'object') return null;
    // Accept either a bare geometry or a wrapping Feature.
    const geometry = geo.type === 'Feature' ? geo.geometry : geo;
    if (!geometry || !geometry.type || !geometry.coordinates) return null;
    return geometry;
  } catch {
    return null;
  }
}

function feature(geometry, properties) {
  return { type: 'Feature', geometry, properties };
}

function point(lon, lat) {
  return { type: 'Point', coordinates: [lon, lat] };
}

/**
 * Fire incidents. `warning_level` is the operational escalation ladder, so it
 * drives severity ahead of the free-text `severity` column, which upstream
 * populates inconsistently.
 */
function exportFires(db, includeResolved) {
  const where = includeResolved ? '' : 'WHERE resolved = 0';
  const rows = db.prepare(`
    SELECT source_id, event, category1, warning_level, severity, status, size,
           resources, location, action, headline, url, latitude, longitude,
           updated, last_seen, resolved, geometry
    FROM fire_incidents
    ${where}
  `).all();

  const out = [];
  for (const row of rows) {
    if (!validCoord(row.latitude, row.longitude)) continue;

    const warning = clean(row.warning_level);
    const warningKey = warning.toLowerCase();
    let severity = 1;
    if (warningKey.includes('emergency')) severity = 3;
    else if (warningKey.includes('watch')) severity = 2;
    else if (warningKey.includes('advice')) severity = 1;
    else severity = 0;
    if (row.resolved) severity = 0;

    const name = clean(row.location) || clean(row.event) || 'Fire incident';
    const properties = {
      name,
      hazard: 'fire',
      severity,
      status: warning || clean(row.status) || clean(row.event),
      detail: detailLine([
        clean(row.event),
        clean(row.size),
        row.resources ? `${row.resources} resources` : '',
        clean(row.action),
      ]),
      headline: clean(row.headline),
      category: clean(row.category1),
      resolved: Boolean(row.resolved),
      ts: clean(row.updated) || clean(row.last_seen),
      url: clean(row.url),
      source: 'Passive Monitor · fire',
    };

    // The point is the anchor the label and card hang off. Where the feed also
    // gave a fire-ground polygon, emit it as a second feature so the extent
    // draws too — a 300 ha fire should not read as a dot.
    out.push(feature(point(row.longitude, row.latitude), properties));

    const geometry = parseGeometry(row.geometry);
    if (geometry && geometry.type !== 'Point') {
      out.push(feature(geometry, {
        ...properties,
        name: `${name} (extent)`,
        isExtent: true,
      }));
    }
  }
  return out;
}

/**
 * Flood gauges: the latest observation per station, positioned by the
 * `gauge_coords` table Passive Monitor builds from BoM Water Data Online
 * (the flood feed itself carries no coordinates).
 *
 * `station_key` is a lowercased `station_name`, so the join is on the folded
 * name — matching on the raw name alone loses gauges to casing drift.
 */
function exportFloods(db) {
  const rows = db.prepare(`
    SELECT fo.station_name, fo.catchment, fo.height_m, fo.tendency,
           fo.classification, fo.time_day, fo.timestamp,
           gc.latitude, gc.longitude,
           fl.minor, fl.moderate, fl.major
    FROM flood_observations fo
    JOIN gauge_coords gc
      ON gc.station_key = lower(fo.station_name)
    LEFT JOIN flood_levels fl
      ON fl.station_key = gc.station_key
    JOIN (
      SELECT station_name, MAX(timestamp) AS newest
      FROM flood_observations
      GROUP BY station_name
    ) latest
      ON latest.station_name = fo.station_name
     AND latest.newest = fo.timestamp
    GROUP BY fo.station_name
  `).all();

  const out = [];
  for (const row of rows) {
    if (!validCoord(row.latitude, row.longitude)) continue;

    const classification = clean(row.classification);
    const key = classification.toLowerCase();
    let severity = 0;
    if (key.includes('major')) severity = 3;
    else if (key.includes('moderate')) severity = 2;
    else if (key.includes('minor')) severity = 1;

    const height = Number.isFinite(row.height_m) ? `${row.height_m.toFixed(2)} m` : '';
    const thresholds = [
      Number.isFinite(row.minor) ? `minor ${row.minor}` : '',
      Number.isFinite(row.moderate) ? `mod ${row.moderate}` : '',
      Number.isFinite(row.major) ? `maj ${row.major}` : '',
    ].filter(Boolean).join(' / ');

    out.push(feature(point(row.longitude, row.latitude), {
      name: clean(row.station_name) || 'Flood gauge',
      hazard: 'flood',
      severity,
      status: classification || 'Below flood level',
      detail: detailLine([
        height,
        clean(row.tendency),
        clean(row.catchment),
        thresholds,
      ]),
      heightM: Number.isFinite(row.height_m) ? row.height_m : null,
      catchment: clean(row.catchment),
      ts: clean(row.timestamp) || clean(row.time_day),
      source: 'Passive Monitor · flood',
    }));
  }
  return out;
}

/**
 * Storm cells from the most recent radar frame only. Earlier frames are the
 * same cells at earlier positions; drawing all of them would render each storm
 * as a smear of duplicates rather than a current position.
 */
function exportStorms(db) {
  const newest = db.prepare('SELECT MAX(frame_ts) AS ts FROM storm_cells').get();
  if (!newest || !newest.ts) return [];

  const rows = db.prepare(`
    SELECT cell_id, radar_id, frame_ts, latitude, longitude, area_km2,
           max_level, mean_level, intensity_score, classification,
           speed_kmh, bearing_deg, status, impact_geojson
    FROM storm_cells
    WHERE frame_ts = ?
  `).all(newest.ts);

  const out = [];
  for (const row of rows) {
    if (!validCoord(row.latitude, row.longitude)) continue;

    const classification = clean(row.classification);
    const key = classification.toLowerCase();
    let severity = 0;
    if (key.includes('severe') || key.includes('intense')) severity = 3;
    else if (key.includes('strong')) severity = 2;
    else if (key.includes('moderate')) severity = 1;
    // Radar reflectivity backs up a missing or unfamiliar classification.
    if (!severity && Number.isFinite(row.max_level)) {
      if (row.max_level >= 12) severity = 3;
      else if (row.max_level >= 9) severity = 2;
      else if (row.max_level >= 6) severity = 1;
    }

    const motion = Number.isFinite(row.speed_kmh) && row.speed_kmh > 0
      ? `${Math.round(row.speed_kmh)} km/h${
        Number.isFinite(row.bearing_deg) ? ` @ ${Math.round(row.bearing_deg)}°` : ''}`
      : '';

    const properties = {
      name: `Storm cell ${clean(row.cell_id) || '—'}`,
      hazard: 'storm',
      severity,
      status: classification || `Level ${row.max_level ?? '—'}`,
      detail: detailLine([
        Number.isFinite(row.area_km2) ? `${Math.round(row.area_km2)} km²` : '',
        motion,
        clean(row.radar_id) ? `radar ${clean(row.radar_id)}` : '',
      ]),
      areaKm2: Number.isFinite(row.area_km2) ? row.area_km2 : null,
      ts: clean(row.frame_ts),
      source: 'Passive Monitor · storm',
    };

    out.push(feature(point(row.longitude, row.latitude), properties));

    const geometry = parseGeometry(row.impact_geojson);
    if (geometry && geometry.type !== 'Point') {
      out.push(feature(geometry, {
        ...properties,
        name: `${properties.name} (impact area)`,
        isExtent: true,
      }));
    }
  }
  return out;
}

/**
 * Power outages, positioned through Passive Monitor's own geocode cache. The
 * outage table stores a place name only, so an outage with no cached geocode
 * simply has no location to draw and is skipped.
 */
function exportPower(db, includeResolved) {
  const where = includeResolved ? '' : 'WHERE po.restored = 0';
  const rows = db.prepare(`
    SELECT po.location, po.customers_off, po.type, po.first_seen, po.last_seen,
           po.restored, po.duration_mins, gc.latitude, gc.longitude
    FROM power_outages po
    JOIN geocode_cache gc ON gc.location = po.location
    ${where}
  `).all();

  const out = [];
  for (const row of rows) {
    if (!validCoord(row.latitude, row.longitude)) continue;

    const customers = Number.isFinite(row.customers_off) ? row.customers_off : 0;
    let severity = 0;
    if (customers >= 2000) severity = 3;
    else if (customers >= 500) severity = 2;
    else if (customers >= 100) severity = 1;
    if (row.restored) severity = 0;

    const duration = Number.isFinite(row.duration_mins) && row.duration_mins > 0
      ? `${Math.round(row.duration_mins / 60)} h out`
      : '';

    out.push(feature(point(row.longitude, row.latitude), {
      name: clean(row.location) || 'Outage',
      hazard: 'power',
      severity,
      status: row.restored ? 'Restored' : `${customers.toLocaleString()} customers off`,
      detail: detailLine([clean(row.type), duration]),
      customersOff: customers,
      resolved: Boolean(row.restored),
      ts: clean(row.last_seen) || clean(row.first_seen),
      source: 'Passive Monitor · power',
    }));
  }
  return out;
}

function writeLayer(name, features) {
  const file = resolve(OUT_DIR, `${name}.geojsonl`);
  // GeoJSON Lines: one Feature per line, which is what localGeojson.js streams.
  const body = features.map((f) => JSON.stringify(f)).join('\n');
  writeFileSync(file, body ? `${body}\n` : '', 'utf8');
  const points = features.filter((f) => f.geometry.type === 'Point').length;
  const shapes = features.length - points;
  console.log(
    `  ${name.padEnd(22)} ${String(features.length).padStart(5)} features`
    + ` (${points} point${shapes ? `, ${shapes} extent` : ''})`,
  );
  return features.length;
}

function main() {
  const { db: dbPath, includeResolved } = parseArgs(process.argv.slice(2));
  if (!dbPath) {
    console.error('error: --db <path to unified_monitor.db> is required');
    console.error('usage: node scripts/export-passive-monitor.mjs --db <path> [--include-resolved]');
    process.exit(1);
  }

  let db;
  try {
    db = new DatabaseSync(resolve(dbPath), { readOnly: true });
  } catch (error) {
    console.error(`error: cannot open database at ${dbPath}`);
    console.error(`  ${error.message}`);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Passive Monitor → God's Eye View`);
  console.log(`  source: ${resolve(dbPath)}`);
  console.log(`  scope:  ${includeResolved ? 'all records' : 'active records only'}`);
  console.log('');

  let total = 0;
  total += writeLayer('pm-fire', exportFires(db, includeResolved));
  total += writeLayer('pm-flood', exportFloods(db));
  total += writeLayer('pm-storm', exportStorms(db));
  total += writeLayer('pm-power', exportPower(db, includeResolved));

  db.close();

  console.log('');
  console.log(`  ${total} features written to src/data/local_data/passive-monitor/`);
  if (!total) {
    console.log('  (nothing exported — is this the right database?)');
  }
}

main();
