import * as Cesium from 'cesium';
import { createInfrastructureOverlayEntry } from '../../data/infrastructureOverlayEntry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  GROUND_SAMPLE_MAX_ARMED_RETRIES,
  GROUND_SAMPLE_MAX_DISTANCE_M,
  GROUND_SAMPLE_RETRY_MS,
  LOCAL_OVERLAY_COHORT_LIMIT,
  createLocalInfrastructureOverlayPublisher,
  localDatasetError,
  propertyObject,
  refreshLocalTerrainFloor,
  sampleLocalGroundHeight,
  selectLocalInfrastructureOverlayCohort,
  updateLocalStemGeometry,
} from '../../data/localGeojsonCore.js';
import {
  applyInfraEvictionGrace,
  selectInfraLod,
  shouldRecomputeInfraLod,
} from '../../data/localGeojsonLod.js';
import {
  STALE_FOR_PROPERTY,
  STALE_PROPERTY,
  createRetentionTracker,
  featureKey,
} from './featureRetention.js';

// Victorian GeoJSON layers: Passive Monitor hazards, Vicmap boundaries, fire
// stations.
//
// Upstream's createLocalGeoJsonLayer (src/data/localGeojsonCore.js) draws
// bundled point datasets as stems with ambient cards. This factory keeps that
// presentation and its globe-LOD walk, and adds what a live emergency feed and
// a boundary set need:
//
//   outlineOnly   boundaries draw as a ground-clamped outline over a faint wash,
//                 labelled at the centroid, instead of one stem per region.
//   styleFeature  per-record colour and size (flood gauges above flood level).
//   refreshMs     re-fetch cadence for a live source, with a double-buffered
//                 swap so the old data stays on screen until the new is ready.
//   retentionMs   how long a feature the feed stopped listing is still drawn,
//                 marked NOT IN LAST UPDATE (see featureRetention.js).
//
// It also accepts a FeatureCollection as well as GeoJSON Lines, so a live API
// can replace a committed snapshot by changing only the URL, and announces each
// refresh as a `gev:layer-refreshed` window event for Monitor Mode.

const DEFAULT_LABEL_MAX = 900;
const DEFAULT_LABEL_GRID_PX = 132;
const VISIBILITY_UPDATE_MS = 450;
/** Property carrying a feature's retention identity onto its entity. */
export const KEY_PROPERTY = 'gevKey';
/**
 * Fill alpha for `outlineOnly` layers. Boundary polygons tessellate a whole
 * state, so their fill is only a faint wash and a pick surface; the outline
 * carries the meaning. Hazard polygons keep upstream's 0.3.
 */
const BOUNDARY_FILL_ALPHA = 0.05;
const HAZARD_FILL_ALPHA = 0.3;
/** Ground-clamped boundary stroke, in pixels. */
const BOUNDARY_OUTLINE_WIDTH_PX = 2;
/**
 * A click on a boundary frames the region rather than diving to the fixed
 * 5 km a point gets: 5 km over the centroid of Mildura Rural City is a paddock.
 */
const BOUNDARY_FRAMING_RADIUS_SCALE = 2.2;
const BOUNDARY_MIN_FRAMING_HEIGHT_M = 5000;
const POINT_FRAMING_HEIGHT_M = 5000;

/**
 * Parse a layer payload: a FeatureCollection, a bare Feature array, or GeoJSON
 * Lines (one Feature per line, what the committed snapshots use).
 *
 * Not sniffed by first character: JSON Lines also begins with `{`. The whole
 * body is tried as one document and accepted only if it is a collection;
 * anything else, including the parse failure multi-line JSONL produces, falls
 * through to line-by-line.
 * @param {string} text Response body.
 * @returns {object[]} Features.
 */
export function parseGeojsonFeatures(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && Array.isArray(parsed.features)) return parsed.features;
    if (Array.isArray(parsed)) return parsed;
    // A lone Feature object is a one-line JSONL file; fall through.
  } catch {
    // Not a single JSON document: expected for JSONL.
  }
  return trimmed
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * The first coordinate pair of any geometry. A polygon's first vertex is not
 * its centroid, but a containment counter only needs a point on the record.
 * @param {object} geometry GeoJSON geometry.
 * @returns {[number, number]|null} [lon, lat], or null.
 */
