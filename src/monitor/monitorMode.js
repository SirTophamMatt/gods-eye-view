/**
 * Monitor Mode — an unattended watch that flies the camera from hazard to
 * hazard as they are reported.
 *
 * The decisions it makes are not here. `monitorQueue.js` says what to look at
 * next and for how long; `polygonSummary.js` says what is inside a warning
 * area. This module is the loop, the camera, and the status strip — the parts
 * that need a globe and a clock and therefore cannot be unit-tested honestly.
 *
 * IT DRIVES THE EXISTING PANEL rather than growing its own. Selecting a target
 * dispatches the same `gev:entity-selected` event a click does, so the detail
 * panel opens exactly as it always has, and for an incident the response
 * timeline is opened on top of it. Duplicating that here would mean two
 * renderers for one answer, drifting apart from the first change onward.
 *
 * THE CAMERA IS YIELDED ON TOUCH. Any manual input — drag, wheel, touch —
 * pauses the cycle and leaves it paused until the operator resumes. An
 * unattended display that yanks the view back while someone is studying
 * something is worse than no automation at all, and "it moved on its own" is
 * the fastest way to lose trust in a mode like this.
 */

import * as Cesium from 'cesium';
import { createMonitorQueue, featureCentroid } from './monitorQueue.js';
import {
  approximateAreaKm2,
  formatAreaKm2,
  ringsOf,
  summarizeInside,
  summaryLines,
} from './polygonSummary.js';

/** PM layers Monitor Mode watches. Warnings first — they carry the areas. */
const WATCHED_LAYERS = Object.freeze([
  'local-pm-warn-emergency',
  'local-pm-warn-watch',
  'local-pm-warn-advice',
  'local-pm-warn-community',
  'local-pm-incident',
  'local-pm-burn',
]);

/** Layers offered as "what is inside this area", when they are switched on. */
const SUMMARY_SOURCES = Object.freeze([
  { layerId: 'local-pm-incident', label: 'Incidents' },
  { layerId: 'local-pm-burn', label: 'Burn areas' },
  { layerId: 'local-vicmap-fire-station', label: 'Fire stations' },
  { layerId: 'local-firms', label: 'Active fires' },
  { layerId: 'local-datacenters', label: 'Datacentres' },
  { layerId: 'local-dams', label: 'Dams' },
]);

/** Framing for a point target — close enough to read the street it is on. */
const POINT_ALTITUDE_M = 9000;
/** Multiplier on a polygon's radius, so the whole area sits inside the frame. */
const AREA_FRAMING_SCALE = 2.6;
const MIN_AREA_ALTITUDE_M = 8000;
/** Flight time between targets. Long enough to read as a move, not a cut. */
const FLY_SECONDS = 3.5;
/** Status-strip tick. The countdown is in seconds; finer buys nothing. */
const TICK_MS = 1000;

/**
 * Build Monitor Mode.
 *
 * @param {object} options
 * @param {object} options.viewer Cesium viewer.
 * @param {function(): number} [options.now] Injected clock.
 * @returns {object} Controller.
 */
