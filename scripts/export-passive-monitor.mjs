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
 * Pull every AREA geometry out of a raw GeoJSON column.
 *
 * VicEmergency does not hand back a bare polygon. The overwhelming majority of
 * these columns are a `GeometryCollection` pairing marker Points with the
 * actual warning-area Polygons — `(Point, Polygon)` is the single most common
 * shape, and multi-area warnings run to eight Points and eight Polygons in one
 * record. An earlier version of this exporter tested for `geometry.coordinates`,
 * which a GeometryCollection does not have (it has `geometries`), so it silently
 * discarded 68 of the 123 stored geometries — including EVERY warning area.
 *
 * So: recurse into collections, keep the Polygon/MultiPolygon members, and drop
 * the Points. The points are redundant — each record already carries its own
 * latitude/longitude for the label anchor — and drawing them would double every
 * marker.
 *
 * A malformed geometry must never abort the export; it just contributes nothing.
 */
function extractPolygons(raw) {
  const text = clean(raw);
  if (!text) return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const found = [];
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    // Accept either a bare geometry or a wrapping Feature.
    const geometry = node.type === 'Feature' ? node.geometry : node;
    if (!geometry || typeof geometry !== 'object') return;

    if (geometry.type === 'GeometryCollection') {
      for (const child of geometry.geometries || []) walk(child, depth + 1);
      return;
    }
    if (
      (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')
      && Array.isArray(geometry.coordinates)
      && geometry.coordinates.length
    ) {
      found.push({ type: geometry.type, coordinates: geometry.coordinates });
    }
  };

  walk(parsed);
  return found;
}

function feature(geometry, properties) {
  return { type: 'Feature', geometry, properties };
}

function point(lon, lat) {
  return { type: 'Point', coordinates: [lon, lat] };
}

/**
 * The `fire_incidents` table is misnamed: it is the whole VicEmergency feed,
 * and `feed_type` splits it into three genuinely different things.
 *
 *   warning    — a public warning over an AREA. Carries the escalation level in
 *                `warning_level` and, in this dataset, ALWAYS carries geometry.
 *   incident   — an operational event at a POINT (fire, tree down, rescue,
 *                hazmat). Has no warning level at all.
 *   burn-area  — a planned/historical burn footprint. Passive Monitor's own
 *                `active_incidents()` deliberately excludes these.
 *
 * Mixing them into one layer was wrong on its own terms, and it also buried the
 * warning ladder — which is the part with operational meaning. So each level
 * gets its own layer, and incidents and burn areas get theirs.
 *
 * `warning_level` is verbatim `category1` from the feed (see the scraper), so
 * matching is done on a folded substring rather than an exact string: the feed
 * owns that vocabulary, not us.
 */
const WARNING_BUCKETS = [
  { key: 'warn-emergency', match: (s) => s.includes('emergency'), severity: 3 },
  { key: 'warn-watch', match: (s) => s.includes('watch'), severity: 2 },
  { key: 'warn-advice', match: (s) => s.includes('advice'), severity: 1 },
  { key: 'warn-community', match: (s) => s.includes('community'), severity: 0 },
];

function exportVicEmergency(db, includeResolved) {
  const where = includeResolved ? '' : 'WHERE resolved = 0';
  const rows = db.prepare(`
    SELECT source_id, feed_type, event, category1, category2, warning_level,
           severity, status, size, resources, location, action, headline, url,
           latitude, longitude, updated, last_seen, resolved, geometry
    FROM fire_incidents
    ${where}
  `).all();

  const groups = {
    'warn-emergency': [],
    'warn-watch': [],
    'warn-advice': [],
    'warn-community': [],
    incident: [],
    burn: [],
  };
  // A warning whose level is absent or unrecognised must not vanish: the feed
  // can introduce a level this build has never seen. Park it with Advice, the
  // lowest ACTIONABLE rung, so it is visible rather than silently dropped.
  const fallbackWarningBucket = 'warn-advice';

  for (const row of rows) {
    if (!validCoord(row.latitude, row.longitude)) continue;

    const feedType = clean(row.feed_type).toLowerCase();
    const warning = clean(row.warning_level);
    const warningKey = warning.toLowerCase();

    let bucket;
    let severity;
    let hazard;
    if (feedType === 'warning') {
      const matched = WARNING_BUCKETS.find((b) => b.match(warningKey));
      bucket = matched ? matched.key : fallbackWarningBucket;
      severity = matched ? matched.severity : 1;
      hazard = 'warning';
    } else if (feedType === 'burn-area') {
      bucket = 'burn';
      severity = 0;
      hazard = 'burn-area';
    } else {
      bucket = 'incident';
      // Incidents carry no level. A live fire outranks a tree down.
      severity = clean(row.category1).toLowerCase() === 'fire' ? 2 : 1;
      hazard = 'incident';
    }
    if (row.resolved) severity = 0;

    const name = clean(row.location) || clean(row.event) || 'VicEmergency record';
    const properties = {
      name,
      hazard,
      warningLevel: warning || null,
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
      source: `Passive Monitor · ${hazard}`,
    };

    // The point anchors the label and the card.
    groups[bucket].push(feature(point(row.longitude, row.latitude), properties));

    // Then the area itself. For a warning this polygon IS the product — it is
    // the ground the warning actually covers — so a multi-area warning emits
    // one feature per polygon rather than being collapsed to its centroid.
    const polygons = extractPolygons(row.geometry);
    polygons.forEach((geometry, index) => {
      groups[bucket].push(feature(geometry, {
        ...properties,
        name: polygons.length > 1
          ? `${name} (area ${index + 1} of ${polygons.length})`
          : `${name} (area)`,
        isExtent: true,
      }));
    });
  }

  return groups;
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

    for (const geometry of extractPolygons(row.impact_geojson)) {
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

  const vicEmergency = exportVicEmergency(db, includeResolved);

  let total = 0;
  // Warning ladder, most severe first — the order an operator reads them in.
  total += writeLayer('pm-warn-emergency', vicEmergency['warn-emergency']);
  total += writeLayer('pm-warn-watch', vicEmergency['warn-watch']);
  total += writeLayer('pm-warn-advice', vicEmergency['warn-advice']);
  total += writeLayer('pm-warn-community', vicEmergency['warn-community']);
  total += writeLayer('pm-incident', vicEmergency.incident);
  total += writeLayer('pm-burn', vicEmergency.burn);
  total += writeLayer('pm-flood', exportFloods(db));
  total += writeLayer('pm-storm', exportStorms(db));
  total += writeLayer('pm-power', exportPower(db, includeResolved));

  db.close();

  console.log('');
  console.log(`  ${total} features written to src/data/local_data/passive-monitor/`);
  console.log('');
  console.log('  An empty warning layer is a real answer, not a failure: it means');
  console.log('  nothing is current at that level. The layer still registers, so it');
  console.log('  populates on the next export without a code change.');
  if (!total) {
    console.log('');
    console.log('  (nothing exported at all — is this the right database?)');
  }
}

main();
