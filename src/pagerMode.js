/**
 * Pager mode — live brigade pages, on the globe and in the HUD.
 *
 * A mode rather than a data layer, deliberately. Every layer in the tray is a
 * set of things that exist somewhere; this is a stream of events that happen,
 * and it has no meaningful "off state geometry" to draw. It also cannot become
 * a layer without widening the share-link token grammar, which is a change to
 * a serialization format every existing share link depends on — not something
 * to spend on a feature that has no persistent state worth sharing anyway.
 *
 * Two surfaces, from one feed:
 *
 *   the globe   a page for a brigade whose station RESOLVED drops an ephemeral
 *               pin on that station, captioned with the message. It expires on
 *               its own; a pager page is an event, not a place, and leaving
 *               them to accumulate would bury the map in an hour.
 *   the ticker  every page, resolved or not, in a HUD-styled column. This is
 *               the surface that must never lie by omission: a page from a
 *               brigade the gazetteer cannot place still appears here, marked,
 *               because "we received nothing" and "we received it and could
 *               not map it" are different facts.
 *
 * The mode is inert until enabled and reports plainly when no instance is
 * configured, which is the normal state for anyone who has not stood up a
 * PagerMon receiver.
 */

import { createPagerFeed } from './data/pagerFeed.js';

const TICKER_ID = 'pager-ticker';
const TOGGLE_ID = 'pager-toggle';
/** Rows the ticker shows. More than this and it stops being scannable. */
const TICKER_ROWS = 12;
/**
 * How long a map pin survives.
 *
 * Long enough to notice and read, short enough that a busy afternoon does not
 * leave fifty overlapping brigades on the globe. Pages keep accumulating in
 * the ticker either way, which is where history belongs.
 */
const PIN_TTL_MS = 180_000;
/**
 * Pins dropped for one batch of pages.
 *
 * A single dispatch can page a dozen brigades at once. Beyond a handful the
 * map stops communicating anything and the ticker is the better read, so the
 * batch is capped rather than allowed to carpet the state.
 */
const MAX_PINS_PER_BATCH = 6;

let _ticker = null;
let _toggleBtn = null;
let _feed = null;
let _unsubscribe = null;
let _enabled = false;
let _annotations = () => window.__gevAnnotations || null;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Clock time for a page.
 *
 * PagerMon stores whatever integer the instance wrote. Treated as epoch
 * seconds when it looks like one and rendered in local time; anything else is
 * shown as a dash rather than as a confidently wrong hour.
 *
 * @param {number|null} timestamp Page timestamp.
 * @returns {string} "HH:MM", or "--:--".
 */
export function pagerClock(timestamp) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const ms = seconds > 1e11 ? seconds : seconds * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * One ticker row's markup.
 * @param {object} page Enriched page from the feed.
 * @returns {string} HTML.
 */
export function pagerRowHtml(page) {
  const brigade = page.station?.name || page.alias || `Capcode ${page.address}`;
  // An unplaced page is marked, not hidden. Silently dropping it would make a
  // gap in the gazetteer look like a quiet night.
  const unplaced = page.station ? '' : '<span class="pager-row-unplaced" title="No station matched this capcode">◌</span>';
  return `
    <div class="pager-row${page.station ? '' : ' pager-row-unresolved'}">
      <span class="pager-row-time">${escapeHtml(pagerClock(page.timestamp))}</span>
      <span class="pager-row-brigade">${escapeHtml(brigade)}${unplaced}</span>
      <span class="pager-row-message">${escapeHtml(page.message)}</span>
    </div>`;
}

/**
 * Create the small persistent toggle, in the fixed-chrome style the clock and
 * REC indicator use rather than the collapsible layer-tray rows.
 *
 * Deliberately outside the layer tray and the panel-pin/share-link machinery
 * those rows share: pager mode has no persistent per-viewer state worth
 * putting in a URL (a link encoding "pager mode ON" is meaningless to a
 * viewer without the same PagerMon instance behind them), and it is not a
 * set of things that exist on the globe the way a layer is. It is closer in
 * kind to clean-view-toggle — a standalone chrome control — than to a layer
 * row, so it is built the same way: its own element, created once, appended
 * to the body.
 */
