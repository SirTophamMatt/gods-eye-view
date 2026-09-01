import { createLocalGeoJsonLayer } from './localGeojson.js';
import { createFirmsHeatmapLayer } from './firmsHeatmap.js';
import submarineCablesLayer from './telegeographySubmarineCables.js';

// Use Vite's ?url import to properly resolve these assets in dev and build
import datacentersUrl from './local_data/datacenters/datacenters.geojsonl?url';
import damsUrl from './local_data/dams/dams.geojsonl?url';

// Passive Monitor — Victorian emergency state.
//
// Each layer has two possible sources, chosen at build time by whether a
// Passive Monitor instance is configured:
//
//   live      /api/passive-monitor/geojson/<id>, brokered by the Vite proxy to
//             that instance's read-only /api/intel endpoints. Set
//             PASSIVE_MONITOR_URL to enable.
//   snapshot  the committed .geojsonl below, produced by
//             scripts/export-passive-monitor.mjs.
//
// Both emit an IDENTICAL property contract — verified feature-for-feature
// across the whole dataset — which is what makes the source a URL swap and
// nothing more. Keep it that way: if you change a field in one, change it in
// the other (app/api_intel.py in the Passive Monitor repo).
import pmWarnEmergencyUrl from './local_data/passive-monitor/pm-warn-emergency.geojsonl?url';
import pmWarnWatchUrl from './local_data/passive-monitor/pm-warn-watch.geojsonl?url';
import pmWarnAdviceUrl from './local_data/passive-monitor/pm-warn-advice.geojsonl?url';
import pmWarnCommunityUrl from './local_data/passive-monitor/pm-warn-community.geojsonl?url';
import pmFloodWarningUrl from './local_data/passive-monitor/pm-flood-warning.geojsonl?url';
import pmIncidentUrl from './local_data/passive-monitor/pm-incident.geojsonl?url';
import pmBurnUrl from './local_data/passive-monitor/pm-burn.geojsonl?url';
import pmRoadsUrl from './local_data/passive-monitor/pm-roads.geojsonl?url';
import pmFloodUrl from './local_data/passive-monitor/pm-flood.geojsonl?url';
import pmStormUrl from './local_data/passive-monitor/pm-storm.geojsonl?url';
import pmPowerUrl from './local_data/passive-monitor/pm-power.geojsonl?url';

/**
 * Registry of local GeoJSON datasets.
 * These are lazily loaded natively into Cesium when enabled.
 */
const datacenters = createLocalGeoJsonLayer({
  id: 'local-datacenters',
  url: datacentersUrl,
  name: 'Datacenters',
  color: '#00ffff', // Cyan
  icon: '▣',
  source: 'Local',
  labels: true,
  labelMax: 700,
  labelGridPx: 138,
});

const dams = createLocalGeoJsonLayer({
  id: 'local-dams',
  url: damsUrl,
  name: 'Dams',
  color: '#0088ff', // Blue
  icon: '▰',
  source: 'USACE',
  labels: true,
  labelMax: 900,
  labelGridPx: 132,
});

// Live NASA FIRMS fires (VIIRS ×3 NRT via the /api/firms proxy). The id keeps
// the historical `local-` prefix for persistence + voice-tool-enum compat,
// but the data is NOT bundled anymore — it needs FIRMS_MAP_KEY server-side.
const fires = createFirmsHeatmapLayer({
  id: 'local-firms',
  name: 'FIRMS Active Fires',
  icon: '▲',
  source: 'NASA FIRMS · LIVE',
});

/**
 * Resolve one Passive Monitor layer's data source.
 *
 * `import.meta.env.PASSIVE_MONITOR_LIVE` is a boolean stamped in by
 * vite.config.js — true only when PASSIVE_MONITOR_URL resolved to a valid
 * origin. The URL itself never reaches the bundle, so the browser cannot learn
 * where the instance lives; it only ever talks to this app's own proxy path.
 *
 * @param {string} layerId Passive Monitor layer id, e.g. 'pm-flood-warning'.
 * @param {string} snapshotUrl Bundled .geojsonl fallback.
 * @returns {string} The URL the layer should fetch.
 */
