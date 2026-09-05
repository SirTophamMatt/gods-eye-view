import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  selectEntityContext,
} from './contextStore.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  STALE_FOR_PROPERTY,
  STALE_PROPERTY,
  createRetentionTracker,
  featureKey,
} from './featureRetention.js';

/** Property carrying a feature's retention identity onto its entity. */
const KEY_PROPERTY = 'gevKey';

/**
 * The first coordinate pair of any geometry, as a flat anchor.
 * A polygon's first vertex is not its centroid; for a containment counter that
 * only needs A point on the record, it is enough, and it is deterministic.
 * @param {object} geometry GeoJSON geometry.
 * @returns {[number, number]|null} [lon, lat], or null.
 */
function firstCoordinateOf(geometry) {
  let node = geometry?.coordinates;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!Array.isArray(node)) return null;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') return [node[0], node[1]];
    node = node[0];
  }
  return null;
}

const DEFAULT_LABEL_MAX = 900;
const DEFAULT_LABEL_GRID_PX = 132;
const VISIBILITY_UPDATE_MS = 450;
// Each source keeps its own bounded cohort; the host sums their ambient-card
// paint budgets only up to its 192-card shared-lane ceiling.
export const LOCAL_OVERLAY_COHORT_LIMIT = 160;
const LOCAL_OVERLAY_COLLISION_CAPACITY = 96;
const LOCAL_OVERLAY_CELL_SURPLUS = 2;
const LOCAL_OVERLAY_MAX_DISTANCE_M = 14000000;
const LOCAL_OVERLAY_FADE_START_M = 250000;
const LOCAL_OVERLAY_FADE_START_RATIO = LOCAL_OVERLAY_FADE_START_M / LOCAL_OVERLAY_MAX_DISTANCE_M;
// Stems are anchored at ellipsoid height 0, but high-elevation features
// (e.g. dams in river canyons) sit hundreds of meters above the ellipsoid,
// burying the short close-in stem inside the photoreal mesh. Once the
// camera is near enough for tiles to be loaded, sample the real surface
// height once per feature and lift the stem onto it.
const GROUND_SAMPLE_MAX_DISTANCE_M = 75000;
const GROUND_SAMPLE_RETRY_MS = 2000;
const GROUND_SAMPLE_MAX_ABS_HEIGHT_M = 9000;
/**
 * Bounded give-up for the self-armed retry. Sampling can be SUPPORTED and still
 * never succeed (no sampleable surface under the feature), in which case each
 * requested frame would arm the next 2 s timer forever — an idle-governor leak
 * dressed up as a retry. After this many consecutive armed retries with no
 * record newly grounded, stop arming; camera motion (a frame we get for free)
 * still retries through the normal preRender walk and re-opens the budget.
 * 30 × 2 s ≈ 60 s, far longer than a tile stream-in.
 */
export const GROUND_SAMPLE_MAX_ARMED_RETRIES = 30;
/**
 * Fill alpha for `outlineOnly` layers. Hazard polygons sit at 0.3 because
 * there are a handful of them and each one is the point; boundary polygons
 * tessellate a whole state, so their fill is only ever a faint region wash and
 * a pick surface — the outline carries the meaning. Three boundary layers
 * stacked still tint the globe less than one hazard polygon does.
 */
const BOUNDARY_FILL_ALPHA = 0.05;
/** Ground-clamped boundary stroke, in pixels. */
const BOUNDARY_OUTLINE_WIDTH_PX = 2;
/**
 * Camera framing when a boundary is clicked: fill the view with the region
 * rather than diving to the fixed 5 km a point feature gets. A click on an
 * LGA means "show me this LGA", and 5 km over the centroid of Mildura Rural
 * City shows a paddock.
 */
const BOUNDARY_FRAMING_RADIUS_SCALE = 2.2;
const BOUNDARY_MIN_FRAMING_HEIGHT_M = 5000;
/** Ignore sub-metre camera-derived stem-tip noise at camera settle. */
export const LOCAL_STEM_TIP_EPSILON_M = 0.5;
const LOCAL_STEM_TIP_EPSILON_SQ = LOCAL_STEM_TIP_EPSILON_M ** 2;

const DEFAULT_OVERLAY_HOST = Object.freeze({
  clearSource: clearOverlaySource,
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
});

/**
 * Build the validated local-infrastructure card copy.
 * @param {object} properties Unwrapped GeoJSON feature properties.
 * @param {string} layerId Local layer id.
 * @returns {{title:string,details:string[]}}
 */
export function localInfrastructureOverlayCopy(properties, layerId) {
  const props = unwrapProperties(properties) || {};
  const tags = props.tags || {};
  const title = featureLabelFromProperties(props, layerId);
  const details = [];

  if (layerId === 'local-datacenters') {
    const operator = firstClean([
      tags.operator,
      props.operator,
      tags['operator:short'],
    ]);
    const capacity = firstClean([
      tags['capacity:it_load'],
      tags.it_load,
      tags.capacity,
      props.capacity,
    ]);
    const line = [operator, capacity]
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .filter((value) => value.toLocaleLowerCase() !== title.toLocaleLowerCase())
      .join(' · ');
    if (line) details.push(clampCardLine(line));
  } else if (layerId === 'local-dams') {
    const river = firstClean([
      tags.associated_river,
      props.associated_river,
      tags.river,
      props.river,
      tags['river:name'],
    ]);
    if (river && river.toLocaleLowerCase() !== title.toLocaleLowerCase()) {
      details.push(clampCardLine(river));
    }
  } else if (layerId.startsWith('local-pm-') || layerId.startsWith('local-vicmap-')) {
    // Passive Monitor exports a normalized (status, detail) pair on every
    // hazard, so one branch serves fire, flood, storm and power alike. `status`
    // is the operational state ("Watch and Act", "Minor"); `detail` is the
    // measurement context ("296 ha · 12 resources"). Both are pre-composed by
    // scripts/export-passive-monitor.mjs, and either may be absent.
    //
    // The Vicmap Admin boundary layers deliberately emit the SAME pair from
    // scripts/export-vicmap-admin.mjs — status is the kind of unit ("Local
    // government area"), detail its code ("LGA 328") — so the two exporters
    // share this branch rather than each growing their own.
    const status = firstClean([props.status]);
    if (status && status.toLocaleLowerCase() !== title.toLocaleLowerCase()) {
      details.push(clampCardLine(status));
    }
    const detail = firstClean([props.detail]);
    if (detail) details.push(clampCardLine(detail));
    // A held record has to say so on the card itself. It is being drawn after
    // its feed stopped listing it, and a reader looking at the globe has no
    // other way to tell it apart from a current one.
    if (props[STALE_PROPERTY]) {
      const minutes = Math.max(1, Math.round(Number(props[STALE_FOR_PROPERTY] || 0) / 60000));
      details.push(clampCardLine(`NOT IN LAST UPDATE · ${minutes} min`));
    }
  }

  return { title, details };
}

