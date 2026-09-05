/**
 * Passive Monitor detail panel.
 *
 * The ambient card that floats beside a PM marker is deliberately tiny — it has
 * to survive dozens of neighbours without becoming a wall of text, so it shows
 * a title and one clamped line. That is the right trade for scanning, and the
 * wrong one the moment you want to READ a warning: "DAMAGING WIND GUSTS of up
 * to 100 km/h remain possible about the alpine ranges…" is not a label.
 *
 * So clicking a PM feature opens this: a larger, scrollable panel carrying the
 * whole record. It listens on the same `gev:entity-selected` event the local
 * layers already dispatch through the context store, which means no change to
 * the pick path — a PM feature was already publishing everything needed here.
 *
 * Scope is limited to `local-pm-*` layers on purpose. Every other layer has its
 * own readout surface, and a second panel competing for the same click would be
 * a regression for them.
 *
 * On the text ceiling: VicEmergency truncates `webHeadline` at ~305 characters
 * in the feed itself, so the fullest text available anywhere in this pipeline is
 * what you see here. Where the record carries a `url`, the panel links out to
 * the authoritative warning rather than pretending the excerpt is complete.
 */

import { formatDistanceKm } from './nearestStations.js';
import { formatMinutes } from './code1Response.js';
import { floodGaugeChart } from './floodGauge.js';
import { agencyLabel, agencyShort } from './stationAgency.js';
import { formatClock } from './turnoutStandard.js';
import { DEFAULT_PLAN_ID, plansFor, resolvePlan, stationCount } from './responsePlan.js';
import {
  STATUS_LABEL,
  buildTimeline,
  parseIncidentTime,
  responseTimelineChart,
  rowStatus,
} from './responseTimeline.js';

const PANEL_ID = 'pm-detail-panel';
const LAYER_PREFIX = 'local-pm-';

/**
 * Hazards for which "nearest fire stations" is a sensible thing to ask.
 *
 * An allow-list of the fire-adjacent hazards rather than a deny-list of the
 * rest: a new hazard type should arrive WITHOUT the button until someone
 * decides it belongs, which is the safe direction. A flood gauge, a power
 * outage, a radar cell and a BoM district product all get nothing — a brigade
 * distance beside a river height is noise pretending to be intelligence.
 *
 * `incident` covers rescues as well as fires, and that is deliberate: CFA
 * brigades do road rescue, so the nearest stations are relevant there too.
 */
const BRIGADE_HAZARDS = new Set(['incident', 'burn-area', 'warning']);

/**
 * How often the elapsed marker is redrawn, ms.
 *
 * Ten seconds, not one: the chart's finest tick is 30 seconds wide and the
 * marker moves about a pixel a second on a typical scale, so a per-second
 * redraw would burn a timer on sub-pixel motion nobody can see.
 */
const TIMELINE_TICK_MS = 10000;

/** How many brigades get pins and routes on the globe, however many are listed. */
const MAX_DRAWN_BRIGADES = 10;

/**
 * Owner tag on every mark this panel draws.
 *
 * It is what lets the routes be removed on their own — when the reader asks,
 * when a different incident is opened, or when the panel closes — without
 * touching marks the voice model drew, which are documented as accumulating on
 * purpose and would previously have been wiped along with them.
 */
const BRIGADE_MARK_GROUP = 'pm-brigade-response';

/**
 * Severity accent, matching Passive Monitor's own warning palette
 * (app/modules/fire/data.py) so a level reads the same colour in both products.
 */
const SEVERITY_ACCENT = Object.freeze({
  3: '#d62728',
  2: '#ff7f0e',
  1: '#e6c700',
  0: '#9aa0a6',
});

const SEVERITY_LABEL = Object.freeze({
  3: 'CRITICAL',
  2: 'MAJOR',
  1: 'NOTABLE',
  0: 'BACKGROUND',
});

let _panel = null;
let _selectedHandler = null;
let _clearedHandler = null;
let _keyHandler = null;

/**
 * Injected collaborators for the brigade action, so this module keeps its
 * only-a-renderer shape and the tests need neither a globe nor a network.
 * `main.js` never sets these — the defaults below are the real path.
 */