function ensureToggleButton() {
  if (_toggleBtn && document.body.contains(_toggleBtn)) return _toggleBtn;
  const el = document.createElement('button');
  el.id = TOGGLE_ID;
  el.type = 'button';
  el.className = 'pager-toggle';
  el.setAttribute('aria-pressed', 'false');
  el.setAttribute('aria-label', 'Toggle live brigade pages');
  el.title = 'Brigade pages (PagerMon)';
  el.textContent = 'PAGER';
  el.addEventListener('click', () => {
    if (_enabled) disablePagerMode();
    else enablePagerMode();
  });
  document.body.appendChild(el);
  _toggleBtn = el;
  return el;
}

function syncToggleButton() {
  if (!_toggleBtn) return;
  _toggleBtn.setAttribute('aria-pressed', _enabled ? 'true' : 'false');
  _toggleBtn.classList.toggle('pager-toggle-active', _enabled);
}

function ensureTicker() {
  if (_ticker && document.body.contains(_ticker)) return _ticker;
  const el = document.createElement('div');
  el.id = TICKER_ID;
  el.className = 'pager-ticker';
  el.setAttribute('role', 'log');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-label', 'Live brigade pages');
  el.hidden = true;
  document.body.appendChild(el);
  _ticker = el;
  return el;
}

/**
 * Compose the ticker's full innerHTML from feed state.
 *
 * Pure and DOM-free on purpose: this is the part with actual decisions in it
 * (what "no instance" looks like versus "no pages yet", how the unplaced
 * count is worded, which rows show), and keeping it free of `document` is
 * what makes those decisions testable without a browser. `renderTicker()`
 * below is the thin wrapper that hands this string to a real element.
 *
 * @param {{live: boolean, error: string|null, unresolved: number}} status Feed status.
 * @param {object[]} history Newest-first pages, already trimmed to what should show.
 * @returns {string} Ticker innerHTML.
 */
export function pagerTickerHtml(status, history) {
  let body;
  if (status.error === 'not_configured') {
    body = '<div class="pager-empty">No PagerMon instance configured.</div>';
  } else if (history.length === 0) {
    body = `<div class="pager-empty">${status.live ? 'Listening — no pages yet.' : 'Connecting…'}</div>`;
  } else {
    body = history.map(pagerRowHtml).join('');
  }

  // The unplaced count belongs in the header, permanently visible: it is what
  // stops a gap in the station index from reading as a quiet night.
  //
  // It counts PAGES in the latest poll window, not distinct capcodes and not
  // the whole network — one unmatched brigade paging three times reads as
  // "3 unplaced". That is the honest scope for a ticker showing that same
  // window, and the tooltip says so rather than implying a census.
  const unplaced = status.unresolved > 0
    ? `<span class="pager-head-warn" title="Recent pages with no matching station">${status.unresolved} unplaced</span>`
    : '';
  const dot = status.live ? 'pager-dot-live' : 'pager-dot-down';

  return `
    <div class="pager-head">
      <span class="pager-dot ${dot}">●</span>
      <span class="pager-head-title">BRIGADE PAGES</span>
      ${unplaced}
      <button type="button" class="pager-close" aria-label="Close brigade pages">&#x2715;</button>
    </div>
    <div class="pager-body">${body}</div>`;
}

function renderTicker() {
  if (!_ticker || !_feed) return;
  const status = _feed.getStatus();
  const pages = _feed.getHistory().slice(0, TICKER_ROWS);
  _ticker.innerHTML = pagerTickerHtml(status, pages);
  _ticker.querySelector('.pager-close')?.addEventListener('click', () => disablePagerMode());
}

/**
 * Drop an ephemeral pin on each brigade that was paged.
 *
 * `persist: false` is what makes these expire — a page is an event. Note this
 * does NOT pass `clearPrevious`, unlike the nearest-brigades action: pages
 * arrive continuously and clearing on every batch would delete the pins from
 * the batch thirty seconds earlier, along with anything the user had put up
 * themselves.
 *
 * @param {object[]} pages Newly-arrived pages.
 */
export function dropPins(pages) {
  const engine = _annotations();
  if (!engine?.annotate) return;
  const placeable = pages.filter((page) => page.station).slice(0, MAX_PINS_PER_BATCH);
  if (placeable.length === 0) return;
  try {
    engine.annotate(placeable.map((page) => ({
      type: 'pin',
      color: 'amber',
      latitude: page.station.latitude,
      longitude: page.station.longitude,
      label: `${page.station.name} · ${pagerClock(page.timestamp)}`,
      ttlMs: PIN_TTL_MS,
    })), { persist: false });
  } catch {
    /* the ticker still has the page */
  }
}