/**
 * Produce one normalized-contract input owned by a local infrastructure layer.
 * The host revalidates the authoritative `source` value while normalizing it.
 * @param {object} options
 * @param {string} options.id Stable id within the source.
 * @param {string} options.layerId Local layer id.
 * @param {Cesium.Cartesian3} options.position Current stem-tip position.
 * @param {object} options.properties Unwrapped feature properties.
 * @param {number} options.priority Source-owned importance score.
 * @param {string} options.accent Source accent color.
 * @returns {object}
 */
export function createLocalInfrastructureOverlayEntry({
  id,
  layerId,
  position,
  properties,
  priority,
  accent,
}) {
  const copy = localInfrastructureOverlayCopy(properties, layerId);
  return {
    id: String(id),
    source: layerId,
    position,
    variant: 'card',
    title: copy.title,
    details: copy.details,
    accent,
    priority,
    collisionGroup: 'ambient-card',
    zIndex: 30,
    interactive: false,
    minDistance: 0,
    maxDistance: LOCAL_OVERLAY_MAX_DISTANCE_M,
    distanceFadeStartRatio: LOCAL_OVERLAY_FADE_START_RATIO,
    distanceScale: {
      near: 250000,
      nearValue: 1,
      far: 9000000,
      farValue: 0.62,
    },
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    placement: 'above',
  };
}

/**
 * Retain a bounded screen-grid surplus for the host's final rectangle arbiter.
 * Two deterministic contenders per legacy grid cell preserve the old density
 * while giving the shared solver an alternative when the first card collides.
 * @param {object[]} records Local stem/entry records.
 * @param {object} options
 * @param {number} options.maxEntries Legacy source cap.
 * @param {number} options.gridPx Legacy screen grid size.
 * @param {number} options.width Viewport width in CSS pixels.
 * @param {number} options.height Viewport height in CSS pixels.
 * @param {function(object):({x:number,y:number}|null)} options.project Projection callback.
 * @param {number} [options.cohortLimit=Infinity] Host-safe materialization cap.
 * @returns {object[]} Bounded overlay entries for shared-host arbitration.
 */
export function selectLocalInfrastructureOverlayCohort(records, {
  maxEntries,
  gridPx,
  width,
  height,
  project,
  cohortLimit = Number.POSITIVE_INFINITY,
}) {
  const sourceCap = Math.max(0, Math.floor(Number(maxEntries) || 0));
  const materializationCap = Number.isFinite(Number(cohortLimit))
    ? Math.max(0, Math.floor(Number(cohortLimit)))
    : Number.POSITIVE_INFINITY;
  const cap = Math.min(sourceCap, materializationCap);
  const cellSize = Math.max(1, Number(gridPx) || 1);
  if (!Array.isArray(records) || records.length === 0 || cap === 0 || typeof project !== 'function') {
    return [];
  }

  const cells = new Map();
  const padding = cellSize;
  for (const record of records) {
    const screen = project(record);
    if (!Number.isFinite(screen?.x) || !Number.isFinite(screen?.y)) continue;
    if (screen.x < -padding || screen.x > width + padding
      || screen.y < -padding || screen.y > height + padding) continue;
    const key = `${Math.floor(screen.x / cellSize)}:${Math.floor(screen.y / cellSize)}`;
    let contenders = cells.get(key);
    if (!contenders) {
      contenders = [];
      cells.set(key, contenders);
    }
    insertLocalCellContender(contenders, record);
  }

  const primary = [];
  const surplus = [];
  for (const contenders of cells.values()) {
    if (contenders[0]) primary.push(contenders[0]);
    if (contenders[1]) surplus.push(contenders[1]);
  }
  primary.sort(compareLocalOverlayRecords);
  surplus.sort(compareLocalOverlayRecords);
  if (primary.length >= cap) return primary.slice(0, cap).map((record) => record.entry);
  const candidates = primary.concat(surplus.slice(0, cap - primary.length));
  return candidates.map((record) => record.entry);
}

/**
 * Bind a local layer's visibility and entry lifecycle to the shared host.
 * @param {object} options
 * @param {string} options.sourceId Local layer id.
 * @param {object} [options.host] Test seam for the three host lifecycle calls.
 * @returns {{show:function():void,publish:function(object[]):void,hide:function():void,destroy:function():void}}
 */
export function createLocalInfrastructureOverlayPublisher({
  sourceId,
  host = DEFAULT_OVERLAY_HOST,
}) {
  let visible = false;
  let published = false;
  let destroyed = false;
  const sourceOptions = {
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    collisionCapacity: LOCAL_OVERLAY_COLLISION_CAPACITY,
    moving: false,
  };

  return {
    show() {
      if (destroyed || visible) return;
      visible = true;
      host.setVisible(sourceId, true);
    },
    publish(entries) {
      if (destroyed || !visible) return;
      host.setEntries(sourceId, entries, sourceOptions);
      published = entries.length > 0;
    },
    hide() {
      if (destroyed) return;
      if (published) host.clearSource(sourceId);
      if (visible) host.setVisible(sourceId, false);
      visible = false;
      published = false;
    },
    destroy() {
      if (destroyed) return;
      if (published) host.clearSource(sourceId);
      if (visible) host.setVisible(sourceId, false);
      visible = false;
      published = false;
      destroyed = true;
    },
  };
}

/**
 * Reduce a bundled-dataset load failure to one short, honest stats string.
 *
 * These layers ship their data with the build, so a failure means the asset
 * is missing (404 / bad path) or corrupt — never "the network is slow". Both
 * must reach the user's chip; the raw parser message is console-only because
 * a truncated JSON blob is not a status line.
 *
 * @param {Error|{name?:string, message?:string}|null|undefined} error - The thrown load failure.
 * @returns {string} Short reason for getStats().error.
 */
export function localDatasetError(error) {
  if (error?.name === 'SyntaxError') return 'dataset is malformed';
  const message = String(error?.message || '').trim();
  return message ? `dataset unavailable (${message})` : 'dataset unavailable';
}

