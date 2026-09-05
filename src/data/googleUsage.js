/**
 * Count what this app spends against the Google Maps Platform key.
 *
 * WHAT THIS IS NOT, first, because the gap matters more than the feature does:
 * it is NOT your account's usage, and it cannot become that. Google publishes
 * no usage or quota endpoint a browser can call — the real figures live in
 * Cloud Console and the Cloud Monitoring API, behind service-account OAuth and
 * several minutes of lag. So this counts REQUESTS THIS BROWSER HAS MADE, which
 * is a different quantity and a strictly smaller one.
 *
 * It misses, by construction: other browsers and devices, other people on the
 * same deployment, anything else using the same key, and — the one that
 * actually causes surprise bills — someone who lifted the key off the page.
 * `GOOGLE_MAPS_API_KEY` is handed to the client by design (see SECURITY.md), so
 * the only real protections are an HTTP-referrer restriction and a per-API
 * quota cap in Cloud Console. A number on the HUD is situational awareness. It
 * is not a spend cap, and the copy beside it must not imply that it is.
 *
 * WHAT ACTUALLY BILLS, which is the whole reason this module is careful:
 *
 *   sessions3d   Map Tiles API — Photorealistic 3D Tiles. Billed per ROOT
 *                TILESET request (`/v1/3dtiles/root.json`), which is one per
 *                page load and covers up to three hours of renderer tile
 *                fetches. Google: "Only root tileset requests are billable …
 *                Unlimited renderer-originating tile requests per day."
 *   places       Places API (New) `places:searchNearby`, via this app's own
 *                /api/google/nearby-places proxy. One billable event per call,
 *                and only the voice assistant makes them.
 *   tileFetches  The individual tiles. FREE and unmetered — counted only so the
 *                readout can say so, because a five-figure tile count next to a
 *                dollar sign is exactly the wrong impression to leave.
 *
 * Counting tile fetches as spend was this module's first mistake: it made an
 * idle globe look like $400 of traffic when the true cost was one root request.
 * If a future surface is added, check its SKU before counting it.
 *
 * THE DAY BOUNDARY is Pacific, not local and not UTC. Google Maps Platform
 * daily quotas reset at midnight America/Los_Angeles, so a tally keyed any
 * other way disagrees with the console it is meant to be compared against —
 * and would disagree by a whole day's worth right when someone is checking.
 *
 * Pure except for an injected `storage`: no DOM, no network, no clock of its
 * own. `googleUsageMeter.js` is the part that touches the browser.
 */

/** localStorage key, following the repo's `godsEyeView.<feature>.<field>`. */
export const USAGE_STORAGE_KEY = 'godsEyeView.googleUsage.daily';

/**
 * Surfaces worth counting apart.
 *
 * These are BILLABLE EVENTS, which is not the same as requests. See the header:
 * a 3D-tile session is one root-tileset request no matter how many thousands of
 * renderer tiles follow it, and those tiles are free and unmetered.
 */
export const USAGE_SURFACES = Object.freeze(['sessions3d', 'places', 'tileFetches']);

/** The subset that actually costs money. `tileFetches` is free, and shown as such. */
export const BILLABLE_SURFACES = Object.freeze(['sessions3d', 'places']);

/** How many past days are kept. Enough to see a trend, small enough to ignore. */
const RETAIN_DAYS = 7;

/**
 * The Google-quota day an instant falls in, as `YYYY-MM-DD`.
 *
 * @param {number|Date} at Instant.
 * @param {string} [timeZone] Quota zone; only overridden by tests.
 * @returns {string} Day key, or '' when the runtime has no such zone.
 */
export function quotaDayKey(at = Date.now(), timeZone = 'America/Los_Angeles') {
  try {
    // en-CA formats as YYYY-MM-DD, which sorts lexicographically.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(at));
  } catch {
    return '';
  }
}

/** Best-effort storage handle; absent in tests and locked-down browsers. */
function usageStorage(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // privacy modes throw on mere access
  }
}

/**
 * Read the persisted tally, tolerating anything at all in the slot.
 *
 * A corrupt or hand-edited entry resets to empty rather than throwing: this is
 * a readout, and losing a day's count is a smaller failure than breaking the
 * HUD that carries it.
 *
 * @param {Storage} [storage] Injected store.
 * @returns {Record<string, Record<string, number>>} Day → surface → count.
 */
export function readUsage(storage) {
  try {
    const raw = usageStorage(storage)?.getItem(USAGE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [day, counts] of Object.entries(parsed)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !counts || typeof counts !== 'object') continue;
      const row = {};
      for (const surface of USAGE_SURFACES) {
        const n = Number(counts[surface]);
        if (Number.isFinite(n) && n > 0) row[surface] = Math.floor(n);
      }
      clean[day] = row;
    }
    return clean;
  } catch {
    return {};
  }
}

/**
 * Drop every day but the most recent `RETAIN_DAYS`.
 * @param {Record<string, object>} usage Tally.
 * @returns {Record<string, object>} Pruned copy.
 */
