/**
 * The response timeline: turnout standard, then Code 1 drive, then a marker
 * for where the clock actually is.
 *
 * Two sections per brigade, because they are two different kinds of quantity
 * and blending them into one "response time" hides which half is doing the
 * work:
 *
 *   SDS      the Service Delivery Standard turnout time (`turnoutStandard.js`).
 *            A published planning figure — what the service stands to.
 *   TURNOUT  the Code 1 drive from the station (`code1Response.js`), re-timed
 *            from a real road route under a stated priority-speed model.
 *
 * The section names follow the operator's vocabulary rather than the strict
 * fire-service one, in which "turnout" is the getting-out-the-door half and
 * "travel" is the drive. Anyone reading this chart uses the former.
 *
 * WHAT THE MARKER MEANS, precisely, because it is the part most easily
 * over-read: it is elapsed time since the incident was created, laid over a
 * plan built from standards and a modelled drive. It says where an appliance
 * SHOULD be if everything went to the standard. It is not a position report,
 * it is not fed by any AVL or dispatch feed, and a brigade may be well ahead
 * of it or nowhere near it.
 */

import { formatClock } from './turnoutStandard.js';

const WIDTH = 320;
const HEADER_H = 15;
const ROW_H = 21;
const NAME_BASELINE = 8;
const BAR_Y = 11;
const BAR_H = 8;
const AXIS_H = 15;

/** Tick spacings, seconds. The first that yields <= 8 ticks wins. */
const TICK_STEPS = [30, 60, 120, 300, 600, 1200, 1800];

/**
 * Resolve a Passive Monitor timestamp to an instant.
 *
 * `passiveMonitorDetail.js` renders these strings verbatim and refuses to
 * parse them, on the grounds that guessing a zone would silently shift an
 * emergency timestamp. That rule is about DISPLAY, and it is right: a printed
 * time that has been quietly moved is worse than an unformatted one.
 *
 * A timeline cannot show elapsed time without an instant, so this parses —
 * but never silently. Two cases, and the caller is told which one it got:
 *
 *   zoned    the string carries `Z` or `±hh:mm`. No guess is involved.
 *   assumed  a bare "2026-09-01 23:56:31" is read as Australia/Melbourne wall
 *            time. Every source feeding this panel is Victorian — Passive
 *            Monitor, VicEmergency, CFA, FRV — so that is the assumption a
 *            reader would make themselves, and the chart says it is being
 *            made. The offset comes from the platform tz database rather than
 *            a hardcoded +10/+11, so it is right across the DST boundary.
 *
 * @param {string} value Raw timestamp.
 * @param {string} [timeZone] Zone assumed for a bare wall time.
 * @returns {{ms: number, zoned: boolean}|null} Instant, or null when unusable.
 */
export function parseIncidentTime(value, timeZone = 'Australia/Melbourne') {
  const text = String(value ?? '').trim();
  if (!text) return null;

  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? { ms, zoned: true } : null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;

  // Treat the wall clock as if it were UTC, then subtract whatever offset the
  // zone was actually running at that moment. Applied twice because the first
  // pass looks the offset up at the wrong instant, which only matters within
  // an hour of a DST transition — exactly where a single pass lands an hour out.
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  let ms = asUtc - zoneOffsetMs(asUtc, timeZone);
  ms = asUtc - zoneOffsetMs(ms, timeZone);
  return Number.isFinite(ms) ? { ms, zoned: false } : null;
}

/**
 * How far ahead of UTC a zone was at an instant, in milliseconds.
 * @param {number} ms Instant.
 * @param {string} timeZone IANA zone.
 * @returns {number} Offset, 0 when the zone is unknown to the runtime.
 */
function zoneOffsetMs(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms));
    const at = {};
    for (const part of parts) at[part.type] = part.value;
    const local = Date.UTC(+at.year, +at.month - 1, +at.day, +at.hour, +at.minute, +at.second);
    return local - ms;
  } catch {
    return 0;
  }
}

/**
 * Where one appliance should be at `elapsedS`, under its own plan.
 *
 * @param {number|null} elapsedS Seconds since the incident was created.
 * @param {number|null} sdsS Turnout standard.
 * @param {number|null} totalS Turnout plus drive.
 * @returns {'pending'|'turning-out'|'on-road'|'due'|null} Status, null when unknowable.
 */