/**
 * A minimal, rock-solid native implementation for loading local GeoJSON Data.
 * Draws 3D stems (polylines) attached to Point entities and ensures
 * standard scene.pick natively clicks them.
 *
 * `outlineOnly` switches to the BOUNDARY presentation instead. The stem-and-
 * point treatment says "a thing is HERE", which is right for a dam or an
 * incident and wrong for an administrative region: a tessellating boundary set
 * would grow one 2 km stem per council and paint the state opaque at the
 * hazard-layer fill alpha. Boundary layers instead draw as a ground-clamped
 * outline over a barely-there wash, with the label resting on the centroid.
 * See BOUNDARY_FILL_ALPHA and the entity loop below.
 *
 * `styleFeature(properties)` overrides colour and size PER RECORD, returning
 * `{color, pixelSize}` (either optional). One style per layer is right when
 * every record means the same thing; a layer where they do not — flood gauges,
 * where three of 319 are above their flood level — needs the three that matter
 * to be findable. The returned colour also becomes that record's card accent,
 * so the dot and its label agree.
 */
export function createLocalGeoJsonLayer({
  id,
  url,
  name,
  color,
  icon = '📍',
  source = 'Local JSONL',
  outlineOnly = false,
  styleFeature = null,
  /**
   * Re-fetch cadence, ms. 0 — the default, and every bundled snapshot — keeps
   * the one-shot load this factory has always done: a file that ships with the
   * build cannot change under a running session, so polling it is pure waste.
   * Only a layer whose `url` is a LIVE endpoint has anything to gain.
   */
  refreshMs = 0,
  /**
   * How long a feature absent from a refresh is still drawn, ms. 0 disables
   * retention, and the payload passes through untouched — see
   * `featureRetention.js` for why a live hazard feed wants a grace period and
   * a static snapshot does not.
   */
  retentionMs = 0,
  labels = true,
  labelMax = DEFAULT_LABEL_MAX,
  labelGridPx = DEFAULT_LABEL_GRID_PX,
  overlayHost = DEFAULT_OVERLAY_HOST,
  screenSpaceEventHandlerFactory = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
  projectToWindow = (scene, position) => Cesium.SceneTransforms.worldToWindowCoordinates(scene, position),
}) {
  let _dataSource = null;
  let _enabled = false;
  let _clickHandler = null;
  let _count = 0;
  /** How many of `_count` are being held past their feed, not currently live. */
  let _retainedCount = 0;
  /** Features this load saw for the first time; announced, then cleared. */
  let _lastAdded = [];
  /**
   * The parsed GeoJSON this layer last built from.
   *
   * Kept as the FEATURES rather than rebuilt from Cesium entities. An entity
   * knows its position but not its ring, and a warning area without its ring is
   * useless to anything asking what is inside it — which is most of why the
   * refresh is announced at all.
   */
  let _lastFeatures = [];
  /** @type {number|null} Timestamp of the last successful dataset load. */
  let _lastUpdate = null;
  /** @type {string|null} Short reason the bundled dataset failed to load. */
  let _error = null;
  let _preRenderRemover = null;
  let _cameraMoveEndRemover = null;
  let _stemRecords = [];
  let _stemGeometryDirty = true;
  let _lastVisibilityUpdate = 0;
  let _destroyed = false;
  /** Guards against a slow poll stacking on the one before it. */
  let _refreshing = false;
  const _retention = createRetentionTracker({ retentionMs });
  let _groundRetryTimer = null;
  /** Consecutive self-armed retries since the last grounding/camera motion. */
  let _groundRetryArms = 0;
  /** Last observed scene.sampleHeightSupported; null until the first walk. */
  let _lastGroundSampleCapability = null;

  /**
   * Coalesced one-shot: ask the governor for a frame once the retry window
   * has elapsed, so the preRender ground-sample retry actually runs while the
   * camera is parked. One timer for the whole layer (not per record) — the
   * retry pass walks every record anyway. (perf rebase 2026-08-17)
   *
   * Two gates keep this from becoming an idle leak (second review):
   *   - CAPABILITY: without `scene.sampleHeightSupported` the sample can never
   *     succeed, so a timer here would re-arm on every requested frame,
   *     forever. Records simply stay at ellipsoid height — exactly the
   *     pre-perf keyless behavior.
   *   - BUDGET: sampling can be supported and still keep failing (no sampleable
   *     surface yet/ever). Give up after GROUND_SAMPLE_MAX_ARMED_RETRIES
   *     consecutive arms; free camera-motion frames still retry.
   * @param {Cesium.Viewer} viewer
   * @returns {void}
   */
  function scheduleGroundRetryRender(viewer) {
    if (_groundRetryTimer || !_enabled) return;
    if (!viewer?.scene?.sampleHeightSupported) return;
    if (_groundRetryArms >= GROUND_SAMPLE_MAX_ARMED_RETRIES) return;
    _groundRetryArms += 1;
    _groundRetryTimer = setTimeout(() => {
      _groundRetryTimer = null;
      if (!_enabled || _destroyed) return;
      governorRequestRender(`local-ground-retry:${id}`);
    }, GROUND_SAMPLE_RETRY_MS);
  }

  function clearGroundRetryRender() {
    _groundRetryArms = 0;
    _lastGroundSampleCapability = null;
    if (!_groundRetryTimer) return;
    clearTimeout(_groundRetryTimer);
    _groundRetryTimer = null;
  }
  const _overlayPublisher = createLocalInfrastructureOverlayPublisher({
    sourceId: id,
    host: overlayHost,
  });

  const disableLayer = (viewer) => {
    _enabled = false;
    clearGroundRetryRender();
    if (_dataSource) _dataSource.show = false;
    _overlayPublisher.hide();
    clearSelectedEntityContextForLayer(id);
    if (viewer?.selectedEntity?.__localLayerId === id) {
      viewer.selectedEntity = undefined;
    }
    if (_preRenderRemover) {
      _preRenderRemover();
      _preRenderRemover = null;
    }
    if (_cameraMoveEndRemover) {
      _cameraMoveEndRemover();
      _cameraMoveEndRemover = null;
    }
  };

  const api = {
    id,
    name,
    icon,
    source,
    // The manager arms its own interval off this (see manager.js
    // `_armUpdateLoop`); 0 keeps the stats-only tick a static layer wants.
    updateInterval: refreshMs,
    statsRefreshInterval: 1000,

    init: async (viewer) => {
      // DataLayerManager calls this once
    },

    update: async (viewer) => {
      // Called on `updateInterval` while enabled. A no-op for the snapshot
      // layers, which never set refreshMs.
      await refreshLayer(viewer);
    },

    /**
     * @returns {{count:number, retained:number, lastUpdate:number|null, error:string|null}}
     *   A dead layer must be distinguishable from an empty one: a failed load
     *   surfaces `error` (manager chip → UNAVAILABLE) instead of reporting a
     *   silent zero count as nominal. `retained` is how many of `count` are
     *   being held past their feed rather than currently listed by it.
     */
    getStats: () => {
      return {
        count: _count, retained: _retainedCount, lastUpdate: _lastUpdate, error: _error,
      };
    },

    enable: async (viewer) => {
      if (_destroyed) return;
      _enabled = true;
      _stemGeometryDirty = true;
      _lastVisibilityUpdate = Number.NEGATIVE_INFINITY;
      _groundRetryArms = 0; // fresh give-up budget per enable-cycle
      _lastGroundSampleCapability = null;
      _overlayPublisher.show();

      // 1. Initialize data source
      if (!_dataSource) {
        const baseColor = Cesium.Color.fromCssColorString(color);

        // Fetch and parse JSON Lines (.geojsonl) into a FeatureCollection.
        // The source is built into a local and committed to `_dataSource`
        // only once setup finishes: a half-built source published early would
        // make every later enable() skip this block, so the layer could never
        // clear its error or retry.
        _error = null;
        let loaded = null;
        // Whether the scene has actually accepted `loaded` — the two rollback
        // windows (before vs after the add settles) need different cleanup.
        let addedToScene = false;
        try {
          const response = await fetch(url);
          // A 404 returns an HTML body that would otherwise die in JSON.parse
          // one line later, reported as a parse error for a missing file.
          if (!response.ok) {
            throw new Error(`HTTP ${response.status ?? '?'}`);
          }
          const text = await response.text();
          // Two wire formats, because a layer's `url` can point at either a
          // bundled .geojsonl snapshot or a live API:
          //
          //   JSON Lines        one Feature per line — what the committed
          //                     snapshots use, and what this loader has always
          //                     read.
          //   FeatureCollection a single JSON object — what a conventional
          //                     GeoJSON endpoint serves.
          //
          // Sniffing the body rather than configuring the format per layer is
          // what lets a live source be swapped in by changing ONLY the URL.
          // A FeatureCollection is detected structurally, not by Content-Type,
          // so a proxy that rewrites headers cannot break the parse.
          // NOT sniffed by first character: JSON Lines also begins with '{',
          // so a leading-brace test sends every snapshot down the single-
          // document path and dies parsing line two. Instead try the whole body
          // as ONE document and accept it only if it is actually a collection;
          // anything else — including a parse failure, which is the normal
          // outcome for multi-line JSONL — falls through to line-by-line.
          const trimmed = text.trim();
          let features = null;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && Array.isArray(parsed.features)) {
              features = parsed.features;      // FeatureCollection (live API)
            } else if (Array.isArray(parsed)) {
              features = parsed;               // bare Feature array
            }
            // A lone Feature object falls through: it is a one-line JSONL file.
          } catch {
            // Not a single JSON document. Expected for JSONL — not an error.
          }
          if (!features) {
            features = trimmed
              .split('\n')
              .filter((l) => l.trim().length > 0)
              .map((line) => JSON.parse(line));
          }

          // Hold anything the feed has just dropped, for as long as the layer
          // is configured to. A no-op at retentionMs 0, which is every bundled
          // snapshot, so this cannot change how a static layer loads.
          const reconciled = _retention.reconcile(features, Date.now());
          features = reconciled.features;
          _retainedCount = reconciled.retained;
          _lastAdded = reconciled.added;

          // Stamp each feature with its retention identity so the entity built
          // from it can be found again after a refresh replaces the source —
          // which is what lets an open selection survive a poll.
          if (retentionMs > 0 || refreshMs > 0) {
            features = features.map((feature) => ({
              ...feature,
              properties: { ...(feature?.properties || {}), [KEY_PROPERTY]: featureKey(feature) },
            }));
          }

          _lastFeatures = features;

          const geojson = {
            type: 'FeatureCollection',
            features
          };

          // Natively parse into entities and use it as our _dataSource
          loaded = await Cesium.GeoJsonDataSource.load(geojson, {
            clampToGround: true,
            stroke: baseColor,
            fill: baseColor.withAlpha(outlineOnly ? BOUNDARY_FILL_ALPHA : 0.3),
            strokeWidth: 2,
            markerSize: 8,
            markerColor: baseColor,
          });

          loaded.name = name;
          loaded.show = false;
          // Cesium's DataSourceCollection.add() returns a promise and only
          // inserts on a later microtask. Without this await, a throw during
          // post-processing would roll back a source the scene had not
          // accepted yet — and Cesium would then insert the "removed" source
          // anyway, leaving an orphan the retry would double up on. Awaiting
          // also routes an add() rejection into the error path below instead
          // of leaving it uncaught with healthy-looking stats.
          await viewer.dataSources.add(loaded);
          addedToScene = true;

          // Convert parsed points into 3D stems or style polygons
          const entities = loaded.entities.values;
          _count = entities.length;
          _stemRecords = [];
          _stemGeometryDirty = true;
          /**
           * Hole rings awaiting their own stroke entity. Collected during the
           * walk and added after it: `entities` is the live collection being
           * iterated, and adding to it mid-loop would walk the additions.
           * @type {Cesium.Cartesian3[][]}
           */
          const boundaryHoleRings = [];

          for (let i = 0; i < entities.length; i++) {
            const feature = entities[i];
            feature.__localLayerId = id; // Tag it so our click handler knows it belongs to this layer
            
            let pos = feature.position?.getValue(Cesium.JulianDate.now());
            /** Outer ring of a polygon feature — the boundary stroke's path. */
            let outerRing = null;

            if (!pos) {
              // It's a polygon or line
              if (feature.polygon) {
                feature.polygon.outline = true;
                feature.polygon.outlineColor = baseColor;

                // Calculate center point for the stem
                const hierarchy = feature.polygon.hierarchy?.getValue(Cesium.JulianDate.now());
                if (hierarchy && hierarchy.positions && hierarchy.positions.length > 0) {
                  pos = Cesium.BoundingSphere.fromPoints(hierarchy.positions).center;
                  outerRing = hierarchy.positions;
                  if (outlineOnly) collectHoleRings(hierarchy, boundaryHoleRings);
                }
              }
            }

            if (!pos) continue;

            const carto = Cesium.Cartographic.fromCartesian(pos);
            const groundHeight = 0; // Ellipsoid surface until a scene sample lands
            // Boundary labels rest on the centroid; only stems climb.
            const tipHeight = outlineOnly ? groundHeight : 2000; // Initial Stem height

            const base = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, groundHeight);
            const tip = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, tipHeight);
            const properties = propertyObject(feature);
            const recordId = String(feature.id ?? i);
            /** Per-feature accent, so a styled record card matches its dot. */
            let accentOverride = null;

            // Store references for bounded stem scaling and native picking.
            feature.__localBaseCarto = carto;
            feature.__localBaseCartesian = base;
            registerEntityContext(feature, {
              id: `${id}:${recordId}`,
              layerId: id,
              layerName: name,
              source,
              dataSource: loaded,
              label: featureLabelFromProperties(properties, id),
              properties,
              latitude: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(6)),
              longitude: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(6)),
            });

            // Constant properties are refreshed on the existing 450 ms source
            // cadence. Cesium no longer evaluates 2-3 callbacks per entity on
            // every frame, while the point/stem pick surface stays native.
            const stemPositionBuffers = [[base, tip], [base, tip]];
            if (outlineOnly) {
              // A ground-clamped polygon draws NO outline: Cesium classifies
              // the fill onto the terrain and drops `polygon.outline` entirely,
              // which is why the boundary is stroked as its own ground-clamped
              // polyline over the outer ring rather than by setting a width on
              // the polygon above.
              if (outerRing) {
                feature.polyline = new Cesium.PolylineGraphics({
                  positions: outerRing,
                  width: BOUNDARY_OUTLINE_WIDTH_PX,
                  clampToGround: true,
                  material: new Cesium.ColorMaterialProperty(baseColor),
                });
              }
              // Hole rings were collected above and are stroked after this
              // loop. It is tempting to skip them on the theory that a hole in
              // one region is the outer ring of its neighbour — but that is
              // not true of the real data: an enclave can sit in a layer that
              // does not tessellate (the FRV districts have four), and even
              // where a neighbour does exist, generalisation simplifies its
              // outer ring and the hole ring independently, so the two traces
              // diverge. Skipping them leaves visible gaps in the border
              // around alpine resorts and enclave councils.
            } else {
              // Per-feature styling, where a layer asked for it. One colour
              // and one size per LAYER is right when every record means the
              // same thing, and wrong for a layer whose whole point is that
              // they do not: 316 flood gauges below their flood level and 3
              // above are one undifferentiated field of dots otherwise, and
              // the three that matter are the ones you cannot find.
              const style = styleFeature ? styleFeature(properties) || {} : {};
              const pointColor = style.color ? Cesium.Color.fromCssColorString(style.color) : baseColor;
              const pixelSize = Number.isFinite(style.pixelSize) ? style.pixelSize : 10;

              feature.position = tip;
              feature.polyline = new Cesium.PolylineGraphics({
                positions: stemPositionBuffers[0],
                width: 3.5,
                material: new Cesium.ColorMaterialProperty(pointColor),
              });
              feature.point = new Cesium.PointGraphics({
                pixelSize,
                color: pointColor,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                // Never depth-cull the anchor against the photoreal mesh —
                // globe-horizon culling is handled by the pre-render occluder.
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              });
              if (style.color) accentOverride = style.color;
            }

            const priority = labelPriorityFromProperties(properties, id);
            _stemRecords.push({
              id: recordId,
              entity: feature,
              carto,
              base,
              tip,
              nextTip: Cesium.Cartesian3.clone(tip),
              stemPositionBuffers,
              stemPositionBufferIndex: 0,
              groundHeight,
              // A boundary has no stem to scale and nothing to lift onto the
              // mesh — Cesium clamps its outline and fill to the terrain
              // itself. Recording it as already-grounded is what keeps it out
              // of the whole sample/retry/re-arm path, which would otherwise
              // spend a distance check per record per walk, and arm frames on
              // a parked camera, for records it can never change.
              groundSampled: outlineOnly,
              stemless: outlineOnly,
              lastGroundSampleMs: 0,
              priority,
              entry: labels ? createLocalInfrastructureOverlayEntry({
                id: recordId,
                layerId: id,
                position: tip,
                properties,
                priority,
                accent: accentOverride || color,
              }) : null,
            });
          }

          // Deliberately untagged (no `__localLayerId`) and deliberately not a
          // stem record: an enclave border is a line to look at, not a feature
          // to click or label — the enclave itself is a named feature of its
          // own layer, and it owns the card. Untagged also means the click
          // handler's layer test skips them, so picking one selects nothing
          // rather than a context entry that was never registered.
          for (const ring of boundaryHoleRings) {
            loaded.entities.add({
              polyline: {
                positions: ring,
                width: BOUNDARY_OUTLINE_WIDTH_PX,
                clampToGround: true,
                material: baseColor,
              },
            });
          }

          // Setup finished — publish it.
          _dataSource = loaded;
          _lastUpdate = Date.now();
        } catch (e) {
          // The dataset ships with the build, so this is a broken install,
          // not a blip — it has to reach the chip, not just the console.
          _error = localDatasetError(e);
          // Roll the partial build back so a later enable() retries from
          // scratch instead of inheriting a half-populated source. Only the
          // post-add window has something in the scene to remove: a failure
          // before (or inside) add() never reached the collection, and
          // removing then would race Cesium's pending insert.
          if (addedToScene) {
            try { viewer?.dataSources?.remove(loaded, true); } catch { /* already gone */ }
          }
          _count = 0;
          _stemRecords = [];
          console.error(`Failed to load ${id}:`, e);
        }

        // 2. Install native global click handler
        if (!_clickHandler) {
          _clickHandler = screenSpaceEventHandlerFactory(viewer.scene.canvas);
          _clickHandler.setInputAction((click) => {
            if (!_enabled) return;
            const picked = viewer.scene.pick(click.position);
            
            if (picked && picked.id && picked.id.__localLayerId === id) {
              const entity = picked.id;
              viewer.selectedEntity = entity;
              selectEntityContext(entity);
              
              // We zoom to the surface base of the stem or the center of the polygon
              let targetPos = null;
              /** Boundary extent, so the flight can frame the whole region. */
              let framingRadius = 0;

              if (outlineOnly) {
                // Must come first: a boundary entity HAS a polyline (its
                // outline), so the stem branch below would otherwise fly to an
                // arbitrary vertex on the border instead of into the region.
                const hierarchy = entity.polygon?.hierarchy?.getValue(Cesium.JulianDate.now());
                if (hierarchy?.positions?.length > 0) {
                  const sphere = Cesium.BoundingSphere.fromPoints(hierarchy.positions);
                  targetPos = sphere.center;
                  framingRadius = sphere.radius;
                }
              } else if (entity.polyline) {
                // If it's a stem, fly to the base
                const positions = entity.polyline.positions.getValue(Cesium.JulianDate.now());
                if (positions && positions.length > 0) {
                  targetPos = positions[0];
                }
              } else if (entity.polygon && entity.polygon.hierarchy) {
                // If it's a polygon, just fly to its center
                const hierarchy = entity.polygon.hierarchy.getValue(Cesium.JulianDate.now());
                if (hierarchy && hierarchy.positions.length > 0) {
                  targetPos = Cesium.BoundingSphere.fromPoints(hierarchy.positions).center;
                }
              }
              
              if (targetPos) {
                const carto = Cesium.Cartographic.fromCartesian(targetPos);
                
                // Disable interactions so Cesium doesn't magically cancel the flight
                viewer.scene.screenSpaceCameraController.enableInputs = false;
                
                const flyHeight = framingRadius > 0
                  ? Math.max(
                    BOUNDARY_MIN_FRAMING_HEIGHT_M,
                    framingRadius * BOUNDARY_FRAMING_RADIUS_SCALE,
                  )
                  : 5000;

                viewer.camera.flyTo({
                  destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, flyHeight),
                  duration: 1.5,
                  complete: () => { viewer.scene.screenSpaceCameraController.enableInputs = true; },
                  cancel: () => { viewer.scene.screenSpaceCameraController.enableInputs = true; },
                });
              }
            }
          }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
        }
      }

      // 3. Add an incredibly fast pre-render occluder to hide points behind the globe
      if (_enabled && !_preRenderRemover) {
        _preRenderRemover = viewer.scene.preRender.addEventListener(() => {
          if (!_enabled || !_dataSource) return;
          const now = performance.now();
          if (now - _lastVisibilityUpdate < VISIBILITY_UPDATE_MS) return;
          _lastVisibilityUpdate = now;

          const cameraPos = viewer.camera.positionWC;
          if (!cameraPos) return;
          
          const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, cameraPos);
          const visibleOverlayRecords = [];
          const refreshStemGeometry = _stemGeometryDirty;
          
          // A scene that cannot sample heights can never ground a record, so it
          // must never arm a retry (the arm would re-arm on every requested
          // frame, forever) and must not spend ANY per-record work trying.
          // Read once per walk, not per record.
          const canSampleGround = viewer.scene.sampleHeightSupported === true;
          // Capability can arrive late (WebGL context restore, a tileset that
          // finally supports sampling). A parked camera has no moveEnd to
          // re-open a spent budget, so the false→true edge does it.
          if (canSampleGround && _lastGroundSampleCapability === false) _groundRetryArms = 0;
          _lastGroundSampleCapability = canSampleGround;
          let groundRetryPending = false;
          let groundSampleProgress = false;
          for (let i = 0; i < _stemRecords.length; i++) {
            const record = _stemRecords[i];
            const wasGroundSampled = record.groundSampled;
            if (record.stemless) {
              // Boundary record: its anchor is fixed on the ground and its
              // `polyline` is the outline ring, NOT a stem — running the stem
              // updater here would overwrite that ring with a two-point stem
              // and erase the border on the first camera move.
            } else if (refreshStemGeometry) {
              updateLocalStemGeometry(viewer, record, now);
            } else if (canSampleGround && !record.groundSampled
              && now - record.lastGroundSampleMs >= GROUND_SAMPLE_RETRY_MS) {
              // Capability first: without it the distance below is pure waste,
              // once per ungrounded record per walk, forever.
              const distance = Cesium.Cartesian3.distance(viewer.camera.positionWC, record.base);
              if (distance < GROUND_SAMPLE_MAX_DISTANCE_M
                && sampleLocalGroundHeight(viewer, record, now)) {
                updateLocalStemGeometry(viewer, record, now, distance);
              }
            }
            if (!wasGroundSampled && record.groundSampled) groundSampleProgress = true;
            // Still unsampled AND close enough for a retry to succeed: this
            // layer has no hold and no periodic update, so under the idle
            // governor the retry's preRender never arrives on a parked camera
            // and the stem stays at ellipsoid height (buried/floating) until
            // the user happens to move. Schedule the frame the retry needs.
            // Gated on a sampleable scene and in-range records only, so a far
            // camera (or a keyless scene) stays fully idle; the distance is
            // only computed for still-unsampled stems.
            if (canSampleGround && !record.groundSampled && !groundRetryPending
              && Cesium.Cartesian3.distance(viewer.camera.positionWC, record.base)
                < GROUND_SAMPLE_MAX_DISTANCE_M) {
              groundRetryPending = true;
            }
            const isVisible = occluder.isPointVisible(record.base);
            if (record.entity.show !== isVisible) record.entity.show = isVisible;
            if (isVisible && record.entry) visibleOverlayRecords.push(record);
          }
          _stemGeometryDirty = false;
          // Tiles ARE streaming in: real progress re-opens the give-up budget
          // so the records still waiting get their own bounded run of retries.
          if (groundSampleProgress) _groundRetryArms = 0;
          if (groundRetryPending) scheduleGroundRetryRender(viewer);

          const canvas = viewer.scene.canvas;
          const cohort = selectLocalInfrastructureOverlayCohort(visibleOverlayRecords, {
            maxEntries: labelMax,
            gridPx: labelGridPx,
            width: canvas.clientWidth || canvas.width || 0,
            height: canvas.clientHeight || canvas.height || 0,
            cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
            project: (record) => projectToWindow(viewer.scene, record.tip),
          });
          _overlayPublisher.publish(cohort);
        });
      }
      if (_enabled && !_cameraMoveEndRemover) {
        _cameraMoveEndRemover = viewer.camera.moveEnd.addEventListener(() => {
          if (!_enabled) return;
          _stemGeometryDirty = true;
          _lastVisibilityUpdate = Number.NEGATIVE_INFINITY;
          // Real camera motion is a fresh situation (new tiles, new distances)
          // and its frames are free, so it re-opens the retry budget that a
          // parked camera may have spent.
          _groundRetryArms = 0;
          viewer.scene.requestRender?.();
        });
      }

      // Honor a disable() that landed while we were awaiting the fetch/parse:
      // disable() runs before _dataSource exists, so its show=false is a no-op —
      // reading _enabled here (rather than forcing true) respects the toggle-off.
      if (_dataSource) _dataSource.show = _enabled;
      viewer.scene.requestRender?.();
      announceRefresh();
    },

    disable: disableLayer,

    destroy: (viewer) => {
      if (_destroyed) return;
      _destroyed = true;
      // Defensively disable first so listeners and selection state are
      // torn down even if destroy is called while the layer is enabled.
      disableLayer(viewer);
      if (_clickHandler) {
        _clickHandler.destroy();
        _clickHandler = null;
      }
      if (_dataSource && viewer) {
        viewer.dataSources.remove(_dataSource, true);
      }
      _overlayPublisher.destroy();
      _retention.reset();
      _dataSource = null;
      _stemRecords = [];
      _count = 0;
      _retainedCount = 0;
      _lastUpdate = null;
      _error = null;
    }
  };

  /**
   * Tell anything watching what this layer now holds, and what just arrived.
   *
   * A DOM event rather than a callback threaded through the factory: eleven PM
   * layers are constructed in `localLayers.js` from one shared config object,
   * and adding a per-layer wire to each would be eleven edits for one listener.
   * It follows the same pattern the context store already uses for selection.
   *
   * Only fires for layers that actually refresh. A bundled snapshot announces
   * its one load and never speaks again, which is the truth about it.
   */
  function announceRefresh() {
    const added = _lastAdded;
    _lastAdded = [];
    if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return;
    if (!(refreshMs > 0)) return;
    try {
      window.dispatchEvent(new CustomEvent('gev:layer-refreshed', {
        detail: {
          layerId: id,
          layerName: name,
          count: _count,
          retained: _retainedCount,
          error: _error,
          added,
          features: featureSnapshot(),
        },
      }));
    } catch {
      /* a listener throwing is not this layer's problem */
    }
  }

  /**
   * The layer's current features, annotated for the two kinds of consumer.
   *
   * They are the real GeoJSON — geometry intact — so a polygon can still be
   * tested against and framed. `lat`/`lon` ride along because the containment
   * counters read a flat coordinate pair, and deriving it here once beats every
   * caller re-deriving it per record.
   *
   * @returns {object[]} Features with `lat`, `lon`, `key`, `layerId`, `name`.
   */
  function featureSnapshot() {
    return _lastFeatures.map((feature) => {
      const props = feature?.properties || {};
      const at = firstCoordinateOf(feature?.geometry);
      return {
        ...feature,
        key: props[KEY_PROPERTY] ?? null,
        layerId: id,
        name: props.name ?? null,
        lat: at ? at[1] : null,
        lon: at ? at[0] : null,
      };
    });
  }

  /**
   * The retention key of whatever this layer currently has selected.
   *
   * A refresh replaces every entity, so a selection held by object identity
   * cannot survive it — and losing it would close an open detail panel every
   * couple of minutes, which on a live incident is worse than not refreshing
   * at all. The key is the only thing that persists across the swap.
   *
   * @param {object} viewer Cesium viewer.
   * @returns {string|null} Key, or null when nothing of ours is selected.
   */
  function selectedRecordKey(viewer) {
    const selected = viewer?.selectedEntity;
    if (!selected || selected.__localLayerId !== id) return null;
    try {
      return selected.properties?.[KEY_PROPERTY]?.getValue?.() ?? null;
    } catch {
      return null;
    }
  }

  /** Re-select the entity carrying `key`, if the new payload still has one. */
  function restoreSelection(viewer, key) {
    if (!key || !viewer || !_dataSource) return;
    for (const entity of _dataSource.entities.values) {
      let entityKey = null;
      try {
        entityKey = entity.properties?.[KEY_PROPERTY]?.getValue?.() ?? null;
      } catch {
        entityKey = null;
      }
      if (entityKey !== key) continue;
      viewer.selectedEntity = entity;
      selectEntityContext(entity);
      return;
    }
    // Gone for good — the feed dropped it and its retention window closed.
    // Leave the selection cleared rather than picking a neighbour.
    clearSelectedEntityContextForLayer(id);
  }

  /**
   * Re-fetch and rebuild, keeping the old data on screen until the new data is
   * ready to replace it.
   *
   * The swap is a double-buffer, not a teardown-and-reload: `enable()` already
   * builds into a local and commits to `_dataSource` only once setup finishes,
   * so nulling the handle sends it down the build path while the PREVIOUS
   * source stays in the scene, visible, the whole time. Removing the old one
   * afterwards is what makes a refresh a single-frame swap instead of a gap.
   *
   * A failed poll keeps the last good data. The alternative — emptying the
   * layer because one fetch timed out — turns a network blip into "there are
   * no incidents", which is the most dangerous thing this layer could say.
   *
   * @param {object} viewer Cesium viewer.
   */
  async function refreshLayer(viewer) {
    if (_destroyed || !_enabled || !(refreshMs > 0) || !viewer) return;
    // A poll slower than the interval must not stack; the manager's timer does
    // not await us.
    if (_refreshing) return;
    _refreshing = true;

    const previous = _dataSource;
    const previousCount = _count;
    const selectedKey = selectedRecordKey(viewer);

    try {
      _dataSource = null;
      await api.enable(viewer);

      if (_dataSource && previous && _dataSource !== previous) {
        try { viewer.dataSources.remove(previous, true); } catch { /* already gone */ }
      } else if (!_dataSource && previous) {
        // enable() reported the failure and rolled its own partial build back.
        // Put the last good source back so the layer keeps showing it.
        _dataSource = previous;
        _count = previousCount;
      }
      restoreSelection(viewer, selectedKey);
    } finally {
      _refreshing = false;
    }
  }

  return api;
}

