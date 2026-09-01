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

const PANEL_ID = 'pm-detail-panel';
const LAYER_PREFIX = 'local-pm-';

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

        ${url ? `<a class="pm-detail-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open full warning &#x2197;</a>` : ''}
        ${headline.endsWith('...') || headline.endsWith('…')
          ? '<p class="pm-detail-note">Text truncated by the VicEmergency feed at source.</p>'
          : ''}
      </div>
    </div>`;

  panel.hidden = false;
  panel.querySelector('.pm-detail-close')?.addEventListener('click', hidePassiveMonitorDetail);
  return true;
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