export function rowStatus(elapsedS, sdsS, totalS) {
  if (!Number.isFinite(elapsedS)) return null;
  if (!Number.isFinite(totalS)) return null;
  if (elapsedS >= totalS) return 'due';
  if (!Number.isFinite(sdsS)) return 'on-road';
  return elapsedS < sdsS ? 'turning-out' : 'on-road';
}

/** Human wording for a status. */
export const STATUS_LABEL = Object.freeze({
  'turning-out': 'turning out',
  'on-road': 'on the road',
  due: 'due on scene',
  pending: 'pending',
});

/**
 * Build the timeline model for a set of stations.
 *
 * Rows carry nulls through rather than substituting zeros. A station with no
 * route has no drive section and no total, and the chart draws it as an
 * unfinished bar — which is what "we could not route this one" looks like.
 * A zero would draw as an instant arrival.
 *
 * @param {object[]} stations Stations with `sds` and optionally `code1S`.
 * @param {object} [options]
 * @param {number|null} [options.incidentMs] Incident creation instant.
 * @param {number} [options.nowMs] Clock, injectable for tests.
 * @returns {object} Model for `responseTimelineChart`.
 */
export function buildTimeline(stations, { incidentMs = null, nowMs = Date.now() } = {}) {
  const rows = (Array.isArray(stations) ? stations : []).map((station, index) => {
    const sdsS = Number.isFinite(station?.sds?.seconds) ? station.sds.seconds : null;
    const travelS = Number.isFinite(station?.code1S) ? station.code1S : null;
    const totalS = (sdsS !== null && travelS !== null) ? sdsS + travelS : null;
    return {
      rank: index + 1,
      name: String(station?.name ?? '').trim() || 'Unnamed station',
      agency: station?.agency ?? null,
      sdsS,
      travelS,
      totalS,
      sdsLabel: String(station?.sds?.label ?? ''),
      travelBasis: station?.code1Basis ?? null,
    };
  });

  const elapsedS = Number.isFinite(incidentMs) ? Math.max(0, (nowMs - incidentMs) / 1000) : null;

  // The scale is the PLAN's own span, not the elapsed clock. On a job that has
  // been running for three hours an elapsed-driven scale would squash every
  // bar into a sliver at the left edge to make room for empty space — so the
  // marker clamps to the right edge instead and the caption carries the real
  // figure. Once everything is due, precise placement past the end adds nothing.
  const totals = rows.map((row) => row.totalS).filter(Number.isFinite);
  const partials = rows.map((row) => row.sdsS).filter(Number.isFinite);
  const scaleS = Math.max(60, ...totals, ...partials);

  return {
    rows,
    scaleS,
    elapsedS,
    elapsedClamped: elapsedS !== null && elapsedS > scaleS,
    incidentKnown: elapsedS !== null,
  };
}

