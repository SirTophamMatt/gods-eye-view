/**
 * Flood-gauge context for the detail panel.
 *
 * A gauge reading on its own says almost nothing: "4.07 m" is alarming or
 * unremarkable entirely depending on where that river's minor, moderate and
 * major levels sit. Passive Monitor knows those thresholds and already puts
 * them in the record; this turns them into something you can read at a glance
 * — which band the gauge is in, and how much headroom is left before the next
 * one.
 *
 * TWO SOURCES FOR THE SAME NUMBERS, deliberately. The committed snapshot
 * carries the thresholds only inside the composed `detail` string
 * ("4.07 m · steady · Avoca Catchment · minor 4 / mod 5.9 / maj 7.5"), so they
 * are parsed back out of it. `scripts/export-passive-monitor.mjs` now also
 * emits them as structured fields, which are preferred where present. Parsing
 * a string a sibling script composed is not ideal, but it is bounded and it is
 * what makes this work against data already in the repo rather than only after
 * someone re-runs an exporter against a database they may not have.
 *
 * WHY THIS IS NOT A TIME SERIES. `flood_observations` upstream IS one — the
 * exporter takes only `MAX(timestamp)` per station — so a trace of the last
 * few days is available in principle and is not drawn here. That would need a
 * history export, which needs the Passive Monitor database, so shipping a
 * series renderer now would mean shipping a code path nothing in this repo can
 * exercise. This draws the half that the committed data actually supports, and
 * it is the half that answers the first question anyway: not "what has this
 * gauge been doing" but "how close is it to the next threshold". The trend
 * word (rising / falling / steady) carries the direction in the meantime.
 */

/** Bands, in ascending order. Colours match Passive Monitor's warning palette. */
export const FLOOD_BANDS = Object.freeze([
  { key: 'below', label: 'Below', color: '#2ea8ff' },
  { key: 'minor', label: 'Minor', color: '#e6c700' },
  { key: 'moderate', label: 'Moderate', color: '#ff7f0e' },
  { key: 'major', label: 'Major', color: '#d62728' },
]);

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Pull a threshold out of the composed detail string.
 * @param {string} detail Composed detail line.
 * @param {RegExp} pattern Capture-group-1 pattern.
 * @returns {number|null}
 */
function fromDetail(detail, pattern) {
  const match = String(detail || '').match(pattern);
  return match ? number(match[1]) : null;
}

/**
 * Gauge height, thresholds and trend, from structured fields where the
 * exporter supplied them and from `detail` where it did not.
 *
 * @param {object} props Flood feature properties.
 * @returns {{heightM: number|null, minorM: number|null, moderateM: number|null,
 *   majorM: number|null, trend: string|null}}
 */
export function floodLevels(props) {
  const detail = String(props?.detail || '');
  const trendMatch = detail.match(/\b(rising|falling|steady)\b/i);
  return {
    heightM: number(props?.heightM),
    minorM: number(props?.minorM) ?? fromDetail(detail, /minor\s+([\d.]+)/i),
    moderateM: number(props?.moderateM) ?? fromDetail(detail, /\bmod(?:erate)?\s+([\d.]+)/i),
    majorM: number(props?.majorM) ?? fromDetail(detail, /\bmaj(?:or)?\s+([\d.]+)/i),
    trend: String(props?.tendency || '').trim().toLowerCase()
      || (trendMatch ? trendMatch[1].toLowerCase() : null),
  };
}

/**
 * Which band a height falls in.
 * @param {number|null} heightM Gauge height.
 * @param {object} levels Thresholds from `floodLevels`.
 * @returns {object|null} A FLOOD_BANDS entry, or null when unclassifiable.
 */
export function floodBand(heightM, levels) {
  if (!Number.isFinite(heightM)) return null;
  if (Number.isFinite(levels?.majorM) && heightM >= levels.majorM) return FLOOD_BANDS[3];
  if (Number.isFinite(levels?.moderateM) && heightM >= levels.moderateM) return FLOOD_BANDS[2];
  if (Number.isFinite(levels?.minorM) && heightM >= levels.minorM) return FLOOD_BANDS[1];
  return FLOOD_BANDS[0];
}

/** Escape for interpolation into SVG/HTML. */
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const WIDTH = 300;
const HEIGHT = 74;
const PAD_X = 6;
const TRACK_Y = 34;
const TRACK_H = 14;

/**
 * Upper bound of the chart's scale.
 *
 * Headroom above whichever is higher — the major threshold or the current
 * reading — so a gauge ABOVE major still shows its marker inside the track
 * rather than clipped against the right edge, which is exactly the case where
 * the reader most needs to see how far past it is.
 *
 * @param {number|null} heightM Current height.
 * @param {object} levels Thresholds.
 * @returns {number} Scale maximum in metres.
 */
