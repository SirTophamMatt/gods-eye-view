/**
 * Watch the browser's own network activity and keep the Google usage readout
 * current. The counting rules live in `googleUsage.js`; this is the wiring.
 *
 * HOW THE TILES ARE SEEN. Cesium fetches Photorealistic 3D Tiles directly from
 * tile.googleapis.com, so there is no proxy to instrument and no hook inside
 * Cesium to borrow. A `PerformanceObserver` on resource timings sees every one
 * of them without patching `fetch`, without wrapping XHR, and without the
 * engine knowing it is being watched — which is why it is worth preferring over
 * the alternatives even though it is the less obvious tool.
 *
 * WHY NOT read `performance.getEntriesByType('resource')` on a timer: the
 * buffer is capped (250 entries by default) and silently drops the oldest, so
 * a tile stream overruns it in seconds and a polled reader would undercount by
 * an unknowable amount. An observer is delivered every entry as it happens.
 *
 * WRITES ARE COALESCED. A camera move can issue hundreds of tile requests a
 * second, and a localStorage write per request would be the most expensive
 * thing on the frame. Counts accumulate in memory and are flushed on an
 * interval, on tab-hide, and on unload.
 */

import {
  createUsageCounter,
  formatUsageLine,
  usageTooltip,
} from './googleUsage.js';

/** Where the readout goes. Created by the HUD markup. */
const ELEMENT_ID = 'hud-google-usage';

/** How often pending counts are written and the readout redrawn, ms. */
const FLUSH_MS = 5000;

/** Matches the Map Tiles API host, and nothing else Google serves. */
const TILE_HOST = 'tile.googleapis.com';
/** This app's own Places proxy path. */
const PLACES_PATH = '/api/google/';

let _observer = null;
let _timer = null;
let _hideHandler = null;
let _counter = null;
/** Counts seen since the last flush. */
let _pending = { tiles: 0, places: 0 };

/**
 * Classify one resource entry.
 * @param {string} name Resource URL.
 * @returns {'tiles'|'places'|null} Surface, or null when it is not ours.
 */
export function classifyResource(name) {
  const url = String(name || '');
  if (url.includes(TILE_HOST)) return 'tiles';
  if (url.includes(PLACES_PATH)) return 'places';
  return null;
}

/** Write pending counts through and refresh the readout. */
function flush() {
  if (_counter) {
    if (_pending.tiles > 0) _counter.record('tiles', _pending.tiles);
    if (_pending.places > 0) _counter.record('places', _pending.places);
  }
  _pending = { tiles: 0, places: 0 };
  render();
}

/** Paint today's counts into the HUD element, if it is present. */
function render() {
  if (typeof document === 'undefined' || !_counter) return;
  const el = document.getElementById(ELEMENT_ID);
  if (!el) return;
  const counts = _counter.today();
  el.textContent = formatUsageLine(counts);
  el.title = usageTooltip(counts);
}

/**
 * Start metering. Idempotent, and a no-op wherever the APIs are missing —
 * this is a readout, and a browser without PerformanceObserver should lose the
 * number rather than the app.
 *
 * @param {object} [options]
 * @param {Storage} [options.storage] Injected store, for tests.
 * @returns {boolean} Whether metering actually started.
 */
export function startGoogleUsageMeter({ storage } = {}) {
  if (_observer) return true;
  if (typeof PerformanceObserver === 'undefined' || typeof document === 'undefined') return false;

  _counter = createUsageCounter({ storage });
  render();

  try {
    _observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const surface = classifyResource(entry.name);
        if (surface) _pending[surface] += 1;
      }
    });
    // `buffered` picks up the requests already made before this ran — the
    // globe starts streaming tiles during boot, well before the HUD exists.
    _observer.observe({ type: 'resource', buffered: true });
  } catch {
    _observer = null;
    return false;
  }

  _timer = setInterval(flush, FLUSH_MS);
  _timer.unref?.();

  // A tab can be closed or backgrounded between flushes; `visibilitychange` is
  // the one lifecycle event that fires reliably on mobile, where `unload` does
  // not.
  _hideHandler = () => { if (document.visibilityState === 'hidden') flush(); };
  document.addEventListener('visibilitychange', _hideHandler);

  return true;
}

/** Stop metering and write through whatever is pending. Tests and teardown. */
export function stopGoogleUsageMeter() {
  flush();
  if (_observer) { _observer.disconnect(); _observer = null; }
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_hideHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _hideHandler);
    _hideHandler = null;
  }
  _counter = null;
}

/** Today's counts, for callers that want the numbers rather than the readout. */
export function googleUsageToday() {
  return _counter ? _counter.today() : { day: '', tiles: 0, places: 0 };
}

/** Clear the stored tally. Exposed so a user can reset the readout. */
export function resetGoogleUsage() {
  _pending = { tiles: 0, places: 0 };
  _counter?.reset();
  render();
}