function compareLocalOverlayRecords(a, b) {
  return b.priority - a.priority || String(a.id).localeCompare(String(b.id));
}

function insertLocalCellContender(contenders, record) {
  let index = 0;
  while (index < contenders.length && compareLocalOverlayRecords(contenders[index], record) <= 0) {
    index++;
  }
  contenders.splice(index, 0, record);
  if (contenders.length > LOCAL_OVERLAY_CELL_SURPLUS) contenders.length = LOCAL_OVERLAY_CELL_SURPLUS;
}

/**
 * Flatten every hole ring of a polygon hierarchy into `out`.
 *
 * Recursive because a hierarchy nests: an island inside a lake inside an
 * island is one hole holding another. Vicmap has no such case today, but the
 * recursion costs a line and the alternative fails silently.
 *
 * @param {Cesium.PolygonHierarchy} hierarchy Polygon hierarchy to walk.
 * @param {Cesium.Cartesian3[][]} out Accumulator of ring position arrays.
 * @returns {Cesium.Cartesian3[][]} `out`, for chaining.
 */
export function collectHoleRings(hierarchy, out = []) {
  for (const hole of hierarchy?.holes || []) {
    if (hole?.positions?.length > 2) out.push(hole.positions);
    collectHoleRings(hole, out);
  }
  return out;
}