export function firstCoordinateOf(geometry) {
  let node = geometry?.coordinates;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!Array.isArray(node)) return null;
    if (typeof node[0] === 'number' && typeof node[1] === 'number')
      return [node[0], node[1]];
    node = node[0];
  }
  return null;
}

/**
 * Flatten every hole ring of a polygon hierarchy into `out`. Recursive because
 * a hierarchy nests (an island in a lake in an island).
 * @param {Cesium.PolygonHierarchy} hierarchy Polygon hierarchy to walk.
 * @param {Cesium.Cartesian3[][]} out Accumulator of ring position arrays.
 * @returns {Cesium.Cartesian3[][]} `out`.
 */
export function collectHoleRings(hierarchy, out = []) {
  for (const hole of hierarchy?.holes || []) {
    if (hole?.positions?.length > 2) out.push(hole.positions);
    collectHoleRings(hole, out);
  }
  return out;
}

function cleanText(value) {
  const text = String(value ?? '').trim();
  if (!text || text === 'undefined' || text === 'null') return '';
  return text;
}

function clampText(value, max) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** Singular fallback title for an unnamed record. */
export function vicLayerTitle(layerId) {
  return String(layerId).startsWith('local-vicmap-') &&
    layerId !== 'local-vicmap-fire-station'
    ? 'Boundary'
    : 'Feature';
}

/** Card / context label for a record. */
export function vicFeatureLabel(properties, layerId) {
  return clampText(cleanText(properties?.name) || vicLayerTitle(layerId), 34);
}

/**
 * Card copy. Passive Monitor and the Vicmap exporters both emit a normalized
 * (status, detail) pair: status is the operational state or kind of unit
 * ("Watch and Act", "Local government area"), detail the measurement or code
 * ("296 ha · 12 resources", "LGA 328"). A held record says so on the card,
 * because nothing else on the globe tells it apart from a current one.
 * @param {object} properties Plain feature properties.
 * @param {string} layerId Layer id.
 * @returns {{title:string, details:string[]}}
 */
export function vicOverlayCopy(properties, layerId) {
  const props = properties || {};
  const title = vicFeatureLabel(props, layerId);
  const details = [];
  const status = cleanText(props.status);
  if (status && status.toLocaleLowerCase() !== title.toLocaleLowerCase())
    details.push(clampText(status, 48));
  const detail = cleanText(props.detail);
  if (detail) details.push(clampText(detail, 48));
  if (props[STALE_PROPERTY]) {
    const minutes = Math.max(
      1,
      Math.round(Number(props[STALE_FOR_PROPERTY] || 0) / 60000),
    );
    details.push(`NOT IN LAST UPDATE · ${minutes} min`);
  }
  return { title, details };
}

/**
 * Label priority. An exporter that has the geometry ranks better than any
 * property heuristic: the Vicmap export scores each part of a multipart region
 * by its share of the area, so a council's mainland outranks its sand islands.
 */
export function vicLabelPriority(properties) {
  if (Number.isFinite(properties?.priority)) return Number(properties.priority);
  return cleanText(properties?.name) ? 1000 : 0;
}

/**
 * Resolve a layer's `url` option, which is either a fixed URL (a snapshot) or
 * an async resolver returning `{url, live}` (Passive Monitor, decided at
 * runtime by /api/passive-monitor/status).
 * @param {string|function(): Promise<{url:string, live:boolean}>} url
 * @returns {Promise<{url:string, live:boolean}>}
 */
export async function resolveLayerSource(url) {
  if (typeof url === 'function') {
    const resolved = await url();
    return { url: resolved.url, live: resolved.live === true };
  }
  return { url, live: false };
}

const isAbortError = (error) =>
  error?.name === 'AbortError' || error?.code === 'ABORT_ERR';

/**
 * A Victorian GeoJSON layer implementing the lifecycle contract
 * (init/enable/disable/update/destroy/getStats).
 * @param {object} options See the option list at the top of this module.
 * @param {object} services `localGeoJsonServices` (src/app/localGeojsonServices.js).
 * @returns {object} The layer.
 */