export function pruneUsage(usage) {
  const days = Object.keys(usage || {}).sort();
  if (days.length <= RETAIN_DAYS) return { ...usage };
  const keep = days.slice(-RETAIN_DAYS);
  const out = {};
  for (const day of keep) out[day] = usage[day];
  return out;
}

/**
 * Build a counter over one storage slot.
 *
 * Writes are coalesced by the caller (see `googleUsageMeter.js`): a 3D-tile
 * stream can issue hundreds of requests a second while the camera moves, and
 * a localStorage write per request would be the most expensive thing on the
 * frame by a wide margin.
 *
 * @param {object} [options]
 * @param {Storage} [options.storage] Injected store.
 * @param {function(): number} [options.now] Injected clock.
 * @param {string} [options.timeZone] Quota zone.
 * @returns {{record: function, today: function, all: function, reset: function}}
 */
export function createUsageCounter({ storage, now = Date.now, timeZone } = {}) {
  let cache = null;

  const load = () => {
    if (!cache) cache = readUsage(storage);
    return cache;
  };

  const persist = (usage) => {
    cache = usage;
    try {
      usageStorage(storage)?.setItem(USAGE_STORAGE_KEY, JSON.stringify(usage));
    } catch {
      /* best effort — a full or blocked store must not break the readout */
    }
  };

  return {
    /**
     * Add `count` requests against a surface, on today's quota day.
     * @param {string} surface One of USAGE_SURFACES.
     * @param {number} [count=1] How many.
     * @returns {number} The surface's new total for today.
     */
    record(surface, count = 1) {
      if (!USAGE_SURFACES.includes(surface)) return 0;
      const n = Math.floor(Number(count));
      if (!Number.isFinite(n) || n <= 0) return load()[quotaDayKey(now(), timeZone)]?.[surface] || 0;

      const day = quotaDayKey(now(), timeZone);
      if (!day) return 0;
      const usage = { ...load() };
      const row = { ...(usage[day] || {}) };
      row[surface] = (Number(row[surface]) || 0) + n;
      usage[day] = row;
      // Prune AFTER today's row is in, or the cap is one day looser than it
      // says: pruning first leaves RETAIN_DAYS and then adds a further one.
      persist(pruneUsage(usage));
      return row[surface];
    },

    /**
     * Today's counts.
     * @returns {{day: string, sessions3d: number, places: number, tileFetches: number, billable: number}}
     */
    today() {
      const day = quotaDayKey(now(), timeZone);
      const row = load()[day] || {};
      const counts = {
        day,
        sessions3d: Number(row.sessions3d) || 0,
        places: Number(row.places) || 0,
        tileFetches: Number(row.tileFetches) || 0,
      };
      counts.billable = BILLABLE_SURFACES.reduce((sum, key) => sum + counts[key], 0);
      return counts;
    },

    /** The whole retained tally, for a caller that wants a trend. */
    all: () => ({ ...load() }),

    /** Forget everything. Tests, and a user who wants a clean slate. */
    reset() {
      persist({});
    },
  };
}

/**
 * Compact count for a HUD that is already dense.
 *
 * Thousands are abbreviated because the tile count is the one that runs away —
 * a few minutes of flying is five figures — and "12.4k" carries the same
 * decision ("that is a lot") in a third of the characters.
 *
 * @param {number} value Count.
 * @returns {string} e.g. "812", "12.4k", "1.1M".
 */
export function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.floor(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * The HUD line.
 *
 * Shows BILLABLE events, and says TODAY. The free tile fetches are deliberately
 * NOT here — putting a five-figure number on a readout people are reading to
 * judge a bill implies a cost that does not exist. They live in the tooltip,
 * labelled free.
 *
 * @param {{sessions3d: number, places: number}} counts Today's counts.
 * @returns {string} e.g. "MAPS: 12 3D · 4 PLACES".
 */
export function formatUsageLine(counts) {
  const sessions = formatCount(counts?.sessions3d);
  const places = formatCount(counts?.places);
  return `MAPS: ${sessions} 3D · ${places} PLACES`;
}

/**
 * The hover text, which carries every caveat the one-line readout cannot.
 * @param {object} counts Today's counts.
 * @returns {string} Title text.
 */
export function usageTooltip(counts) {
  const free = formatCount(counts?.tileFetches);
  return `Billable Google Maps events from THIS BROWSER on ${counts?.day || 'today'}`
    + ` — ${formatCount(counts?.sessions3d)} 3D tile session(s) and`
    + ` ${formatCount(counts?.places)} Places call(s). A 3D session is one root-tileset`
    + ` request per page load, covering up to 3 hours; the ${free} individual tiles it`
    + ' streamed are free and unmetered.'
    + ' Quota day resets midnight US Pacific, matching Cloud Console.'
    + ' Not your account total: it cannot see other devices, other people, or'
    + ' anyone else using the key. For a real spend limit set an HTTP-referrer'
    + ' restriction and a per-API quota cap in Google Cloud Console.';
}