function passiveMonitorSource(layerId, snapshotUrl) {
  return import.meta.env.PASSIVE_MONITOR_LIVE
    ? `/api/passive-monitor/geojson/${layerId}`
    : snapshotUrl;
}

/** Whether the PM layers are reading live data — shown in each layer's credit. */
const PM_LIVE = Boolean(import.meta.env.PASSIVE_MONITOR_LIVE);
const PM_SOURCE_LABEL = PM_LIVE ? 'Passive Monitor · LIVE' : 'Passive Monitor';

/**
 * Passive Monitor hazard layers.
 *
 * Separate layers rather than one combined feed: the operational question is
 * almost always about a single hazard or a single escalation level ("what is at
 * Watch and Act"), and keeping them apart means each gets its own toggle,
 * colour, and label budget. The label caps are lower than the infrastructure
 * layers above because these cluster tightly over Victoria, where a high cap
 * turns into a wall of text.
 *
 * The four warning layers use Passive Monitor's OWN palette from
 * app/modules/fire/data.py, so a level is the same colour in both products.
 * Community Information has no entry there — Passive Monitor styles only
 * Emergency Warning, Watch and Act and Advice — so it takes that module's
 * neutral fallback grey.
 *
 * An empty warning layer is normal and meaningful: it means nothing is current
 * at that level. It still registers and still toggles.
 */
const passiveMonitorWarnEmergency = createLocalGeoJsonLayer({
  id: 'local-pm-warn-emergency',
  url: passiveMonitorSource('pm-warn-emergency', pmWarnEmergencyUrl),
  name: 'PM Emergency Warnings',
  color: '#d62728', // PM WARNING_STYLE: Emergency Warning
  icon: '★',
  source: PM_SOURCE_LABEL,
  labels: true,
  labelMax: 120,
  labelGridPx: 140,
});

const passiveMonitorWarnWatch = createLocalGeoJsonLayer({
  id: 'local-pm-warn-watch',
  url: passiveMonitorSource('pm-warn-watch', pmWarnWatchUrl),
  name: 'PM Watch & Act',
  color: '#ff7f0e', // PM WARNING_STYLE: Watch and Act
  icon: '▲',
  source: PM_SOURCE_LABEL,
  labels: true,
  labelMax: 120,
  labelGridPx: 140,
});

const passiveMonitorWarnAdvice = createLocalGeoJsonLayer({
  id: 'local-pm-warn-advice',
  url: passiveMonitorSource('pm-warn-advice', pmWarnAdviceUrl),
  name: 'PM Advice',
  color: '#e6c700', // PM WARNING_STYLE: Advice
  icon: '◆',
  source: PM_SOURCE_LABEL,
  labels: true,
  labelMax: 120,
  labelGridPx: 140,
});

const passiveMonitorWarnCommunity = createLocalGeoJsonLayer({
  id: 'local-pm-warn-community',
  url: passiveMonitorSource('pm-warn-community', pmWarnCommunityUrl),
  name: 'PM Community Info',
  color: '#9aa0a6', // PM classify() fallback grey — no styled level upstream
  icon: '●',
  source: PM_SOURCE_LABEL,
  labels: true,
  labelMax: 120,
  labelGridPx: 140,
});

/**
 * Bureau-issued warnings (`category2 = 'Met'`) — riverine flood, severe weather,
 * thunderstorm — lifted out of the escalation-ladder layers so weather can be
 * toggled independently of fire.
 *
 * This is the SPATIAL half of the BoM products that Passive Monitor also stores
 * as text in `weather_warnings`. That table is not drawn: 5 of its 12 rows are
 * whole-district products ("East Gippsland forecast district", "Victoria") with
 * no point to place, and name-matching the rest to a gauge would pin a
 * whole-reach warning onto one arbitrary station. These records carry the real
 * warning-area polygons instead.
 */