function sampleLocalGroundHeight(viewer, record, now) {
  if (record.groundSampled || !viewer.scene.sampleHeightSupported) return false;
  if (now - record.lastGroundSampleMs < GROUND_SAMPLE_RETRY_MS) return false;
  record.lastGroundSampleMs = now;
  let sampled;
  try {
    sampled = viewer.scene.sampleHeight(record.carto, [record.entity]);
  } catch {
    return false; // tiles not ready; retry on a later bounded update
  }
  if (!Number.isFinite(sampled) || Math.abs(sampled) > GROUND_SAMPLE_MAX_ABS_HEIGHT_M) return false;
  record.groundSampled = true;
  record.groundHeight = sampled;
  Cesium.Cartesian3.fromRadians(
    record.carto.longitude,
    record.carto.latitude,
    record.groundHeight,
    Cesium.Ellipsoid.WGS84,
    record.base,
  );
  record.entity.__localBaseCartesian = record.base;
  return true;
}

function updateLocalStemGeometry(viewer, record, now, knownDistance = null) {
  const distance = Number.isFinite(knownDistance)
    ? knownDistance
    : Cesium.Cartesian3.distance(viewer.camera.positionWC, record.base);
  if (distance < GROUND_SAMPLE_MAX_DISTANCE_M) sampleLocalGroundHeight(viewer, record, now);
  const effectiveDistance = Math.max(distance, 5000);
  const canvasHeight = viewer.scene.canvas.clientHeight || 1080;
  const fov = viewer.camera.frustum.fov || (Math.PI / 3);
  const targetPx = 65;
  const fovFactor = 2 * Math.tan(fov / 2) * (targetPx / canvasHeight);
  const tipHeight = record.groundHeight + effectiveDistance * fovFactor;
  Cesium.Cartesian3.fromRadians(
    record.carto.longitude,
    record.carto.latitude,
    tipHeight,
    Cesium.Ellipsoid.WGS84,
    record.nextTip,
  );
  if (Cesium.Cartesian3.distanceSquared(record.tip, record.nextTip) <= LOCAL_STEM_TIP_EPSILON_SQ) {
    return false;
  }
  Cesium.Cartesian3.clone(record.nextTip, record.tip);
  record.stemPositionBufferIndex = 1 - record.stemPositionBufferIndex;
  const stemPositions = record.stemPositionBuffers[record.stemPositionBufferIndex];
  stemPositions[0] = record.base;
  stemPositions[1] = record.tip;
  record.entity.position.setValue(record.tip);
  record.entity.polyline.positions.setValue(stemPositions);
  return true;
}