let _findNearest = null;
let _inFrvArea = null;
let _annotations = () => window.__gevAnnotations || null;

/**
 * The live-marker timer for the open panel.
 *
 * Module-scoped rather than per-render because there is only ever one panel:
 * a second render (a different record, or a re-run at a new response size)
 * must stop the previous timer or the two fight over the same node.
 */
let _timelineTimer = null;

/**
 * Resolve the station lookup, importing it on first use.
 *
 * Dynamic rather than a top-level import for two reasons. It keeps the
 * gazetteer's module (and its bundled asset URL) out of the path every page
 * load walks, when most sessions never click this button. And it keeps THIS
 * module free of Vite-only `?url` syntax, so the panel logic is loadable — and
 * therefore testable — under plain Node.
 */
async function findNearest(origin, count) {
  if (_findNearest) return _findNearest(origin, count);
  const { nearestBrigades } = await import('./brigadeResponse.js');
  return nearestBrigades(origin, count);
}

/**
 * Whether the incident is on FRV ground, for the response-size menu.
 *
 * Same dynamic-import reasoning as `findNearest`, and the same degradation:
 * null means the boundary did not resolve, and the menu falls back to the one
 * option that needs no agency vocabulary.
 */
async function inFrvArea(origin) {
  if (_inFrvArea) return _inFrvArea(origin);
  try {
    const { incidentInFrvArea } = await import('./brigadeResponse.js');
    return await incidentInFrvArea(origin);
  } catch {
    return null;
  }
}

/** Swap the brigade-action collaborators. Tests only. */
export function _setBrigadeDepsForTest({
  findNearest: find,
  inFrvArea: frv,
  annotations,
} = {}) {
  _findNearest = find || null;
  _inFrvArea = frv || null;
  _annotations = annotations || (() => window.__gevAnnotations || null);
}

/**
 * Whether this record should offer the nearest-brigades action.
 * @param {object} props Unwrapped feature properties.
 * @param {object} record Context-store record (carries the position).
 * @returns {boolean}
 */
export function offersBrigadeAction(props, record) {
  if (!BRIGADE_HAZARDS.has(text(props?.hazard))) return false;
  // No position, no proximity question. Warning EXTENT features can arrive
  // without a usable centroid, and a button that silently does nothing is
  // worse than no button.
  return Number.isFinite(record?.latitude) && Number.isFinite(record?.longitude);
}

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** Build one label/value row, skipped entirely when the value is empty. */
function row(label, value) {
  const content = text(value);
  if (!content) return '';
  return `
    <div class="pm-detail-row">
      <span class="pm-detail-label">${escapeHtml(label)}</span>
      <span class="pm-detail-value">${escapeHtml(content)}</span>
    </div>`;
}