export function createMonitorMode({ viewer, now = Date.now } = {}) {
  const queue = createMonitorQueue({ now });
  /** Latest snapshot per layer, keyed by layer id. */
  const snapshots = new Map();

  let running = false;
  let paused = false;
  let current = null;
  let dwellUntil = 0;
  let tickTimer = null;
  let inputHandlers = [];
  let strip = null;
  /** True while OUR flyTo is moving the camera, so it is not read as input. */
  let flying = false;

  /* ---------------------------------------------------------------- *
   * Target selection and camera
   * ---------------------------------------------------------------- */

  /** Everything currently visitable, pooled across the watched layers. */
  function rebuildPool() {
    const all = [];
    for (const layerId of WATCHED_LAYERS) {
      const snap = snapshots.get(layerId);
      if (snap?.features) all.push(...snap.features);
    }
    queue.setPool(all);
  }

  /** Fly to a target, framing an area or diving on a point. */
  async function flyToTarget(feature) {
    const centre = featureCentroid(feature);
    if (!centre || !viewer?.camera) return;
    const altitude = framingAltitude(feature);
    flying = true;
    try {
      // Bounded. `complete` is only called from the render loop, and the render
      // governor suspends that whenever the document is hidden — so on a
      // backgrounded wall display the callback never arrives and an unbounded
      // await would strand the cycle on its first target forever. The timeout
      // is the flight's own duration plus a margin: whatever the camera ended
      // up doing, by then it is time to get on with the dwell.
      await Promise.race([
        new Promise((resolve) => {
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(centre.lon, centre.lat, altitude),
            orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
            duration: FLY_SECONDS,
            complete: resolve,
            cancel: resolve,
          });
        }),
        new Promise((resolve) => { setTimeout(resolve, (FLY_SECONDS * 1000) + 1500); }),
      ]);
    } catch {
      /* a cancelled flight is normal — the operator took the camera */
    } finally {
      flying = false;
    }
  }

  /**
   * How high to sit above a target.
   *
   * A point gets a fixed height. An area is framed from its own extent, because
   * the whole reason to look at a warning polygon is its shape — diving to 9 km
   * over the centroid of a district-sized Watch and Act shows a paddock inside
   * it and none of the boundary.
   */
  function framingAltitude(feature) {
    const polygons = ringsOf(feature);
    if (polygons.length === 0) return POINT_ALTITUDE_M;
    const centre = featureCentroid(feature);
    if (!centre) return POINT_ALTITUDE_M;

    let maxKm = 0;
    for (const rings of polygons) {
      for (const point of rings[0] || []) {
        if (!Array.isArray(point)) continue;
        const [lon, lat] = point;
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const dLat = (lat - centre.lat) * 111.32;
        const dLon = (lon - centre.lon) * 111.32 * Math.cos(centre.lat * (Math.PI / 180));
        maxKm = Math.max(maxKm, Math.hypot(dLat, dLon));
      }
    }
    return Math.max(MIN_AREA_ALTITUDE_M, maxKm * 1000 * AREA_FRAMING_SCALE);
  }

  /* ---------------------------------------------------------------- *
   * Per-target presentation
   * ---------------------------------------------------------------- */

  /** Open the normal detail panel on this target, as a click would. */
  function selectTarget(feature) {
    const centre = featureCentroid(feature);
    if (!centre || typeof window === 'undefined') return;
    const props = feature?.properties || {};
    try {
      window.dispatchEvent(new CustomEvent('gev:entity-selected', {
        detail: {
          layerId: layerIdFor(feature),
          layerName: props.hazard === 'incident' ? 'PM Incidents' : 'PM Warnings',
          label: props.name,
          latitude: centre.lat,
          longitude: centre.lon,
          properties: props,
        },
      }));
    } catch {
      /* the panel is a bonus; the camera move is the mode */
    }
  }

  /** Which watched layer a feature came from, for the panel's scoping. */
  function layerIdFor(feature) {
    for (const layerId of WATCHED_LAYERS) {
      const snap = snapshots.get(layerId);
      if (snap?.features?.some((f) => f === feature)) return layerId;
    }
    return 'local-pm-incident';
  }

  /** Auto-open the response timeline for a point hazard. */
  function openResponseTimeline() {
    if (typeof document === 'undefined') return;
    const button = document.querySelector('#pm-detail-panel [data-action="brigades"]');
    if (button && !button.disabled) button.click();
  }

  /**
   * What is inside a warning area, from the layers that are actually on.
   *
   * A layer with no snapshot is reported as OFF rather than empty — see
   * `polygonSummary.js` for why that distinction is load-bearing.
   */
  function areaSummary(feature) {
    const groups = SUMMARY_SOURCES.map(({ layerId, label }) => {
      const snap = snapshots.get(layerId);
      if (!snap) return { key: layerId, label, enabled: false };
      return { key: layerId, label, enabled: true, records: snap.features };
    });
    return summarizeInside(feature, groups);
  }

  /* ---------------------------------------------------------------- *
   * Status strip
   * ---------------------------------------------------------------- */

  function ensureStrip() {
    if (strip && document.body.contains(strip)) return strip;
    const el = document.createElement('div');
    el.id = 'monitor-strip';
    el.className = 'monitor-strip';
    el.hidden = true;
    document.body.appendChild(el);
    strip = el;
    return el;
  }

  function renderStrip() {
    if (typeof document === 'undefined') return;
    const el = ensureStrip();
    if (!running) { el.hidden = true; return; }
    el.hidden = false;

    if (!current) {
      el.innerHTML = `<div class="monitor-strip-head">MONITOR</div>`
        + `<div class="monitor-strip-body">Watching — nothing to visit yet.</div>`
        + monitorControls();
      wireControls();
      return;
    }

    const props = current.feature.properties || {};
    const secondsLeft = Math.max(0, Math.round((dwellUntil - now()) / 1000));
    const level = String(props.warningLevel || props.status || props.hazard || '').trim();
    const area = approximateAreaKm2(current.feature);

    const inside = area
      ? `<div class="monitor-strip-inside">${summaryLines(areaSummary(current.feature))
        .map((line) => `<div>${escapeHtml(line)}</div>`).join('')}</div>`
      : '';

    el.innerHTML = `
      <div class="monitor-strip-head">
        MONITOR${paused ? ' · PAUSED' : ''}
        ${current.reason === 'new' ? '<span class="monitor-new">NEW</span>' : ''}
      </div>
      <div class="monitor-strip-title">${escapeHtml(props.name || 'Unnamed')}</div>
      <div class="monitor-strip-body">
        ${escapeHtml(level)}${area ? ` · ${escapeHtml(formatAreaKm2(area))}` : ''}
        · ${paused ? 'paused' : `${secondsLeft}s`}
        · ${queue.size()} tracked${queue.pendingCount() ? ` · ${queue.pendingCount()} new` : ''}
      </div>
      ${inside}
      ${monitorControls()}`;
    wireControls();
  }

  function monitorControls() {
    return `<div class="monitor-strip-actions">
      <button type="button" data-monitor="toggle">${paused ? 'Resume' : 'Pause'}</button>
      <button type="button" data-monitor="skip">Skip</button>
      <button type="button" data-monitor="stop">Stop</button>
    </div>`;
  }

  function wireControls() {
    if (!strip) return;
    strip.querySelector('[data-monitor="toggle"]')?.addEventListener('click', () => {
      if (paused) api.resume(); else api.pause();
    });
    strip.querySelector('[data-monitor="skip"]')?.addEventListener('click', () => { void advance(); });
    strip.querySelector('[data-monitor="stop"]')?.addEventListener('click', () => api.stop());
  }

  /* ---------------------------------------------------------------- *
   * The loop
   * ---------------------------------------------------------------- */

  async function advance() {
    if (!running) return;
    const target = queue.next();
    if (!target) {
      current = null;
      renderStrip();
      return;
    }
    current = target;
    dwellUntil = now() + target.dwellMs;
    renderStrip();

    await flyToTarget(target.feature);
    if (!running || current !== target) return;

    selectTarget(target.feature);
    // A point hazard gets its response; an area gets the contents summary that
    // is already in the strip.
    if (ringsOf(target.feature).length === 0) {
      setTimeout(openResponseTimeline, 400);
    }
    // The dwell clock starts when we ARRIVE, not when we set off: a 3.5 s
    // flight should not eat 3.5 s of the two minutes meant for reading.
    dwellUntil = now() + target.dwellMs;
    renderStrip();
  }

  function tick() {
    if (!running || paused) return;
    if (!current || now() >= dwellUntil) {
      void advance();
      return;
    }
    renderStrip();
  }

  /* ---------------------------------------------------------------- *
   * Input yielding
   * ---------------------------------------------------------------- */

  function attachInputYield() {
    const canvas = viewer?.scene?.canvas;
    if (!canvas) return;
    const yieldCamera = () => {
      // Our own flight moves the camera too; only a human pauses the mode.
      if (!running || paused || flying) return;
      api.pause();
    };
    for (const type of ['pointerdown', 'wheel', 'touchstart']) {
      canvas.addEventListener(type, yieldCamera, { passive: true });
      inputHandlers.push([canvas, type, yieldCamera]);
    }
  }

  function detachInputYield() {
    for (const [el, type, handler] of inputHandlers) el.removeEventListener(type, handler);
    inputHandlers = [];
  }

  /* ---------------------------------------------------------------- *
   * Layer plumbing
   * ---------------------------------------------------------------- */

  function onLayerRefreshed(event) {
    const detail = event?.detail;
    if (!detail?.layerId) return;
    // Snapshots are recorded whether or not the mode is running. Listening only
    // while running means switching the mode on after the layers have loaded
    // finds an empty pool and sits idle until the next two-minute poll — which
    // is exactly how anyone would actually turn it on.
    snapshots.set(detail.layerId, detail);
    if (!running) return;
    if (WATCHED_LAYERS.includes(detail.layerId)) {
      rebuildPool();
      // Arrivals interrupt. `added` excludes the first payload and excludes a
      // record returning inside its grace period — see featureRetention.js.
      const geo = (detail.added || []).map(toGeoFeature).filter(Boolean);
      if (geo.length) queue.enqueueNew(geo);
    }
    renderStrip();
  }

  /** The refresh event carries flat records; the queue wants GeoJSON-ish. */
  function toGeoFeature(record) {
    if (!record) return null;
    if (record.geometry) return record;
    if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon)) return null;
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [record.lon, record.lat] },
      properties: record.properties || {},
    };
  }

  /* ---------------------------------------------------------------- *
   * Public surface
   * ---------------------------------------------------------------- */

  if (typeof window !== 'undefined') {
    window.addEventListener('gev:layer-refreshed', onLayerRefreshed);
  }

  const api = {
    isRunning: () => running,
    isPaused: () => paused,
    currentTarget: () => (current ? current.feature : null),

    start() {
      if (running) return false;
      running = true;
      paused = false;
      queue.resetCycle();
      rebuildPool();

      attachInputYield();
      tickTimer = setInterval(tick, TICK_MS);
      renderStrip();
      void advance();
      return true;
    },

    stop() {
      running = false;
      paused = false;
      current = null;
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      detachInputYield();
      renderStrip();
      return true;
    },

    pause() {
      if (!running || paused) return false;
      paused = true;
      renderStrip();
      return true;
    },

    resume() {
      if (!running || !paused) return false;
      paused = false;
      // Resume where the operator left off rather than restarting the dwell:
      // they paused to look, and the target has not changed.
      if (!current || now() >= dwellUntil) void advance();
      renderStrip();
      return true;
    },

    /** Skip to the next target immediately. */
    skip() {
      if (!running) return false;
      void advance();
      return true;
    },
  };

  return api;
}

/**
 * Mount the MONITOR toggle and bind it to a controller.
 *
 * A standalone control rather than a dock tray: the dock's trays are pinnable
 * popovers built from a shared structure, and Monitor Mode is a running state
 * with a status readout, not a panel of settings. It sits beside its own strip
 * so the button and what it produced are read together.
 *
 * @param {object} monitor Controller from `createMonitorMode`.
 * @returns {HTMLElement|null} The button, or null without a DOM.
 */
export function mountMonitorControl(monitor) {
  if (typeof document === 'undefined' || !monitor) return null;
  const existing = document.getElementById('monitor-toggle');
  if (existing) return existing;

  const button = document.createElement('button');
  button.id = 'monitor-toggle';
  button.className = 'monitor-toggle';
  button.type = 'button';
  button.textContent = 'MONITOR';
  button.title = 'Cycle the camera through live incidents and warnings, '
    + 'newest first. Any manual camera input pauses it.';
  button.setAttribute('aria-pressed', 'false');

  button.addEventListener('click', () => {
    if (monitor.isRunning()) monitor.stop(); else monitor.start();
    const on = monitor.isRunning();
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
  });

  document.body.appendChild(button);
  return button;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