/**
 * Whether a PagerMon instance is configured for this build.
 *
 * Only the boolean crosses from the server — the origin and key stay in the
 * proxy — so this is all the client can know, and all it needs to.
 * @returns {boolean}
 */
export function pagerModeAvailable() {
  return Boolean(import.meta.env.PAGERMON_LIVE);
}

/**
 * Load the station gazetteer, importing it on first use.
 *
 * Dynamic rather than a top-level import for the same reason
 * `passiveMonitorDetail.js` defers `fireStationLookup.js`: that module carries
 * a Vite-only `?url` asset import, and a top-level import here would make
 * THIS module unloadable under plain Node — which is what keeps `pagerClock`,
 * `pagerRowHtml` and `pagerTickerHtml` unit-testable without a bundler.
 * @returns {Promise<object[]>} Stations.
 */
async function loadStationsForPager() {
  const { loadFireStations } = await import('./data/fireStationLookup.js');
  return loadFireStations();
}

/** @type {object|null} Test-injected feed, bypassing createPagerFeed entirely. */
let _feedOverride = null;

/** Swap in a fake feed for the lifecycle tests. Tests only. */
export function _setPagerFeedForTest(feed) {
  _feedOverride = feed || null;
}

/** Start the feed and show the ticker. Idempotent. */
export function enablePagerMode() {
  if (_enabled) return;
  _enabled = true;
  if (!_feed) {
    _feed = _feedOverride || createPagerFeed({ loadStations: loadStationsForPager });
    _unsubscribe = _feed.onPages((pages) => {
      renderTicker();
      dropPins(pages);
    });
  }
  const el = ensureTicker();
  el.hidden = false;
  renderTicker();
  syncToggleButton();
  // One explicit poll to prime the backlog and settle "Connecting…", THEN
  // start the recurring interval with its own initial poll skipped — calling
  // `_feed.start()` here as well, the way an earlier version of this did,
  // races this poll with `start()`'s own immediate one. The priming poll
  // never announces anything by design, so the race could resolve in an
  // order where the FIRST real batch of pages is silently swallowed instead
  // of reaching `onPages` — caught by testing this against a real feed rather
  // than only against the unit tests, which drove polls one at a time and
  // never exercised two running concurrently.
  void _feed.poll().then(() => {
    renderTicker();
    // A fast disable() could land before this resolves; do not resurrect
    // polling for a mode the user already turned back off.
    if (_enabled) _feed.start({ skipInitialPoll: true });
  });
}

/** Stop polling and hide the ticker. The history survives a re-enable. */
export function disablePagerMode() {
  if (!_enabled) return;
  _enabled = false;
  _feed?.stop();
  if (_ticker) _ticker.hidden = true;
  syncToggleButton();
}

/** @returns {boolean} */
export function isPagerModeEnabled() {
  return _enabled;
}

/**
 * Wire the mode and return its handle.
 *
 * Nothing polls until `enable()` is called, and the toggle button is only
 * created when `PAGERMON_LIVE` is true — a deployment with no PagerMon
 * instance configured gets no new chrome at all, not a button that always
 * fails.
 *
 * @returns {object} Mode handle.
 */
export function initPagerMode() {
  if (pagerModeAvailable()) ensureToggleButton();
  return {
    enable: enablePagerMode,
    disable: disablePagerMode,
    toggle: () => (_enabled ? disablePagerMode() : enablePagerMode()),
    isEnabled: isPagerModeEnabled,
    available: pagerModeAvailable,
    getStatus: () => (_feed ? _feed.getStatus() : { live: false, error: null, unresolved: 0 }),
    getHistory: () => (_feed ? _feed.getHistory() : []),
  };
}

/** Tear down. Tests and hot reload. */
export function destroyPagerMode() {
  disablePagerMode();
  if (_unsubscribe) _unsubscribe();
  _unsubscribe = null;
  _feed = null;
  if (_ticker?.parentNode) _ticker.parentNode.removeChild(_ticker);
  _ticker = null;
  if (_toggleBtn?.parentNode) _toggleBtn.parentNode.removeChild(_toggleBtn);
  _toggleBtn = null;
}

/** Swap the annotation engine accessor. Tests only. */
export function _setPagerAnnotationsForTest(accessor) {
  _annotations = accessor || (() => window.__gevAnnotations || null);
}