function featureLabelFromProperties(props, layerId) {
  const tags = props.tags || {};

  const candidates = [
    props.name,
    tags.name,
    tags['name:en'],
    tags.official_name,
    tags.operator,
    tags['operator:short'],
    props.operator,
    props.output ? `${layerTitle(layerId)} ${props.output}` : '',
    props.osm_id ? `${layerTitle(layerId)} ${props.osm_id}` : '',
  ];

  const text = candidates.map(cleanLabel).find(Boolean);
  return clampLabel(text || layerTitle(layerId));
}

function labelPriorityFromProperties(props, layerId) {
  const tags = props.tags || {};

  // An exporter that HAS the geometry can rank better than any property
  // heuristic can. The Vicmap boundary export scores each part of a multipart
  // region by its share of the region's area, so a council's mainland body
  // outranks its sand islands for the one label the collision cell will take;
  // every part otherwise carries identical properties and would tie.
  if (Number.isFinite(props.priority)) return Number(props.priority);

  let score = 0;
  if (cleanLabel(props.name) || cleanLabel(tags.name)) score += 1000;
  if (cleanLabel(tags['name:en'])) score += 700;
  if (cleanLabel(tags.operator) || cleanLabel(props.operator)) score += 180;
  if (props.output || tags['plant:output:electricity']) score += 120;
  if (layerId === 'local-dams') score += 80;
  if (layerId === 'local-datacenters') score += 60;
  return score;
}

