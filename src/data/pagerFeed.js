/**
 * Live brigade pages from a PagerMon instance.
 *
 * PagerMon's read API already joins `capcodes` onto every message, so a page
 * arrives carrying its own `alias` and `agency` — the pager address is
 * resolved to a brigade name upstream, and this only has to turn that name
 * into a place. `capcodeStations.js` does that; this owns the polling, the
 * de-duplication and the bounded history.
 *
 * WHY POLLING. PagerMon pushes over socket.io and that is genuinely lower
 * latency, but the app's proxies are hand-rolled HTTP middleware and a
 * websocket upgrade passthrough is machinery nothing else here needs. A few
 * seconds on a pager page does not justify being the first. See the proxy
 * comment in vite.config.js for the two upgrade paths.
 *
 * DE-DUPLICATION IS NOT OPTIONAL. Every poll re-fetches the same recent window,
 * so without an id check the same page would be announced once per tick,
 * forever — a single fire would look like a brigade being paged every five
 * seconds. `_seen` is bounded the same way the history is, so a long session
 * cannot grow it without limit.
 *
 * Nothing here reaches the network or the DOM on its own: the fetch and the
 * station list are both injected, which is what lets the whole feed be driven
 * from a test.
 */

import { buildStationIndex, resolveCapcode } from './capcodeStations.js';

/** How many pages the ticker and the map can look back over. */
export const PAGER_HISTORY_LIMIT = 60;
/** Poll cadence. Pages are minutes apart; this is about feeling live, not load. */
export const PAGER_POLL_MS = 8_000;
/** How many messages to ask for per poll. Upstream clamps at 120. */
export const PAGER_FETCH_LIMIT = 50;

/**
 * Normalise one PagerMon message row.
 *
 * `timestamp` arrives as an integer the instance wrote; it is carried through
 * unconverted and only ever formatted for display. Guessing a zone would shift
 * an emergency timestamp silently, which the detail panel already refuses to
 * do for the same reason.
 *
 * @param {object} row Raw PagerMon message.
 * @returns {object|null} Normalised page, or null when unusable.
 */
export function normalizePage(row) {
  const id = Number(row?.id);
  if (!Number.isFinite(id)) return null;
  const message = String(row?.message ?? '').trim();
  const address = String(row?.address ?? '').trim();
  if (!message && !address) return null;
  return {
    id,
    address,
    alias: String(row?.alias ?? '').trim(),
    agency: String(row?.agency ?? '').trim() || null,
    message,
    source: String(row?.source ?? '').trim() || null,
    timestamp: Number.isFinite(Number(row?.timestamp)) ? Number(row.timestamp) : null,
  };
}

/**
 * Create the feed.
 *
 * @param {object} options
 * @param {() => Promise<object[]>} options.loadStations Gazetteer loader.
 * @param {typeof fetch} [options.fetchImpl] Test seam.
 * @param {number} [options.intervalMs] Poll cadence.
 * @param {number} [options.limit] Messages per poll.
 * @param {(fn: Function, ms: number) => any} [options.setIntervalImpl] Test seam.
 * @param {(handle: any) => void} [options.clearIntervalImpl] Test seam.
 * @returns {object} Feed handle.
 */
export function createPagerFeed({
  loadStations,
  fetchImpl = globalThis.fetch,
  intervalMs = PAGER_POLL_MS,
  limit = PAGER_FETCH_LIMIT,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  /** @type {object[]} Newest first. */
  let history = [];
  /** @type {Set<number>} Ids already announced. */
  let seen = new Set();
  /** @type {Set<Function>} */
  const listeners = new Set();
  let index = null;
  let handle = null;
  let running = false;
  let status = { live: false, error: null, lastUpdate: null, unresolved: 0 };

  /**
   * Highest id seen so far.
   *
   * On the FIRST poll the window is treated as backlog: it is loaded into the
   * history so the ticker has something to show, but no listener is called.
   * Announcing 50 historical pages as they arrive would fire 50 map pops for
   * incidents that may be hours old.
   */
  let primed = false;

  async function ensureIndex() {
    if (index) return index;
    const stations = await loadStations();
    index = buildStationIndex(stations);
    return index;
  }

  function emit(pages) {
    if (pages.length === 0) return;
    for (const listener of [...listeners]) {
      try {
        listener(pages);
      } catch {
        // One bad subscriber must not stop the others, or stop the feed.
      }
    }
  }

  async function poll() {
    try {
      const response = await fetchImpl(`/api/pagermon/messages?limit=${limit}`);
      if (!response.ok) {
        // 503 is "no instance configured", which is a normal state rather than
        // a fault — the mode reports itself unavailable and stops trying to
        // look broken about it.
        const reason = response.status === 503 ? 'not_configured' : `HTTP ${response.status}`;
        status = { ...status, live: false, error: reason };
        return;
      }
      const body = await response.json();
      const rows = Array.isArray(body) ? body : (body?.messages || []);
      const resolvedIndex = await ensureIndex();

      const fresh = [];
      let unresolved = 0;
      // Upstream returns newest first; walk oldest first so the announced
      // batch reads in the order the pages actually happened.
      for (const row of [...rows].reverse()) {
        const page = normalizePage(row);
        if (!page) continue;
        const outcome = resolveCapcode(page.alias, resolvedIndex);
        if (!outcome.station) unresolved += 1;
        const enriched = {
          ...page,
          station: outcome.station
            ? {
              name: outcome.station.name,
              latitude: outcome.station.latitude,
              longitude: outcome.station.longitude,
            }
            : null,
          resolution: outcome.reason,
        };
        if (seen.has(page.id)) continue;
        seen.add(page.id);
        fresh.push(enriched);
      }

      if (fresh.length > 0) {
        history = [...fresh].reverse().concat(history).slice(0, PAGER_HISTORY_LIMIT);
        // Bound the id set to the same window, plus slack for a poll that
        // returns more than the history keeps.
        if (seen.size > PAGER_HISTORY_LIMIT * 4) {
          seen = new Set(history.map((p) => p.id));
        }
      }

      status = {
        live: true,
        error: null,
        lastUpdate: Date.now(),
        unresolved,
      };

      if (!primed) {
        primed = true;
        return; // backlog loaded, nothing announced
      }
      emit(fresh);
    } catch (error) {
      status = { ...status, live: false, error: String(error?.message || 'unreachable') };
    }
  }

  return {
    /**
     * Begin polling. Idempotent.
     *
     * `skipInitialPoll` lets a caller that has already awaited one `poll()`
     * itself (to prime the backlog and settle its own "connecting" UI before
     * starting the recurring loop) start the interval without a second poll
     * racing the one it just ran. Without this, a caller doing exactly that
     * would fire two concurrent polls on enable, and since the priming poll
     * announces nothing by design (see `primed` above), a race between them
     * could settle in an order where the first real batch is never announced.
     * @param {{skipInitialPoll?: boolean}} [options]
     */
    start({ skipInitialPoll = false } = {}) {
      if (running) return;
      running = true;
      if (!skipInitialPoll) void poll();
      handle = setIntervalImpl(() => { void poll(); }, intervalMs);
    },
    /** Stop polling. The history is kept so a re-start does not re-announce. */
    stop() {
      if (!running) return;
      running = false;
      if (handle !== null) clearIntervalImpl(handle);
      handle = null;
    },
    /** @returns {boolean} */
    isRunning: () => running,
    /** Subscribe to newly-arrived pages. Returns an unsubscribe. */
    onPages(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Newest first. */
    getHistory: () => [...history],
    getStatus: () => ({ ...status }),
    /** Force one poll — used by the mode's initial paint. */
    poll,
  };
}
