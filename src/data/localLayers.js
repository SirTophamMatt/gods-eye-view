import { createLocalGeoJsonLayer } from './localGeojson.js';
import { createFirmsHeatmapLayer } from './firmsHeatmap.js';
import submarineCablesLayer from './telegeographySubmarineCables.js';

// Use Vite's ?url import to properly resolve these assets in dev and build
import datacentersUrl from './local_data/datacenters/datacenters.geojsonl?url';
import damsUrl from './local_data/dams/dams.geojsonl?url';

// Passive Monitor — Victorian emergency state, exported from the Passive
// Monitor SQLite database by scripts/export-passive-monitor.mjs. These are
// snapshots, not live feeds; regenerate them by re-running that script.
import pmWarnEmergencyUrl from './local_data/passive-monitor/pm-warn-emergency.geojsonl?url';
import pmWarnWatchUrl from './local_data/passive-monitor/pm-warn-watch.geojsonl?url';
import pmWarnAdviceUrl from './local_data/passive-monitor/pm-warn-advice.geojsonl?url';
import pmWarnCommunityUrl from './local_data/passive-monitor/pm-warn-community.geojsonl?url';
import pmIncidentUrl from './local_data/passive-monitor/pm-incident.geojsonl?url';
import pmBurnUrl from './local_data/passive-monitor/pm-burn.geojsonl?url';
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
  url: pmWarnEmergencyUrl,
  name: 'PM Emergency Warnings',
  color: '#d62728', // PM WARNING_STYLE: Emergency Warning
  icon: '★',
  source: 'Passive Monitor',
  labels: true,
  labelMax: 120,
  labelGridPx: 140,
});

const passiveMonitorWarnWatch = createLocalGeoJsonLayer({
  id: 'local-pm-warn-watch',
  url: pmWarnWatchUrl,
  name: 'PM Watch & Act',
  color: '#ff7f0e', // PM WARNING_STYLE: Watch and Act
  icon: '▲',
  source: 'Passive Monitor',
  labels: true,
  labelMax: 120,
  labelGridPx: 140,
});

const passiveMonitorWarnAdvice = createLocalGeoJsonLayer({
  id: 'local-pm-warn-advice',
  url: pmWarnAdviceUrl,
  name: 'PM Advice',
  color: '#e6c700', // PM WARNING_STYLE: Advice
  icon: '◆',
  source: 'Passive Monitor',
  labels: true,
  labelMax: 120,
  labelGridPx: 140,
});

const passiveMonitorWarnCommunity = createLocalGeoJsonLayer({
  id: 'local-pm-warn-community',
  url: pmWarnCommunityUrl,
  name: 'PM Community Info',
  color: '#9aa0a6', // PM classify() fallback grey — no styled level upstream
  icon: '●',
  source: 'Passive Monitor',
  labels: true,
  labelMax: 120,
  labelGridPx: 140,
});

// Operational events at a point — fire, tree down, rescue, hazmat. These carry
// no warning level at all, so they deliberately sit outside the red/orange/
// yellow ladder rather than competing with it for the same hues.
const passiveMonitorIncident = createLocalGeoJsonLayer({
  id: 'local-pm-incident',
  url: pmIncidentUrl,
  name: 'PM Incidents',
  color: '#00d1b2',
  icon: '✚',
  source: 'Passive Monitor',
  labels: true,
  labelMax: 120,
  labelGridPx: 140,
});

const passiveMonitorBurn = createLocalGeoJsonLayer({
  id: 'local-pm-burn',
  url: pmBurnUrl,
  name: 'PM Burn Areas',
  color: '#8b5a2b',
  icon: '■',
  source: 'Passive Monitor',
  labels: true,
  labelMax: 80,
  labelGridPx: 150,
});

const passiveMonitorFlood = createLocalGeoJsonLayer({
  id: 'local-pm-flood',
  url: pmFloodUrl,
  name: 'PM Flood Gauges',
  color: '#2ea8ff', // Water blue
  icon: '▼',
  source: 'Passive Monitor',
  labels: true,
  // The gauge network is the densest of the four — 300+ stations clustered over
  // one state — so it gets the widest collision grid to stay readable when the
  // camera is high enough to see the whole catchment system at once.
  labelMax: 140,
  labelGridPx: 172,
});

const passiveMonitorStorm = createLocalGeoJsonLayer({
  id: 'local-pm-storm',
  url: pmStormUrl,
  name: 'PM Storm Cells',
  color: '#b45cff', // Radar violet
  icon: '◈',
  source: 'Passive Monitor',
  labels: true,
  labelMax: 90,
  labelGridPx: 140,
});

const passiveMonitorPower = createLocalGeoJsonLayer({
  id: 'local-pm-power',
  url: pmPowerUrl,
  name: 'PM Power Outages',
  color: '#ffc61a', // Supply yellow
  icon: '◉',
  source: 'Passive Monitor',
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
  passiveMonitorIncident,
  passiveMonitorBurn,
  passiveMonitorFlood,
  passiveMonitorStorm,
  passiveMonitorPower,
];