function propertyObject(entity) {
  const source = entity?.properties;
  const raw = typeof source?.getValue === 'function'
    ? source.getValue(Cesium.JulianDate.now())
    : source || {};
  return unwrapProperties(raw);
}

function unwrapProperties(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(unwrapProperties);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = entry && typeof entry.getValue === 'function'
      ? unwrapProperties(entry.getValue(Cesium.JulianDate.now()))
      : unwrapProperties(entry);
  }
  return out;
}

function cleanLabel(value) {
  const text = String(value || '').trim();
  if (!text || text === 'undefined' || text === 'null') return '';
  return text;
}

function firstClean(values) {
  return values.map(cleanLabel).find(Boolean) || '';
}

function clampLabel(value) {
  const text = cleanLabel(value);
  return text.length > 34 ? `${text.slice(0, 31)}...` : text;
}

function clampCardLine(value) {
  const text = cleanLabel(value);
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

function layerTitle(layerId) {
  if (layerId === 'local-datacenters') return 'Datacenter';
  if (layerId === 'local-dams') return 'Dam';
  // Only ever a fallback: export-vicmap-admin.mjs drops an unnamed boundary
  // rather than emitting one, so a Vicmap feature always carries `name`.
  if (layerId.startsWith('local-vicmap-')) return 'Boundary';
  return 'Feature';
}