/**
 * Escape before interpolation. Every string here originates in an upstream
 * emergency feed, not in this codebase — treat it as untrusted text, never as
 * markup.
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) links are rendered, so a feed cannot inject a javascript: URL. */
function safeUrl(value) {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Timestamps arrive as Passive Monitor wrote them ("2026-09-01 23:56:31"),
 * which is server-local wall time with no zone. Rendered verbatim rather than
 * parsed: guessing a zone would silently shift an emergency timestamp, and a
 * wrong time is worse than an unformatted one.
 */
function formatTimestamp(value) {
  return text(value);
}

/**
 * The line shown on a record the feed has stopped listing.
 *
 * Says what is actually known — it was in an earlier poll and is not in the
 * latest — and explicitly does NOT say the incident closed. The feed offers no
 * way to tell a closed job from a missed poll, so claiming either would be
 * inventing the half that matters.
 *
 * @param {object} props Unwrapped feature properties.
 * @returns {string} Note text.
 */
export function staleNote(props) {
  const ms = Number(props?.gevStaleForMs);
  const minutes = Number.isFinite(ms) ? Math.max(1, Math.round(ms / 60000)) : null;
  const since = minutes === null ? '' : ` for ${minutes} min`;
  return `NOT IN LAST UPDATE — this record was in an earlier poll but not the`
    + ` most recent one${since}. It may have closed, or the poll may have missed`
    + ` it; the feed does not say which. It stops being drawn 10 min after it`
    + ` was last seen.`;
}

function ensurePanel() {
  if (_panel && document.body.contains(_panel)) return _panel;
  const el = document.createElement('div');
  el.id = PANEL_ID;
  el.className = 'pm-detail-panel';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Passive Monitor record detail');
  el.setAttribute('aria-live', 'polite');
  el.tabIndex = -1;
  el.hidden = true;
  document.body.appendChild(el);
  _panel = el;
  return el;
}

/**
 * Render one context record.
 * @param {object} record Context-store record from `gev:entity-selected`.
 * @returns {boolean} True when the record was ours and the panel is showing.
 */
export function renderPassiveMonitorDetail(record) {
  const layerId = text(record?.layerId);
  if (!layerId.startsWith(LAYER_PREFIX)) return false;

  const props = record?.properties || {};
  const panel = ensurePanel();

  const severity = Number.isFinite(Number(props.severity)) ? Number(props.severity) : 0;
  const accent = SEVERITY_ACCENT[severity] || SEVERITY_ACCENT[0];
  const severityLabel = SEVERITY_LABEL[severity] || SEVERITY_LABEL[0];

  // The extent features repeat their parent's name with an "(area n of m)"
  // suffix. Strip it for the title: the reader clicked a warning, not a ring.
  const rawName = text(props.name) || text(record.label) || 'Passive Monitor record';
  const title = rawName.replace(/\s*\((?:area\b[^)]*)\)\s*$/i, '');

  const headline = text(props.headline);
  const url = safeUrl(props.url);

  // Only flood gauges get a chart. "4.07 m" means nothing without the levels
  // that river floods at, and everything with them — which band it is in, and
  // how much headroom is left. Every other hazard's numbers are already
  // self-describing in the rows below.
  const gaugeChart = text(props.hazard) === 'flood'
    ? floodGaugeChart(props)
    : '';

  // `detail` is built from the headline's first line when a record has no
  // structured fields of its own, so for BoM products it restates text already
  // shown in full directly above. Drop the row rather than print it twice.
  const detail = text(props.detail);
  const detailRedundant = Boolean(
    detail && headline && headline.replace(/\s+/g, ' ').startsWith(detail.replace(/[…]$/, '').replace(/\s+/g, ' ')),
  );
  const coords = (Number.isFinite(record?.latitude) && Number.isFinite(record?.longitude))
    ? `${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)}`
    : '';

  // A new record replaces the whole panel body, taking the timeline node with
  // it. Stop the ticker first or it keeps firing against a detached element.
  stopTimelineTicker();
  panel.style.setProperty('--pm-detail-accent', accent);
  panel.innerHTML = `
    <div class="pm-detail-inner">
      <div class="pm-detail-head">
        <div class="pm-detail-headline-group">
          <div class="pm-detail-kicker">
            <span class="pm-detail-sev">${escapeHtml(severityLabel)}</span>
            <span class="pm-detail-layer">${escapeHtml(text(record.layerName) || layerId)}</span>
          </div>
          <h2 class="pm-detail-title">${escapeHtml(title)}</h2>
        </div>
        <button type="button" class="pm-detail-close" aria-label="Close detail panel">&#x2715;</button>
      </div>

      <div class="pm-detail-body">
        ${props.warningLevel ? `<div class="pm-detail-badge">${escapeHtml(text(props.warningLevel))}</div>` : ''}
        ${headline ? `<p class="pm-detail-text">${escapeHtml(headline)}</p>` : ''}
        ${gaugeChart}

        <div class="pm-detail-rows">
          ${row('Status', props.status)}
          ${detailRedundant ? '' : row('Detail', detail)}
          ${row('Category', props.category)}
          ${row('Hazard', props.hazard)}
          ${row('Catchment', props.catchment)}
          ${row('Gauge height', props.heightM === null || props.heightM === undefined ? '' : `${props.heightM} m`)}
          ${row('Customers off', props.customersOff ? Number(props.customersOff).toLocaleString() : '')}
          ${row('Area', props.areaKm2 ? `${Math.round(Number(props.areaKm2))} km²` : '')}
          ${row('Closure', props.isClosure === true ? 'Road closed' : '')}
          ${row('Resolved', props.resolved === true ? 'Yes' : '')}
          ${row('Updated', formatTimestamp(props.ts))}
          ${row('Position', coords)}
          ${row('Source', props.source)}
        </div>

        ${props.gevStale ? `<p class="pm-detail-note pm-detail-stale">${escapeHtml(staleNote(props))}</p>` : ''}

        ${offersBrigadeAction(props, record) ? `
        <div class="pm-detail-actions">
          <button type="button" class="pm-detail-action" data-action="brigades">Response timeline</button>
        </div>
        <div class="pm-detail-brigades" hidden></div>` : ''}

        ${url ? `<a class="pm-detail-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open full warning &#x2197;</a>` : ''}
        ${headline.endsWith('...') || headline.endsWith('…')
          ? '<p class="pm-detail-note">Text truncated by the VicEmergency feed at source.</p>'
          : ''}
      </div>
    </div>`;

  panel.hidden = false;
  panel.querySelector('.pm-detail-close')?.addEventListener('click', hidePassiveMonitorDetail);
  panel.querySelector('[data-action="brigades"]')?.addEventListener('click', (event) => {
    showNearestBrigades(panel, {
      latitude: record.latitude,
      longitude: record.longitude,
    }, event.currentTarget, { incidentTime: props.ts });
  });
  return true;
}

/**
 * The one sentence under every result.
 *
 * It has to carry the two things that make the numbers above it smaller than
 * they look — this is a drive, not a response, and nearest is not who is
 * dispatched — in a line short enough that people actually read it.
 */
const BRIGADE_DISCLAIMER = 'SDS is the turnout STANDARD (FRV 1:30, CFA 4:00 in '
  + 'Districts 7/8/13/14, 8:00 elsewhere), not a prediction of what a brigade '
  + 'achieves. Turnout is a modelled Code 1 drive. The marker is where an '
  + 'appliance should be if everything ran to standard — not a position report. '
  + 'Nearest is not dispatched: Victoria turns out by response area, not proximity.';

/**
 * Headline figure for one station: Code 1 travel time where routing resolved,
 * straight-line distance where it did not.
 *
 * Never both. They are different quantities measured along different paths,
 * and a row reading "3 min · 4.9 km" invites the reader to divide one by the
 * other and get a speed that was never driven.
 *
 * @param {object} station Station with `distanceKm` and optional `code1S`.
 * @returns {string} Display figure.
 */
export function brigadeTime(station) {
  if (Number.isFinite(station?.code1S)) return formatMinutes(station.code1S);
  return formatDistanceKm(station?.distanceKm);
}

/**
 * Context line: how far by road, and whose station it is.
 *
 * The road distance is worth printing beside a time even though the time is
 * derived from it — it is what tells a reader the ordering they are looking at
 * (which is straight-line) is not the ordering the roads produce.
 *
 * @param {object} station Station record.
 * @returns {string} Sub-line, possibly empty.
 */
export function brigadeSubline(station) {
  const parts = [];
  if (Number.isFinite(station?.roadDistanceM)) {
    parts.push(`${formatDistanceKm(station.roadDistanceM / 1000)} by road`);
  } else if (Number.isFinite(station?.code1S)) {
    // A time with no road distance means the model ran on the route average.
    parts.push(`${formatDistanceKm(station?.distanceKm)} direct`);
  }
  const agency = agencyLabel(station?.agency);
  if (agency) parts.push(agency);
  // The standard names its own basis ("CFA D8 metro standard"), which is what
  // makes a 4:00 block legible next to an 8:00 one two rows down.
  if (Number.isFinite(station?.sds?.seconds)) {
    parts.push(`SDS ${formatClock(station.sds.seconds)}`);
  }
  return parts.join(' · ');
}

/**
 * Label for one brigade line on the globe.
 *
 * Says "Code 1" explicitly rather than "drive". The engine's own suffix, which
 * this replaces, said "4 min drive" — and an unqualified travel time beside a
 * fire will be read as a response time by anyone who does not know how it was
 * computed. Naming the model is what stops that.
 *
 * @param {object} station Station record.
 * @returns {string} Line label.
 */
export function brigadeLineLabel(station) {
  const parts = [station?.name || 'Fire station'];
  if (Number.isFinite(station?.code1S)) {
    parts.push(`${formatMinutes(station.code1S)} Code 1`);
  } else if (Number.isFinite(station?.distanceKm)) {
    parts.push(formatDistanceKm(station.distanceKm));
  }
  // Short code, and no road distance: the engine clamps a label at 80
  // characters, and "Hampton Park Satellite Fire Station (Lynbrook)" spends 45
  // of them before any metrics — the full form truncated mid-word to
  // "CFA (li". The panel has room for both and keeps them.
  const agency = agencyShort(station?.agency);
  if (agency) parts.push(agency);
  return parts.join(' · ');
}

/**
 * Fade this panel's brigade marks off the globe.
 *
 * Scoped to `BRIGADE_MARK_GROUP`, so a user's voice annotations survive it.
 * Faded rather than cut so the lines leave the way they arrived; the engine
 * removes them once the fade completes.
 *
 * @returns {number} How many marks were set fading.
 */
export function clearBrigadeMarks() {
  const engine = _annotations();
  try {
    return engine?.fadeOutGroup?.(BRIGADE_MARK_GROUP) ?? 0;
  } catch {
    return 0; // the globe is not the answer; never let it break the panel
  }
}

/** Stop the live marker. Safe to call when none is running. */
function stopTimelineTicker() {
  if (_timelineTimer === null) return;
  clearInterval(_timelineTimer);
  _timelineTimer = null;
}

/**
 * Keep the elapsed marker moving while the panel stays open.
 *
 * Redraws only the chart's own container, not the whole result block: the
 * response-size `<select>` lives in the same subtree and replacing it under
 * the reader would drop an open dropdown and lose keyboard focus.
 *
 * The timer self-cancels once the node leaves the document, which covers the
 * paths that do not run through `hidePassiveMonitorDetail` — a re-render for
 * a different record, or the panel being torn out from elsewhere.
 *
 * @param {HTMLElement} host The `.rt-chart-host` node.
 * @param {object[]} stations Stations to re-model each tick.
 * @param {number|null} incidentMs Incident instant, null when unknown.
 */
function startTimelineTicker(host, stations, incidentMs) {
  stopTimelineTicker();
  if (!Number.isFinite(incidentMs)) return;
  if (typeof setInterval !== 'function') return;

  _timelineTimer = setInterval(() => {
    if (!host.isConnected) {
      stopTimelineTicker();
      return;
    }
    renderTimelineInto(host, stations, incidentMs);
  }, TIMELINE_TICK_MS);
}

/**
 * Draw the chart and its per-station status lines into a host node.
 *
 * @param {HTMLElement} host Container.
 * @param {object[]} stations Stations with `sds` and optional `code1S`.
 * @param {number|null} incidentMs Incident instant.
 */
function renderTimelineInto(host, stations, incidentMs) {
  const model = buildTimeline(stations, { incidentMs });
  host.innerHTML = responseTimelineChart(model);
}

/**
 * One line naming what the elapsed clock is measured from.
 *
 * Always says which timestamp it used and whether a zone was assumed. An
 * elapsed figure whose origin is unstated is the easiest number on this panel
 * to misread, and the panel's own house rule is that a time which has been
 * quietly shifted is worse than one that was never formatted.
 *
 * @param {{ms: number, zoned: boolean}|null} incident Parsed incident time.
 * @returns {string} Caption.
 */
export function timelineOriginNote(incident) {
  if (!incident) {
    return 'No usable incident timestamp — the timeline shows the plan only, with no elapsed marker.';
  }
  return incident.zoned
    ? 'Elapsed measured from the record’s own timestamp.'
    : 'Elapsed measured from the record’s timestamp, read as Melbourne local time (the feed states no zone).';
}

/**
 * The response-size control.
 *
 * Rendered as a real `<select>` rather than a row of buttons because the list
 * runs to eleven options on FRV ground, and because a native control gets
 * keyboard and screen-reader behaviour for free.
 *
 * @param {object[]} plans Plans available for this incident.
 * @param {string} activeId The selected plan.
 * @returns {string} Markup.
 */
function responseSizeControl(plans, activeId) {
  return `
    <label class="pm-detail-plan">
      <span class="pm-detail-plan-label">Response</span>
      <select class="pm-detail-plan-select" data-action="plan">
        ${plans.map((plan) => `<option value="${escapeHtml(plan.id)}"${plan.id === activeId ? ' selected' : ''}>`
          + `${escapeHtml(plan.label)}${plan.sourced ? '' : ' (est.)'}</option>`).join('')}
      </select>
    </label>`;
}

/**
 * Resolve, chart, and draw the response for one incident.
 *
 * Exported for the tests, which drive it against a stub rather than the real
 * snapshot and annotation engine.
 *
 * @param {HTMLElement} panel The open detail panel.
 * @param {{latitude: number, longitude: number}} origin Incident position.
 * @param {HTMLButtonElement} button The clicked control.
 * @param {object} [options]
 * @param {string} [options.incidentTime] Raw record timestamp.
 * @param {string} [options.planId] Response size to run.
 * @returns {Promise<void>}
 */
export async function showNearestBrigades(panel, origin, button, {
  incidentTime = '',
  planId = DEFAULT_PLAN_ID,
} = {}) {
  const out = panel.querySelector('.pm-detail-brigades');
  if (!out) return;

  // Re-entrancy guard. The snapshot fetch is ~374 KB on first use, and without
  // this a second click during that window runs the whole action twice and
  // appends a second set of lines under the first.
  if (button?.disabled) return;
  if (button) {
    button.disabled = true;
    button.textContent = 'Finding…';
  }
  // A re-run at a new response size replaces the chart node the old ticker
  // holds. Stop it here rather than relying on the node-detached check, which
  // would leave one stale tick able to fire against the outgoing markup.
  stopTimelineTicker();
  out.hidden = false;
  out.innerHTML = '<p class="pm-detail-note">Searching the station gazetteer…</p>';

  const plan = resolvePlan(planId);

  try {
    // Concurrent: the FRV test only decides which MENU to draw, so waiting for
    // it before starting the station lookup would delay the answer for a
    // question about the control beside it.
    const [stations, frv] = await Promise.all([
      findNearest(origin, stationCount(plan)),
      inFrvArea(origin),
    ]);

    if (stations.length === 0) {
      out.innerHTML = '<p class="pm-detail-note">No fire stations found near this position.</p>';
      return;
    }

    const incident = parseIncidentTime(incidentTime);
    const incidentMs = incident ? incident.ms : null;
    const model = buildTimeline(stations, { incidentMs });
    const plans = plansFor(frv);
    // A plan gated to the other agency's ground (a Make Tankers held over from
    // a CFA job, then clicked on an FRV one) is not in the menu. Fall the
    // SELECT back to the default rather than showing an empty control — the
    // results below it are still the ones that plan asked for.
    const activeId = plans.some((entry) => entry.id === plan.id) ? plan.id : DEFAULT_PLAN_ID;

    out.innerHTML = `
      <div class="pm-detail-brigade-head">
        Response timeline · ${stations.length} station${stations.length === 1 ? '' : 's'}
      </div>
      ${responseSizeControl(plans, activeId)}
      <div class="pm-detail-actions pm-detail-actions-inline">
        <button type="button" class="pm-detail-action" data-action="clear-routes">Clear routes</button>
      </div>
      <div class="pm-detail-plan-note">${escapeHtml(plan.note)}</div>
      <div class="rt-legend">
        <span class="rt-key rt-key-sds">SDS turnout</span>
        <span class="rt-key rt-key-travel">Code 1 turnout</span>
        ${model.incidentKnown ? '<span class="rt-key rt-key-now">now</span>' : ''}
      </div>
      <div class="rt-chart-host"></div>
      ${stations.map((station, index) => {
        const row = model.rows[index];
        const status = rowStatus(model.elapsedS, row.sdsS, row.totalS);
        const statusText = status ? ` · ${STATUS_LABEL[status]}` : '';
        return `
        <div class="pm-detail-brigade">
          <div class="pm-detail-row">
            <span class="pm-detail-value">${escapeHtml(`${row.rank}. ${station.name}`)}</span>
            <span class="pm-detail-label">${escapeHtml(brigadeTime(station))}</span>
          </div>
          <div class="pm-detail-brigade-sub">${escapeHtml(brigadeSubline(station) + statusText)}</div>
        </div>`;
      }).join('')}
      <p class="pm-detail-note">${escapeHtml(timelineOriginNote(incident))}</p>
      <p class="pm-detail-note">${escapeHtml(BRIGADE_DISCLAIMER)}</p>`;

    // Optional throughout: the chart and the size control are enhancements over
    // the list, and the list is the answer. A container that cannot be queried
    // (the panel stub in the tests, or any future host that only renders text)
    // loses the chart and keeps the stations, which is the same trade
    // `drawBrigadeMarks` makes when the annotation engine is not up.
    const host = out.querySelector?.('.rt-chart-host');
    if (host) {
      renderTimelineInto(host, stations, incidentMs);
      startTimelineTicker(host, stations, incidentMs);
    }

    out.querySelector?.('[data-action="plan"]')?.addEventListener('change', (event) => {
      showNearestBrigades(panel, origin, button, {
        incidentTime,
        planId: event.currentTarget.value,
      });
    });

    out.querySelector?.('[data-action="clear-routes"]')?.addEventListener('click', (event) => {
      clearBrigadeMarks();
      // The list stays. Only the globe is being tidied, and re-reading the
      // table after clearing the lines is a normal thing to want.
      const control = event.currentTarget;
      control.disabled = true;
      control.textContent = 'Routes cleared';
    });

    drawBrigadeMarks(origin, stations);
  } catch (error) {
    // The gazetteer is bundled with the build, so a failure here is a broken
    // install rather than a slow network — say so instead of offering a retry
    // that will fail the same way.
    out.innerHTML = `<p class="pm-detail-note">Station list unavailable (${escapeHtml(String(error?.message || 'unknown error'))}).</p>`;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Response timeline';
    }
  }
}

/**
 * Mark each brigade and draw its road route to the incident.
 *
 * `route` is street-following, not a straight line: the engine sends the
 * endpoints to the /api/route proxy and draws the real path, appending its
 * distance and travel time to the label. That makes the lines strictly better
 * than the panel's straight-line ranking — they answer the road question the
 * panel copy has to disclaim — and when routing is unavailable the engine
 * degrades to a segment labelled "direct line (no route)" rather than passing
 * one off as a route.
 *
 * `mode: 'car'` matters. The engine defaults to walking, which labelled every
 * brigade line with an "X min walk" — a pedestrian travel time on a fire
 * response, which is not merely useless but misleading. An appliance drives.
 *
 * Best-effort by design: the list in the panel is the answer, and the lines are
 * the illustration. If the annotation engine is not up yet (the panel can open
 * before it initialises) the reader still gets the names and distances.
 *
 * `clearPrevious` is all-or-nothing because the engine has no scoped clear —
 * only `clear()` and `fadeOutAll()`, both global. So this does what the voice
 * tool does and replaces the whole annotation set, which costs any marks the
 * user had up. The alternative is worse: without it, clicking a second
 * incident leaves three lines pointing at the first one, and nothing on screen
 * says which fire they belong to. If scoped removal ever lands, this should
 * take a group id and drop only its own lines.
 *
 * Green matches the station layer, and for the same reason: it reads as
 * resource rather than hazard.
 *
 * @param {{latitude: number, longitude: number}} origin Incident position.
 * @param {object[]} stations Nearest stations with `distanceKm`.
 */
function drawBrigadeMarks(origin, stations) {
  const engine = _annotations();
  if (!engine?.annotate) return;
  try {
    // Capped independently of the panel's list. A Make Tankers 25 is a
    // legible table and an illegible map: twenty-five pins carrying
    // 45-character station names, all converging on one point, overlap into a
    // block of text with no fire visible under it. The panel keeps every
    // station; the globe shows the near end of the response, which is the part
    // a reader can still tell apart.
    // Drop only OUR previous set. `clearPrevious: true` used to do this by
    // wiping the whole board, which took every mark the user had drawn by
    // voice with it — and those are documented as accumulating on purpose.
    engine.clearGroup?.(BRIGADE_MARK_GROUP);
    engine.annotate(stations.slice(0, MAX_DRAWN_BRIGADES).flatMap((station) => ([
      {
        // A PIN at the station, carrying the whole label.
        //
        // The route's own caption is drawn at the path MIDPOINT, which for
        // these puts the words "Cranbourne Fire Station" in a paddock 672 m
        // from the station and 577 m from the fire — naming a place at
        // neither end of the line that reaches it, with nothing marking
        // either endpoint. Three of those bunch together where the routes
        // converge and you cannot tell which line belongs to which brigade.
        // The pin puts the name where the station actually is.
        type: 'pin',
        group: BRIGADE_MARK_GROUP,
        color: 'green',
        latitude: station.latitude,
        longitude: station.longitude,
        label: brigadeLineLabel(station),
      },
      {
        type: 'route',
        group: BRIGADE_MARK_GROUP,
        color: 'green',
        mode: 'car',
        // `metrics: false` suppresses the engine's own "— 4.2 km · 4 min
        // drive". That figure is the ordinary car profile; ours is the Code 1
        // model over the same route, and two travel times on one line is
        // worse than either alone. The engine still ROUTES — it needs the road
        // geometry to draw — and hits the proxy's 10-minute cache, so this
        // costs no extra request.
        metrics: false,
        // No label: the pin above carries it. A captioned route would put a
        // second copy of the same text back in the middle of the road.
        label: null,
        // Station first: the line is drawn in the direction of travel, from
        // the brigade to the fire, matching the route the time was computed
        // over.
        points: [
          { latitude: station.latitude, longitude: station.longitude },
          { latitude: origin.latitude, longitude: origin.longitude },
        ],
      },
    ])), { persist: true });
  } catch {
    /* the panel already carries the answer */
  }
}

/** Hide the panel and drop its contents. */
export function hidePassiveMonitorDetail() {
  stopTimelineTicker();
  // The routes belong to the record being read. Closing the panel is the
  // clearest statement that the reader is done with it, and marks that outlive
  // their panel have nothing on screen left to explain them.
  clearBrigadeMarks();
  if (!_panel) return;
  _panel.hidden = true;
  _panel.innerHTML = '';
}

/**
 * Wire the panel to the shared selection events.
 *
 * Escape is handled ONLY while focus is inside the panel. A global Escape hook
 * would insert this into an ordering the Cockpit and Radio already contend for
 * (see the Escape-precedence tests), and this panel is not important enough to
 * take a turn in that queue.
 */
export function initPassiveMonitorDetail() {
  if (_selectedHandler) return;
  _selectedHandler = (event) => {
    const record = event?.detail;
    if (!renderPassiveMonitorDetail(record)) {
      // A selection somewhere else is a dismissal: two detail surfaces open at
      // once would both claim to describe "the" selection.
      hidePassiveMonitorDetail();
    }
  };
  _clearedHandler = () => hidePassiveMonitorDetail();
  _keyHandler = (event) => {
    if (event.key !== 'Escape' || !_panel || _panel.hidden) return;
    if (!_panel.contains(document.activeElement)) return;
    hidePassiveMonitorDetail();
  };

  window.addEventListener('gev:entity-selected', _selectedHandler);
  window.addEventListener('gev:entity-selection-cleared', _clearedHandler);
  window.addEventListener('keydown', _keyHandler);
}

/** Remove listeners and the panel element. */
export function destroyPassiveMonitorDetail() {
  if (_selectedHandler) window.removeEventListener('gev:entity-selected', _selectedHandler);
  if (_clearedHandler) window.removeEventListener('gev:entity-selection-cleared', _clearedHandler);
  if (_keyHandler) window.removeEventListener('keydown', _keyHandler);
  _selectedHandler = null;
  _clearedHandler = null;
  _keyHandler = null;
  if (_panel?.parentNode) _panel.parentNode.removeChild(_panel);
  _panel = null;
}