/** Tick spacing that keeps the axis under nine labels. */
export function tickStep(scaleS) {
  for (const step of TICK_STEPS) {
    if (scaleS / step <= 8) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Clip a station name to what fits the label column.
 *
 * Character-counted rather than measured: the panel is monospaced, so a count
 * is exact here and a measurement would need a live DOM the chart builder
 * does not have.
 */
function clipName(name, limit = 30) {
  const text = String(name ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * Render the model as an inline SVG.
 *
 * Colours come from CSS custom properties with literal fallbacks, matching
 * `floodGaugeChart`: the panel owns the palette, and the fallback keeps the
 * chart legible if the stylesheet is ever loaded without them.
 *
 * @param {object} model Output of `buildTimeline`.
 * @returns {string} SVG markup, or '' when there is nothing to draw.
 */
export function responseTimelineChart(model) {
  const rows = model?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return '';

  const scaleS = Number(model.scaleS) || 60;
  const x = (seconds) => Math.max(0, Math.min(1, seconds / scaleS)) * WIDTH;
  const height = HEADER_H + (rows.length * ROW_H) + AXIS_H;
  const plotTop = HEADER_H;
  const plotBottom = HEADER_H + (rows.length * ROW_H);

  const bars = rows.map((row, index) => {
    const top = HEADER_H + (index * ROW_H);
    const status = rowStatus(model.elapsedS, row.sdsS, row.totalS);

    const sdsWidth = row.sdsS === null ? 0 : x(row.sdsS);
    const travelStart = sdsWidth;
    const travelWidth = row.totalS === null ? 0 : Math.max(0, x(row.totalS) - travelStart);

    const track = `<rect x="0" y="${top + BAR_Y}" width="${WIDTH}" height="${BAR_H}" `
      + `fill="currentColor" fill-opacity="0.07" rx="1"/>`;

    const sds = sdsWidth > 0
      ? `<rect x="0" y="${top + BAR_Y}" width="${sdsWidth.toFixed(1)}" height="${BAR_H}" `
        + `fill="var(--rt-sds, #e6c700)" fill-opacity="0.75" rx="1"><title>SDS turnout `
        + `${esc(formatClock(row.sdsS))} — ${esc(row.sdsLabel)}</title></rect>`
      : '';

    const travel = travelWidth > 0
      ? `<rect x="${travelStart.toFixed(1)}" y="${top + BAR_Y}" width="${travelWidth.toFixed(1)}" `
        + `height="${BAR_H}" fill="var(--rt-travel, #4aa3df)" fill-opacity="0.75" rx="1">`
        + `<title>Code 1 turnout ${esc(formatClock(row.travelS))}</title></rect>`
      : '';

    // An unrouted station gets a hatched stub past its SDS block rather than
    // nothing: the reader can see the brigade was found and that its drive is
    // the missing piece, which a bare gap would not distinguish from a bug.
    const unrouted = (row.totalS === null && row.sdsS !== null)
      ? `<rect x="${travelStart.toFixed(1)}" y="${top + BAR_Y}" width="16" height="${BAR_H}" `
        + `fill="currentColor" fill-opacity="0.18" rx="1"><title>No road route — drive time `
        + `unavailable</title></rect>`
      : '';

    const arrival = row.totalS === null ? '—' : formatClock(row.totalS);
    const statusMark = status === 'due' ? ' ✓' : '';

    return {
      rects: `${track}${sds}${travel}${unrouted}`,
      text: `<text x="0" y="${top + NAME_BASELINE}" class="rt-name">`
        + `${esc(row.rank)}. ${esc(clipName(row.name))}</text>`
        + `<text x="${WIDTH}" y="${top + NAME_BASELINE}" class="rt-total" text-anchor="end">`
        + `${esc(arrival)}${statusMark}</text>`,
    };
  });

  const step = tickStep(scaleS);
  let ticks = '';
  for (let seconds = step; seconds <= scaleS; seconds += step) {
    const tx = x(seconds);
    ticks += `<line x1="${tx.toFixed(1)}" y1="${plotTop}" x2="${tx.toFixed(1)}" `
      + `y2="${plotBottom}" stroke="currentColor" stroke-opacity="0.12" stroke-width="1"/>`
      + `<text x="${tx.toFixed(1)}" y="${plotBottom + 11}" class="rt-tick" text-anchor="middle">`
      + `${esc(formatClock(seconds))}</text>`;
  }

  let markerLine = '';
  let markerLabel = '';
  if (model.incidentKnown) {
    const mx = x(model.elapsedS);
    const anchor = mx > WIDTH * 0.72 ? 'end' : 'start';
    const labelX = anchor === 'end' ? mx - 4 : mx + 4;
    const label = model.elapsedClamped
      ? `T+${formatClock(model.elapsedS)} (past)`
      : `T+${formatClock(model.elapsedS)}`;
    markerLine = `<line x1="${mx.toFixed(1)}" y1="${plotTop - 4}" x2="${mx.toFixed(1)}" `
      + `y2="${plotBottom + 2}" stroke="var(--pm-detail-accent, #fff)" stroke-width="1.5"/>`;
    markerLabel = `<text x="${labelX.toFixed(1)}" y="${plotTop - 6}" class="rt-now" `
      + `text-anchor="${anchor}">${esc(label)}</text>`;
  }

  // Paint order is load-bearing. The marker has to cross the BARS to be read
  // against them, and must not cross the station NAMES — drawn last, a single
  // full-height line struck through every name in the list. So: bars, then the
  // line over them, then the text over the line.
  return `<svg class="rt-chart" viewBox="0 0 ${WIDTH} ${height}" role="img" `
    + `aria-label="Response timeline: turnout standard then Code 1 drive for `
    + `${rows.length} station${rows.length === 1 ? '' : 's'}">`
    + `${bars.map((bar) => bar.rects).join('')}${ticks}${markerLine}`
    + `${bars.map((bar) => bar.text).join('')}${markerLabel}</svg>`;
}