export function floodScaleMax(heightM, levels) {
  const candidates = [levels?.majorM, levels?.moderateM, levels?.minorM, heightM]
    .map(number)
    .filter((n) => n !== null);
  if (candidates.length === 0) return 1;
  return Math.max(...candidates) * 1.15;
}

/**
 * A compact level chart: banded track, threshold ticks, current-height marker.
 *
 * Returns '' unless the gauge has at least one THRESHOLD, which is a stricter
 * bar than "has a reading" and deliberately so. 204 of the 319 gauges in the
 * committed snapshot carry a height and no flood levels at all, and a chart
 * drawn from a height alone is actively misleading: the scale would be derived
 * from that same height, planting the marker near the right-hand end of the
 * track for every one of them. A perfectly ordinary river would look like it
 * was about to break its banks. Without levels there is no context to draw,
 * and the height row below already states the reading.
 *
 * @param {object} props Flood feature properties.
 * @returns {string} SVG markup, or ''.
 */
export function floodGaugeChart(props) {
  const levels = floodLevels(props);
  const { heightM } = levels;
  const hasThreshold = [levels.minorM, levels.moderateM, levels.majorM]
    .some((n) => Number.isFinite(n));
  if (!hasThreshold) return '';

  const max = floodScaleMax(heightM, levels);
  const trackW = WIDTH - (PAD_X * 2);
  const x = (m) => PAD_X + Math.max(0, Math.min(1, m / max)) * trackW;

  // Band segments, each starting where the previous threshold sits. A missing
  // threshold collapses its segment rather than shifting the ones above it.
  const stops = [
    { from: 0, to: levels.minorM ?? max, color: FLOOD_BANDS[0].color },
    { from: levels.minorM, to: levels.moderateM ?? max, color: FLOOD_BANDS[1].color },
    { from: levels.moderateM, to: levels.majorM ?? max, color: FLOOD_BANDS[2].color },
    { from: levels.majorM, to: max, color: FLOOD_BANDS[3].color },
  ];
  const bands = stops
    .filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to > s.from)
    .map((s) => `<rect x="${x(s.from).toFixed(1)}" y="${TRACK_Y}" `
      + `width="${Math.max(0, x(s.to) - x(s.from)).toFixed(1)}" height="${TRACK_H}" `
      + `fill="${s.color}" fill-opacity="0.28"/>`)
    .join('');

  const ticks = [
    { m: levels.minorM, label: 'Minor' },
    { m: levels.moderateM, label: 'Mod' },
    { m: levels.majorM, label: 'Maj' },
  ]
    .filter((t) => Number.isFinite(t.m))
    .map((t) => {
      const tx = x(t.m);
      return `<line x1="${tx.toFixed(1)}" y1="${TRACK_Y - 3}" x2="${tx.toFixed(1)}" `
        + `y2="${TRACK_Y + TRACK_H + 3}" stroke="currentColor" stroke-opacity="0.45" stroke-width="1"/>`
        + `<text x="${tx.toFixed(1)}" y="${TRACK_Y + TRACK_H + 15}" class="fg-tick" `
        + `text-anchor="middle">${esc(t.label)} ${esc(t.m)}</text>`;
    })
    .join('');

  let marker = '';
  if (Number.isFinite(heightM)) {
    const mx = x(heightM);
    const band = floodBand(heightM, levels);
    const trend = levels.trend ? ` ${levels.trend}` : '';
    // The reading is anchored to whichever side keeps it on the canvas.
    const anchor = mx > WIDTH * 0.7 ? 'end' : 'start';
    const labelX = anchor === 'end' ? mx - 5 : mx + 5;
    marker = `<line x1="${mx.toFixed(1)}" y1="${TRACK_Y - 8}" x2="${mx.toFixed(1)}" `
      + `y2="${TRACK_Y + TRACK_H + 8}" stroke="${band.color}" stroke-width="2"/>`
      + `<text x="${labelX.toFixed(1)}" y="${TRACK_Y - 12}" class="fg-reading" `
      + `text-anchor="${anchor}" fill="${band.color}">${esc(heightM.toFixed(2))} m${esc(trend)}</text>`;
  }

  return `<svg class="fg-chart" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" `
    + `aria-label="Flood gauge level against its minor, moderate and major thresholds">`
    + `<rect x="${PAD_X}" y="${TRACK_Y}" width="${trackW}" height="${TRACK_H}" `
    + `fill="currentColor" fill-opacity="0.08"/>`
    + `${bands}${ticks}${marker}</svg>`;
}