export function createVicGeoJsonLayer(
  {
    id,
    url,
    name,
    color,
    icon = '📍',
    source = 'Local',
    liveSource = source,
    outlineOnly = false,
    styleFeature = null,
    refreshMs = 0,
    retentionMs = 0,
    labels = true,
    labelMax = DEFAULT_LABEL_MAX,
    labelGridPx = DEFAULT_LABEL_GRID_PX,
    fetchImpl = (...args) => globalThis.fetch(...args),
    screenSpaceEventHandlerFactory = (canvas) =>
      new Cesium.ScreenSpaceEventHandler(canvas),
    projectToWindow = (scene, position) =>
      Cesium.SceneTransforms.worldToWindowCoordinates(scene, position),
  },
  {
    overlayHost,
    registerEntityContext,
    selectEntityContext,
    clearSelectedEntityContextForLayer,
    removeEntityContextsForLayer,
    governorRequestRender,
  },
) {
  let _dataSource = null;
  let _enabled = false;
  let _destroyed = false;
  let _clickHandler = null;
  let _count = 0;
  /** How many of `_count` are held past their feed, not currently listed. */
  let _retainedCount = 0;
  /** Features this load saw for the first time; announced, then cleared. */
  let _lastAdded = [];
  /** The GeoJSON last built from; polygons keep their rings for consumers. */
  let _lastFeatures = [];
  let _lastUpdate = null;
  /** When the last successful fetch landed; dedupes the post-enable update. */
  let _lastLoadAt = 0;
  let _error = null;
  /** null until the source is resolved; true when reading a live feed. */
  let _live = null;
  let _loadPromise = null;
  let _loadController = null;
  let _refreshing = false;
  /** Parsed snapshot features kept across disable/enable. Never for a live feed. */
  let _cachedFeatures = null;
  let _preRenderRemover = null;
  let _cameraMoveEndRemover = null;
  let _stemRecords = [];
  let _stemGeometryDirty = true;
  let _lastVisibilityUpdate = 0;
  let _activeLodIds = new Set();
  let _lodGraceState = new Map();
  let _lastLodBudgetLimit = 0;
  let _lodComputed = false;
  const _lastLodCameraPos = new Cesium.Cartesian3();
  let _lastLodProbeMs = Number.NEGATIVE_INFINITY;
  let _groundRetryTimer = null;
  let _groundRetryArms = 0;
  let _lastGroundSampleCapability = null;
  const _retention = createRetentionTracker({ retentionMs });
  const _overlayPublisher = createLocalInfrastructureOverlayPublisher({
    sourceId: id,
    host: overlayHost,
  });
  const _baseColor = Cesium.Color.fromCssColorString(color);

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

  function resetLod() {
    _activeLodIds = new Set();
    _lodGraceState = new Map();
    _lastLodBudgetLimit = 0;
    _lodComputed = false;
    _lastLodProbeMs = Number.NEGATIVE_INFINITY;
  }

  /** Fetch, parse, reconcile against the retention window, stamp keys. */
  async function fetchFeatures(signal) {
    const resolved = await resolveLayerSource(url);
    _live = resolved.live;
    api.source = _live ? liveSource : source;
    const response = await fetchImpl(resolved.url, { signal });
    // A 404 returns an HTML body that would otherwise die in JSON.parse.
    if (!response.ok) throw new Error(`HTTP ${response.status ?? '?'}`);
    let features = parseGeojsonFeatures(await response.text());
    const reconciled = _retention.reconcile(features, Date.now());
    features = reconciled.features;
    _retainedCount = reconciled.retained;
    _lastAdded = reconciled.added;
    // The key is what lets an open selection find its entity again after a
    // refresh replaces every one of them.
    if (refreshMs > 0 || retentionMs > 0) {
      features = features.map((feature) => ({
        ...feature,
        properties: {
          ...(feature?.properties || {}),
          [KEY_PROPERTY]: featureKey(feature),
        },
      }));
    }
    _lastLoadAt = Date.now();
    return features;
  }

  /**
   * Build a hidden data source from features without touching layer state, so
   * a refresh can build beside the visible source and swap in one frame.
   */
  async function buildSource(viewer, features) {
    const loaded = await Cesium.GeoJsonDataSource.load(
      { type: 'FeatureCollection', features },
      {
        clampToGround: true,
        stroke: _baseColor,
        fill: _baseColor.withAlpha(
          outlineOnly ? BOUNDARY_FILL_ALPHA : HAZARD_FILL_ALPHA,
        ),
        strokeWidth: 2,
        markerSize: 8,
        markerColor: _baseColor,
      },
    );
    loaded.name = name;
    loaded.show = false;
    // DataSourceCollection.add() inserts on a later microtask; awaiting it
    // keeps a rollback from racing the insert.
    await viewer.dataSources.add(loaded);
    try {
      const entities = loaded.entities.values;
      const records = [];
      const contexts = [];
      /** Hole rings, stroked after the walk: adding mid-loop walks the additions. */
      const holeRings = [];
      /** Parts seen per key: a multipart feature yields one entity per part. */
      const partsPerKey = new Map();

      for (let i = 0; i < entities.length; i++) {
        const feature = entities[i];
        feature.__localLayerId = id;
        let pos = feature.position?.getValue(Cesium.JulianDate.now());
        let outerRing = null;
        if (!pos && feature.polygon) {
          feature.polygon.outline = true;
          feature.polygon.outlineColor = _baseColor;
          const hierarchy = feature.polygon.hierarchy?.getValue(
            Cesium.JulianDate.now(),
          );
          if (hierarchy?.positions?.length > 0) {
            pos = Cesium.BoundingSphere.fromPoints(hierarchy.positions).center;
            outerRing = hierarchy.positions;
            if (outlineOnly) collectHoleRings(hierarchy, holeRings);
          }
        }
        if (!pos) continue;

        const carto = Cesium.Cartographic.fromCartesian(pos);
        const groundHeight = 0;
        // Boundary labels rest on the centroid; only stems climb.
        const tipHeight = outlineOnly ? groundHeight : 2000;
        const base = Cesium.Cartesian3.fromRadians(
          carto.longitude,
          carto.latitude,
          groundHeight,
        );
        const tip = Cesium.Cartesian3.fromRadians(
          carto.longitude,
          carto.latitude,
          tipHeight,
        );
        const properties = propertyObject(feature);
        const key = properties?.[KEY_PROPERTY] ?? null;
        let recordId;
        if (key) {
          const part = partsPerKey.get(key) || 0;
          partsPerKey.set(key, part + 1);
          recordId = part ? `${key}#${part}` : key;
        } else {
          recordId = String(feature.id ?? i);
        }
        feature.__localBaseCarto = carto;
        feature.__localBaseCartesian = base;
        contexts.push({
          entity: feature,
          metadata: {
            id: `${id}:${recordId}`,
            layerId: id,
            layerName: name,
            source: api.source,
            dataSource: loaded,
            label: vicFeatureLabel(properties, id),
            properties,
            latitude: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(6)),
            longitude: Number(
              Cesium.Math.toDegrees(carto.longitude).toFixed(6),
            ),
          },
        });

        const stemPositionBuffers = [
          [base, tip],
          [base, tip],
        ];
        let accent = color;
        if (outlineOnly) {
          // A ground-clamped polygon draws no outline (Cesium classifies the
          // fill onto the terrain and drops `polygon.outline`), so the border
          // is its own ground-clamped polyline over the outer ring.
          if (outerRing) {
            feature.polyline = new Cesium.PolylineGraphics({
              positions: outerRing,
              width: BOUNDARY_OUTLINE_WIDTH_PX,
              clampToGround: true,
              material: new Cesium.ColorMaterialProperty(_baseColor),
            });
          }
        } else {
          const style = styleFeature ? styleFeature(properties) || {} : {};
          const pointColor = style.color
            ? Cesium.Color.fromCssColorString(style.color)
            : _baseColor;
          if (style.color) accent = style.color;
          feature.position = tip;
          feature.polyline = new Cesium.PolylineGraphics({
            positions: stemPositionBuffers[0],
            width: 3.5,
            material: new Cesium.ColorMaterialProperty(pointColor),
          });
          feature.point = new Cesium.PointGraphics({
            pixelSize: Number.isFinite(style.pixelSize) ? style.pixelSize : 10,
            color: pointColor,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          });
        }

        const priority = vicLabelPriority(properties);
        let entry = null;
        if (labels) {
          const copy = vicOverlayCopy(properties, id);
          entry = createInfrastructureOverlayEntry({
            id: recordId,
            source: id,
            position: tip,
            title: copy.title,
            details: copy.details,
            accent,
            priority,
          });
        }
        records.push({
          id: recordId,
          key,
          entity: feature,
          carto,
          base,
          tip,
          nextTip: Cesium.Cartesian3.clone(tip),
          stemPositionBuffers,
          stemPositionBufferIndex: 0,
          groundHeight,
          // A boundary has no stem to scale and nothing to lift onto the mesh;
          // recording it as grounded keeps it out of the sample/retry path.
          groundSampled: outlineOnly,
          stemless: outlineOnly,
          lastGroundSampleMs: 0,
          priority,
          entry,
        });
      }

      // Enclave borders: untagged, so a click on one selects nothing rather
      // than a context entry that was never registered.
      for (const ring of holeRings) {
        loaded.entities.add({
          polyline: {
            positions: ring,
            width: BOUNDARY_OUTLINE_WIDTH_PX,
            clampToGround: true,
            material: _baseColor,
          },
        });
      }
      return { loaded, records, contexts };
    } catch (error) {
      try {
        viewer.dataSources.remove(loaded, true);
      } catch {
        /* already gone */
      }
      throw error;
    }
  }

  /** Swap a built source in, retire the previous one and its stale contexts. */
  function commit(viewer, built) {
    const previous = _dataSource;
    const retainIds = new Set();
    for (const { entity, metadata } of built.contexts) {
      registerEntityContext(entity, metadata);
      retainIds.add(metadata.id);
    }
    _dataSource = built.loaded;
    _stemRecords = built.records;
    _count = built.records.length;
    _stemGeometryDirty = true;
    _lastVisibilityUpdate = Number.NEGATIVE_INFINITY;
    resetLod();
    _dataSource.show = _enabled;
    if (previous && previous !== _dataSource) {
      try {
        viewer.dataSources.remove(previous, true);
      } catch {
        /* already gone */
      }
    }
    removeEntityContextsForLayer(id, { retainIds });
  }

  const releaseDataSource = (viewer) => {
    if (!_dataSource) return;
    const source = _dataSource;
    _dataSource = null;
    _stemRecords = [];
    _stemGeometryDirty = true;
    _lastVisibilityUpdate = Number.NEGATIVE_INFINITY;
    removeEntityContextsForLayer(id);
    try {
      viewer?.dataSources?.remove(source, true);
    } catch {
      /* already gone */
    }
  };

  const disableLayer = (viewer) => {
    _enabled = false;
    clearGroundRetryRender();
    resetLod();
    releaseDataSource(viewer);
    _overlayPublisher.hide();
    clearSelectedEntityContextForLayer(id);
    if (viewer?.selectedEntity?.__localLayerId === id) {
      viewer.selectedEntity = undefined;
    }
    _preRenderRemover?.();
    _preRenderRemover = null;
    _cameraMoveEndRemover?.();
    _cameraMoveEndRemover = null;
  };

  function installClickHandler(viewer) {
    if (_clickHandler) return;
    _clickHandler = screenSpaceEventHandlerFactory(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!isPointerFree() || !_enabled) return;
      const picked = viewer.scene.pick(click.position);
      if (!picked?.id || picked.id.__localLayerId !== id) return;
      const entity = picked.id;
      viewer.selectedEntity = entity;
      selectEntityContext(entity);

      let targetPos = null;
      let flyHeight = POINT_FRAMING_HEIGHT_M;
      if (outlineOnly) {
        // First: a boundary entity HAS a polyline (its outline), which the
        // stem branch would fly to a vertex of.
        const hierarchy = entity.polygon?.hierarchy?.getValue(
          Cesium.JulianDate.now(),
        );
        if (hierarchy?.positions?.length > 0) {
          const sphere = Cesium.BoundingSphere.fromPoints(hierarchy.positions);
          targetPos = sphere.center;
          flyHeight = Math.max(
            BOUNDARY_MIN_FRAMING_HEIGHT_M,
            sphere.radius * BOUNDARY_FRAMING_RADIUS_SCALE,
          );
        }
      } else if (entity.polyline) {
        targetPos =
          entity.polyline.positions.getValue(Cesium.JulianDate.now())?.[0] ??
          null;
      }
      if (!targetPos) return;
      const carto = Cesium.Cartographic.fromCartesian(targetPos);
      const controller = viewer.scene.screenSpaceCameraController;
      controller.enableInputs = false;
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromRadians(
          carto.longitude,
          carto.latitude,
          flyHeight,
        ),
        duration: 1.5,
        complete: () => {
          controller.enableInputs = true;
        },
        cancel: () => {
          controller.enableInputs = true;
        },
      });
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  /** Upstream's bounded visibility / LOD / label walk, stemless-aware. */
  function installWalk(viewer) {
    if (!_preRenderRemover) {
      _preRenderRemover = viewer.scene.preRender.addEventListener(() => {
        if (!_enabled || !_dataSource) return;
        const now = performance.now();
        if (now - _lastVisibilityUpdate < VISIBILITY_UPDATE_MS) return;
        _lastVisibilityUpdate = now;
        const cameraPos = viewer.camera.positionWC;
        if (!cameraPos) return;

        if (!_stemGeometryDirty && _lodComputed && _stemRecords.length > 0) {
          const probe = shouldRecomputeInfraLod({
            nowMs: now,
            lastProbeMs: _lastLodProbeMs,
            movedSqM: Cesium.Cartesian3.distanceSquared(
              cameraPos,
              _lastLodCameraPos,
            ),
            cameraHeightM: viewer.camera.positionCartographic?.height,
          });
          _lastLodProbeMs = probe.lastProbeMs;
          if (probe.recompute) _stemGeometryDirty = true;
        }

        const occluder = new Cesium.EllipsoidalOccluder(
          Cesium.Ellipsoid.WGS84,
          cameraPos,
        );
        const visibleOverlayRecords = [];
        const refreshStemGeometry = _stemGeometryDirty;
        const canSampleGround = viewer.scene.sampleHeightSupported === true;
        if (canSampleGround && _lastGroundSampleCapability === false)
          _groundRetryArms = 0;
        _lastGroundSampleCapability = canSampleGround;
        let groundRetryPending = false;
        let groundSampleProgress = false;

        if (refreshStemGeometry && _stemRecords.length > 0) {
          const candidates = _stemRecords.map((record) => ({
            id: record.id,
            priority: record.priority,
            distanceM: Cesium.Cartesian3.distance(cameraPos, record.base),
            inView: occluder.isPointVisible(record.base),
          }));
          const selection = selectInfraLod(candidates, {
            cameraHeightM: viewer.camera.positionCartographic?.height,
            incumbentIds: _activeLodIds,
          });
          const grace = applyInfraEvictionGrace({
            selectedIds: selection.activeIds,
            builtIds: [..._activeLodIds],
            graceState: _lodGraceState,
            nowMs: now,
            activeLimit: selection.budget.activeLimit,
          });
          _activeLodIds = new Set(grace.keepIds);
          _lodGraceState = grace.graceState;
          _lastLodBudgetLimit = selection.budget.activeLimit;
          _lodComputed = true;
          Cesium.Cartesian3.clone(cameraPos, _lastLodCameraPos);
          _lastLodProbeMs = now;
        }

        for (const record of _stemRecords) {
          const isActive = !_lodComputed || _activeLodIds.has(record.id);
          if (record.stemless) {
            // A boundary stays drawn whatever its centroid does; the LOD and
            // horizon only decide whether its label competes for a card.
            if (record.entity.show !== true) record.entity.show = true;
            if (
              isActive &&
              record.entry &&
              occluder.isPointVisible(record.base)
            )
              visibleOverlayRecords.push(record);
            continue;
          }
          const isVisible = isActive && occluder.isPointVisible(record.base);
          if (record.entity.show !== isVisible) record.entity.show = isVisible;
          if (!isActive) continue;

          const wasGroundSampled = record.groundSampled;
          const terrainFloorChanged = refreshLocalTerrainFloor(viewer, record);
          if (refreshStemGeometry || terrainFloorChanged) {
            updateLocalStemGeometry(viewer, record, now);
          } else if (
            canSampleGround &&
            !record.groundSampled &&
            now - record.lastGroundSampleMs >= GROUND_SAMPLE_RETRY_MS
          ) {
            const distance = Cesium.Cartesian3.distance(
              viewer.camera.positionWC,
              record.base,
            );
            if (
              distance < GROUND_SAMPLE_MAX_DISTANCE_M &&
              sampleLocalGroundHeight(viewer, record, now)
            ) {
              updateLocalStemGeometry(viewer, record, now, distance);
            }
          }
          if (!wasGroundSampled && record.groundSampled)
            groundSampleProgress = true;
          if (
            canSampleGround &&
            !record.groundSampled &&
            !groundRetryPending &&
            Cesium.Cartesian3.distance(viewer.camera.positionWC, record.base) <
              GROUND_SAMPLE_MAX_DISTANCE_M
          ) {
            groundRetryPending = true;
          }
          if (isVisible && record.entry) visibleOverlayRecords.push(record);
        }
        _stemGeometryDirty = false;
        if (groundSampleProgress) _groundRetryArms = 0;
        if (groundRetryPending) scheduleGroundRetryRender(viewer);

        const canvas = viewer.scene.canvas;
        _overlayPublisher.publish(
          selectLocalInfrastructureOverlayCohort(visibleOverlayRecords, {
            maxEntries: labelMax,
            gridPx: labelGridPx,
            width: canvas.clientWidth || canvas.width || 0,
            height: canvas.clientHeight || canvas.height || 0,
            cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
            project: (record) => projectToWindow(viewer.scene, record.tip),
          }),
        );
      });
    }
    if (!_cameraMoveEndRemover) {
      _cameraMoveEndRemover = viewer.camera.moveEnd.addEventListener(() => {
        if (!_enabled) return;
        _stemGeometryDirty = true;
        _lastVisibilityUpdate = Number.NEGATIVE_INFINITY;
        _groundRetryArms = 0;
        viewer.scene.requestRender?.();
      });
    }
  }

  /**
   * Tell anything watching (Monitor Mode) what this layer now holds and what
   * just arrived. Only layers that refresh announce; a snapshot never changes.
   */
  function announceRefresh() {
    const added = _lastAdded;
    _lastAdded = [];
    if (!(refreshMs > 0)) return;
    if (typeof window === 'undefined' || typeof CustomEvent !== 'function')
      return;
    try {
      window.dispatchEvent(
        new CustomEvent('gev:layer-refreshed', {
          detail: {
            layerId: id,
            layerName: name,
            count: _count,
            retained: _retainedCount,
            error: _error,
            added,
            features: featureSnapshot(),
          },
        }),
      );
    } catch {
      /* a listener throwing is not this layer's problem */
    }
  }

  /** The current features, geometry intact, with a flat lat/lon for counters. */
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

  function selectedRecordKey(viewer) {
    const selected = viewer?.selectedEntity;
    if (!selected || selected.__localLayerId !== id) return null;
    return (
      _stemRecords.find((record) => record.entity === selected)?.id ?? null
    );
  }

  /**
   * Re-point the selection at the rebuilt entity carrying the same key. The
   * re-select re-announces it, so an open detail panel shows fresh values.
   */
  function restoreSelection(viewer, recordId) {
    if (!recordId) return;
    const record = _stemRecords.find((candidate) => candidate.id === recordId);
    if (record) {
      viewer.selectedEntity = record.entity;
      selectEntityContext(record.entity);
    } else if (viewer.selectedEntity?.__localLayerId === id) {
      // Gone for good: the feed dropped it and its retention window closed.
      viewer.selectedEntity = undefined;
    }
  }

  /**
   * Re-fetch and swap. A failed poll keeps the last good data on screen and
   * reports the failure: emptying the layer because one fetch timed out would
   * turn a network blip into "there are no incidents".
   */
  async function refreshLayer(viewer, signal) {
    if (_destroyed || !_enabled || !_dataSource || !viewer) return;
    if (!(refreshMs > 0) || _live !== true || _refreshing) return;
    // The lifecycle calls update() straight after enable(); that load is fresh.
    if (Date.now() - _lastLoadAt < refreshMs / 2) return;
    _refreshing = true;
    const selected = selectedRecordKey(viewer);
    try {
      const features = await fetchFeatures(signal);
      if (_destroyed || !_enabled) return;
      const built = await buildSource(viewer, features);
      if (_destroyed || !_enabled) {
        viewer.dataSources.remove(built.loaded, true);
        return;
      }
      _lastFeatures = features;
      commit(viewer, built);
      _error = null;
      _lastUpdate = Date.now();
      restoreSelection(viewer, selected);
      viewer.scene.requestRender?.();
      announceRefresh();
    } catch (error) {
      if (isAbortError(error)) return;
      _error = `live update failed (${error?.message || 'unknown'})`;
      console.warn(`[${id}] refresh failed; keeping the last good data`, error);
    } finally {
      _refreshing = false;
    }
  }

  const api = {
    id,
    name,
    icon,
    source,
    updateInterval: refreshMs,
    statsRefreshInterval: 1000,

    init: async () => {},

    update: async (viewer, { signal } = {}) => {
      await refreshLayer(viewer, signal);
    },

    /** `retained` is how many of `count` are held past their feed. */
    getStats: () => ({
      count: _count,
      retained: _retainedCount,
      lastUpdate: _lastUpdate,
      error: _error,
    }),

    /** Whether the layer is reading a live feed (null until first load). */
    isLive: () => _live,

    enable: async (viewer) => {
      if (_destroyed) return;
      _enabled = true;
      _stemGeometryDirty = true;
      _lastVisibilityUpdate = Number.NEGATIVE_INFINITY;
      _groundRetryArms = 0;
      _lastGroundSampleCapability = null;
      resetLod();
      _overlayPublisher.show();

      if (!_dataSource) {
        if (!_loadPromise)
          _loadPromise = (async () => {
            _loadController = new AbortController();
            _error = null;
            try {
              const features =
                _cachedFeatures ??
                (await fetchFeatures(_loadController.signal));
              if (_destroyed) return;
              if (!(refreshMs > 0)) _cachedFeatures = features;
              const built = await buildSource(viewer, features);
              if (_destroyed) {
                viewer.dataSources.remove(built.loaded, true);
                return;
              }
              _lastFeatures = features;
              commit(viewer, built);
              _lastUpdate = Date.now();
            } catch (error) {
              if (_destroyed) return;
              _error = _live
                ? `live feed unavailable (${error?.message || 'unknown'})`
                : localDatasetError(error);
              removeEntityContextsForLayer(id);
              _count = 0;
              _stemRecords = [];
              console.error(`Failed to load ${id}:`, error);
            }
            if (!_destroyed) installClickHandler(viewer);
          })();
        try {
          await _loadPromise;
        } finally {
          _loadPromise = null;
          _loadController = null;
        }
      }

      if (_destroyed) return;
      if (_enabled) installWalk(viewer);
      // Honor a disable() that landed while the fetch was in flight.
      if (!_enabled) {
        releaseDataSource(viewer);
        return;
      }
      if (_dataSource) _dataSource.show = true;
      viewer.scene.requestRender?.();
      announceRefresh();
    },

    disable: disableLayer,

    destroy: (viewer) => {
      if (_destroyed) return;
      _destroyed = true;
      _loadController?.abort();
      disableLayer(viewer);
      removeEntityContextsForLayer(id);
      _clickHandler?.destroy();
      _clickHandler = null;
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _overlayPublisher.destroy();
      _retention.reset();
      _dataSource = null;
      _cachedFeatures = null;
      _lastFeatures = [];
      _stemRecords = [];
      _count = 0;
      _retainedCount = 0;
      _lastUpdate = null;
      _error = null;
    },
  };

  return api;
}