const passiveMonitorFloodWarning = createLocalGeoJsonLayer({
  id: 'local-pm-flood-warning',
  url: passiveMonitorSource('pm-flood-warning', pmFloodWarningUrl),
  name: 'PM Flood Warnings',
  color: '#00b7ff',
  icon: '◇',
  source: `${PM_SOURCE_LABEL} · BoM`,
  labels: true,
  labelMax: 120,
  labelGridPx: 150,
});

// Operational events at a point — fire, tree down, rescue, hazmat. These carry
// no warning level at all, so they deliberately sit outside the red/orange/
// yellow ladder rather than competing with it for the same hues.
const passiveMonitorIncident = createLocalGeoJsonLayer({
  id: 'local-pm-incident',
  url: passiveMonitorSource('pm-incident', pmIncidentUrl),
  name: 'PM Incidents',
  color: '#00d1b2',
  icon: '✚',
  source: PM_SOURCE_LABEL,
  labels: true,
  labelMax: 120,
  labelGridPx: 140,
});

const passiveMonitorBurn = createLocalGeoJsonLayer({
  id: 'local-pm-burn',
  url: passiveMonitorSource('pm-burn', pmBurnUrl),
  name: 'PM Burn Areas',
  color: '#8b5a2b',
  icon: '■',
  source: PM_SOURCE_LABEL,
  labels: true,
  labelMax: 80,
  labelGridPx: 150,
});

/**
 * VicTraffic road disruptions. EMPTY until Passive Monitor holds a VicRoads
 * Data Exchange API key (`roads.api_key`) — that collector log-and-skips
 * without one, so the table has no rows to export. The layer is registered now
 * so it fills on the next export once the key is set, with no code change.
 */
const passiveMonitorRoads = createLocalGeoJsonLayer({
  id: 'local-pm-roads',
  url: passiveMonitorSource('pm-roads', pmRoadsUrl),
  name: 'PM Road Disruptions',
  color: '#ff6b9d',
  icon: '⊘',
  source: `${PM_SOURCE_LABEL} · VicTraffic`,
  labels: true,
  labelMax: 110,
  labelGridPx: 140,
});

const passiveMonitorFlood = createLocalGeoJsonLayer({
  id: 'local-pm-flood',
  url: passiveMonitorSource('pm-flood', pmFloodUrl),
  name: 'PM Flood Gauges',
  color: '#2ea8ff', // Water blue
  icon: '▼',
  source: PM_SOURCE_LABEL,
  labels: true,
  // The gauge network is the densest of the four — 300+ stations clustered over
  // one state — so it gets the widest collision grid to stay readable when the
  // camera is high enough to see the whole catchment system at once.
  labelMax: 140,
  labelGridPx: 172,
});

const passiveMonitorStorm = createLocalGeoJsonLayer({
  id: 'local-pm-storm',
  url: passiveMonitorSource('pm-storm', pmStormUrl),
  name: 'PM Storm Cells',
  color: '#b45cff', // Radar violet
  icon: '◈',
  source: PM_SOURCE_LABEL,
  labels: true,
  labelMax: 90,
  labelGridPx: 140,
});

const passiveMonitorPower = createLocalGeoJsonLayer({
  id: 'local-pm-power',
  url: passiveMonitorSource('pm-power', pmPowerUrl),
  name: 'PM Power Outages',
  color: '#ffc61a', // Supply yellow
  icon: '◉',
  source: PM_SOURCE_LABEL,
  labels: true,
  labelMax: 120,
  labelGridPx: 140,
});

export default [
  datacenters,
  dams,
  submarineCablesLayer,
  fires,
  // Warning ladder, most severe first.
  passiveMonitorWarnEmergency,
  passiveMonitorWarnWatch,
  passiveMonitorWarnAdvice,
  passiveMonitorWarnCommunity,
  passiveMonitorFloodWarning,
  passiveMonitorIncident,
  passiveMonitorBurn,
  passiveMonitorFlood,
  passiveMonitorStorm,
  passiveMonitorPower,
  passiveMonitorRoads,
];
