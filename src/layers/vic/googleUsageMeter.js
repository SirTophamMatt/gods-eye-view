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
  USAGE_SURFACES,
  createUsageCounter,
  formatUsageLine,
  usageTooltip,
} from './googleUsage.js';

/** Where the readout goes; inserted under the HUD's AIS readout. */
const ELEMENT_ID = 'hud-google-usage';
/** The HUD readout the meter sits beneath (src/hud.js, bottom-right corner). */
const ANCHOR_ID = 'hud-ais-vessel';

/** How often pending counts are written and the readout redrawn, ms. */
const FLUSH_MS = 5000;

/** Matches the Map Tiles API host, and nothing else Google serves. */
const TILE_HOST = 'tile.googleapis.com';
/**
 * The root tileset request — the ONLY billable event on the 3D Tiles SKU.
 *
 * Everything else under `tile.googleapis.com` is a renderer tile fetch, which
 * Google bills at nothing and does not count against quota. Distinguishing
 * these two is the entire point of this classifier: they differ by three orders
 * of magnitude in volume and by all of the cost.
 */
const ROOT_TILESET = /\/3dtiles\/root\.json/;
/** This app's own Google proxy routes, by what each one is billed as. */
const GOOGLE_ROUTES = Object.freeze([
  ['/api/google/nearby-places', 'places'],
  ['/api/google/text-search', 'places'],
  ['/api/google/reverse-geocode', 'geocode'],
  ['/api/google/geocode', 'geocode'],
  // The session token for the 3D tiles is free; the root.json it unlocks is
  // what bills.
  ['/api/google/tiles-token', null],
]);
/** Street Level loads the Maps JavaScript API (src/layers/streetLevel/). */
const MAPS_JS = 'maps.googleapis.com/maps/api/js';

const emptyPending = () =>
  Object.fromEntries(USAGE_SURFACES.map((surface) => [surface, 0]));

let _observer = null;
let _timer = null;
let _hideHandler = null;
let _counter = null;
/** Counts seen since the last flush. */
let _pending = emptyPending();

/**
 * Classify one resource entry by what it costs.
 *
 * @param {string} name Resource URL.
 * @returns {string|null} A USAGE_SURFACES entry, or null when not billable here.
 */
export function classifyResource(name) {
  const url = String(name || '');
  if (url.includes(TILE_HOST)) {
    return ROOT_TILESET.test(url) ? 'sessions3d' : 'tileFetches';
  }
  if (url.includes(MAPS_JS)) return 'mapsJs';
  for (const [path, surface] of GOOGLE_ROUTES) {
    if (url.includes(path)) return surface;
  }
  return null;
}

/** Write pending counts through and refresh the readout. */
function flush() {
  if (_counter) {
    for (const [surface, n] of Object.entries(_pending)) {
      if (n > 0) _counter.record(surface, n);
    }
  }
  _pending = emptyPending();
  render();
}

/**
 * The readout element, inserted under the AIS readout if the HUD has not got
 * one. Re-checked on every render because the HUD can rebuild its markup.
 */
function readoutElement() {
  const existing = document.getElementById(ELEMENT_ID);
  if (existing) return existing;
  const anchor = document.getElementById(ANCHOR_ID)?.closest('.hud-readout');
  if (!anchor) return null;
  const wrapper = document.createElement('div');
  wrapper.className = 'hud-readout';
  const el = document.createElement('div');
  el.id = ELEMENT_ID;
  el.className = 'hud-google-usage';
  el.setAttribute('translate', 'no');
  wrapper.appendChild(el);
  anchor.after(wrapper);
  return el;
}

/** Paint today's counts into the HUD element, if it is present. */
function render() {
  if (typeof document === 'undefined' || !_counter) return;
  const el = readoutElement();
  if (!el) return;
  const counts = _counter.today();
  el.textContent = formatUsageLine(counts);
  el.title = usageTooltip(counts);
}

/**
 * Begin counting resource entries into `_pending`. Idempotent.
 *
 * Runs when this module is evaluated, not when the readout starts: the 3D
 * root tileset is requested while the scene is built, before the page tools
 * mount, and under the dev server the browser's resource-timing buffer (250
 * entries) is already full of module requests by then, so a late `buffered`
 * observer would never see it. An observer is delivered every entry whether
 * or not the buffer has room.
 * @returns {boolean} Whether an observer is running.
 */
function observeResources() {
  if (_observer) return true;
  if (
    typeof PerformanceObserver === 'undefined' ||
    typeof document === 'undefined'
  )
    return false;
  try {
    _observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const surface = classifyResource(entry.name);
        if (surface) _pending[surface] += 1;
      }
    });
    // `buffered` still picks up whatever the buffer holds from before.
    _observer.observe({ type: 'resource', buffered: true });
    return true;
  } catch {
    _observer = null;
    return false;
  }
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
  if (_counter) return true;
  if (!observeResources()) return false;

  _counter = createUsageCounter({ storage });
  flush();

  _timer = setInterval(flush, FLUSH_MS);
  _timer.unref?.();

  // A tab can be closed or backgrounded between flushes; `visibilitychange` is
  // the one lifecycle event that fires reliably on mobile, where `unload` does
  // not.
  _hideHandler = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', _hideHandler);

  return true;
}

/** Stop metering and write through whatever is pending. Tests and teardown. */
export function stopGoogleUsageMeter() {
  flush();
  if (_observer) {
    _observer.disconnect();
    _observer = null;
  }
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  if (_hideHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _hideHandler);
    _hideHandler = null;
  }
  _counter = null;
}

/** Today's counts, for callers that want the numbers rather than the readout. */
export function googleUsageToday() {
  return _counter
    ? _counter.today()
    : {
        day: '',
        sessions3d: 0,
        places: 0,
        geocode: 0,
        mapsJs: 0,
        tileFetches: 0,
        billable: 0,
      };
}

/** Clear the stored tally. Exposed so a user can reset the readout. */
export function resetGoogleUsage() {
  _pending = emptyPending();
  _counter?.reset();
  render();
}

observeResources();
