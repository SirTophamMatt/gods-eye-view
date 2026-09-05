/**
 * What is inside a warning area.
 *
 * A Watch and Act polygon on its own tells you a shape and a level. The
 * operational question underneath it is always the same — what is IN there —
 * and every layer needed to answer it is already loaded and already carries
 * coordinates. This counts them.
 *
 * WHAT IT CAN AND CANNOT SAY, because the difference decides how the copy must
 * read. It counts what the app has: records inside the ring, from the layers
 * that are switched on. It is not a population figure, not an asset register,
 * and not a risk assessment. A layer that is off contributes nothing and is
 * reported as OFF rather than as zero — "no fire stations in the warning area"
 * and "the stations layer isn't loaded" are opposite conclusions and must never
 * render the same way.
 *
 * Pure: no DOM, no Cesium, no network. Callers supply record groups; this
 * module only tests containment and counts.
 */

import { pointInPolygons } from '../data/pointInPolygon.js';

/** Examples named per group. Enough to recognise, short enough to read aloud. */
const MAX_EXAMPLES = 3;

/**
 * Mean Earth radius in km per degree of latitude. Longitude degrees shrink by
 * cos(latitude), which the area estimate below accounts for.
 */
const KM_PER_DEG = 111.32;

/**
 * The polygon rings of a feature, as `[outer, ...holes]` sets.
 *
 * MultiPolygons yield one entry per part, matching what `pointInPolygons`
 * expects, so a warning issued as several disjoint areas tests correctly rather
 * than only against its first part.
 *
 * @param {object} feature GeoJSON feature.
 * @returns {number[][][][]} Polygons, or an empty array when there are none.
 */
export function ringsOf(feature) {
  const geometry = feature?.geometry;
  const coords = geometry?.coordinates;
  if (!Array.isArray(coords)) return [];
  if (geometry.type === 'Polygon') return [coords];
  if (geometry.type === 'MultiPolygon') return coords;
  return [];
}

/**
 * Approximate area of a polygon feature, km².
 *
 * Shoelace on an equirectangular projection scaled at the ring's mean latitude.
 * Across a Victorian warning area — tens of kilometres, well under a degree of
 * latitude — the projection error is a fraction of a percent, far smaller than
 * the generalisation already in the published geometry. Holes are subtracted;
 * a warning drawn around an excluded township should not count it.
 *
 * @param {object} feature GeoJSON feature.
 * @returns {number|null} Area in km², or null when there is no polygon.
 */
export function approximateAreaKm2(feature) {
  const polygons = ringsOf(feature);
  if (polygons.length === 0) return null;

  let total = 0;
  for (const rings of polygons) {
    if (!Array.isArray(rings) || rings.length === 0) continue;
    rings.forEach((ring, index) => {
      const area = ringAreaKm2(ring);
      // Ring 0 is the outer boundary; the rest are holes cut out of it.
      total += index === 0 ? area : -area;
    });
  }
  return total > 0 ? total : null;
}

/** Unsigned area of one ring, km². */
function ringAreaKm2(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let latSum = 0;
  let n = 0;
  for (const point of ring) {
    if (Array.isArray(point) && Number.isFinite(point[1])) {
      latSum += point[1];
      n += 1;
    }
  }
  if (n === 0) return 0;
  const cosLat = Math.cos((latSum / n) * (Math.PI / 180));

  let shoelace = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[j];
    const b = ring[i];
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    if (![a[0], a[1], b[0], b[1]].every(Number.isFinite)) continue;
    shoelace += (a[0] * b[1]) - (b[0] * a[1]);
  }
  return Math.abs(shoelace / 2) * KM_PER_DEG * KM_PER_DEG * cosLat;
}

/**
 * Count each group's records that fall inside the feature's area.
 *
 * @param {object} feature The warning feature, carrying the polygon.
 * @param {{key: string, label: string, enabled?: boolean, records?: object[]}[]} groups
 *   One entry per layer. `enabled: false` reports the layer as off WITHOUT
 *   counting it — the distinction between "none in there" and "we did not look"
 *   is the whole reason this takes a flag rather than an empty array.
 * @returns {{areaKm2: number|null, total: number, groups: object[], hasArea: boolean}}
 */
export function summarizeInside(feature, groups) {
  const polygons = ringsOf(feature);
  const hasArea = polygons.length > 0;

  const out = (Array.isArray(groups) ? groups : []).map((group) => {
    const label = String(group?.label ?? group?.key ?? 'Layer');
    if (group?.enabled === false) {
      return { key: group?.key ?? label, label, enabled: false, count: 0, examples: [] };
    }
    if (!hasArea) {
      return { key: group?.key ?? label, label, enabled: true, count: 0, examples: [] };
    }

    const inside = [];
    for (const record of Array.isArray(group?.records) ? group.records : []) {
      const lat = Number(record?.lat ?? record?.latitude);
      const lon = Number(record?.lon ?? record?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (pointInPolygons(lon, lat, polygons)) inside.push(record);
    }

    return {
      key: group?.key ?? label,
      label,
      enabled: true,
      count: inside.length,
      examples: inside
        .map((r) => String(r?.name ?? r?.label ?? r?.callsign ?? '').trim())
        .filter(Boolean)
        .slice(0, MAX_EXAMPLES),
    };
  });

  return {
    areaKm2: approximateAreaKm2(feature),
    hasArea,
    total: out.reduce((sum, g) => sum + (g.enabled ? g.count : 0), 0),
    groups: out,
  };
}

/**
 * Area for display. Sub-100 km² keeps a decimal because that is the range where
 * the difference between 8.4 and 8.9 km² is worth reading; above it, the
 * generalisation in the published geometry makes a decimal false precision.
 *
 * @param {number|null} km2 Area.
 * @returns {string} e.g. "8.4 km²", "1,240 km²".
 */
export function formatAreaKm2(km2) {
  if (!Number.isFinite(km2) || km2 <= 0) return '';
  if (km2 < 100) return `${km2.toFixed(1)} km²`;
  return `${Math.round(km2).toLocaleString()} km²`;
}

/**
 * One line per group, for the dwell card.
 *
 * A group with nothing in it is still listed. "0 fire stations" inside an
 * Emergency Warning area is a finding, not an absence worth hiding — and a
 * layer that is off says so instead of reporting a zero it never measured.
 *
 * @param {object} summary Output of `summarizeInside`.
 * @returns {string[]} Display lines.
 */
export function summaryLines(summary) {
  return (summary?.groups || []).map((group) => {
    if (!group.enabled) return `${group.label}: layer off`;
    if (group.count === 0) return `${group.label}: none`;
    const examples = group.examples.length
      ? ` — ${group.examples.join(', ')}${group.count > group.examples.length ? '…' : ''}`
      : '';
    return `${group.label}: ${group.count}${examples}`;
  });
}
