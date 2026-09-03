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
const BRIGADE_COUNT = 3;

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
let _annotations = () => window.__gevAnnotations || null;

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
  const { findNearestFireStations } = await import('./fireStationLookup.js');
  return findNearestFireStations(origin, count);
}

/** Swap the brigade-action collaborators. Tests only. */
export function _setBrigadeDepsForTest({ findNearest: find, annotations } = {}) {
  _findNearest = find || null;
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

        ${offersBrigadeAction(props, record) ? `
        <div class="pm-detail-actions">
          <button type="button" class="pm-detail-action" data-action="brigades">Nearest brigades</button>
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
    }, event.currentTarget);
  });
  return true;
}

/**
 * Resolve, list, and draw the nearest brigades for one incident.
 *
 * Exported for the tests, which drive it against a stub rather than the real
 * snapshot and annotation engine.
 *
 * @param {HTMLElement} panel The open detail panel.
 * @param {{latitude: number, longitude: number}} origin Incident position.
 * @param {HTMLButtonElement} button The clicked control.
 * @returns {Promise<void>}
 */
export async function showNearestBrigades(panel, origin, button) {
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
  out.hidden = false;
  out.innerHTML = '<p class="pm-detail-note">Searching the station gazetteer…</p>';

  try {
    const stations = await findNearest(origin, BRIGADE_COUNT);
    if (stations.length === 0) {
      out.innerHTML = '<p class="pm-detail-note">No fire stations found near this position.</p>';
      return;
    }

    out.innerHTML = `
      <div class="pm-detail-brigade-head">Nearest ${stations.length === 1 ? 'station' : `${stations.length} stations`}</div>
      ${stations.map((station) => `
        <div class="pm-detail-row">
          <span class="pm-detail-value">${escapeHtml(station.name)}</span>
          <span class="pm-detail-label">${escapeHtml(formatDistanceKm(station.distanceKm))}</span>
        </div>`).join('')}
      <p class="pm-detail-note">Straight-line distance. Not a dispatch — Victoria turns out brigades by response area, not proximity.</p>`;

    drawBrigadeLines(origin, stations);
  } catch (error) {
    // The gazetteer is bundled with the build, so a failure here is a broken
    // install rather than a slow network — say so instead of offering a retry
    // that will fail the same way.
    out.innerHTML = `<p class="pm-detail-note">Station list unavailable (${escapeHtml(String(error?.message || 'unknown error'))}).</p>`;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Nearest brigades';
    }
  }
}

/**
 * Draw one road route from the incident to each station.
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
function drawBrigadeLines(origin, stations) {
  const engine = _annotations();
  if (!engine?.annotate) return;
  try {
    engine.annotate(stations.map((station) => ({
      type: 'route',
      color: 'green',
      mode: 'car',
      // Name only. A `route` is street-following, and the engine appends its
      // own "— 4.2 km · 8 min drive" from the ROUTED geometry — so adding the
      // straight-line distance here would print two different numbers for the
      // same trip in one label. The panel keeps the straight-line figures
      // because they are what the ranking is based on and they are always
      // available; the line carries the road answer when routing resolves.
      label: station.name,
      points: [
        { latitude: origin.latitude, longitude: origin.longitude },
        { latitude: station.latitude, longitude: station.longitude },
      ],
    })), { clearPrevious: true, persist: true });
  } catch {
    /* the panel already carries the answer */
  }
}

/** Hide the panel and drop its contents. */
export function hidePassiveMonitorDetail() {
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
