import { createLocalGeoJsonLayer } from './localGeojson.js';
import { createFirmsHeatmapLayer } from './firmsHeatmap.js';
import submarineCablesLayer from './telegeographySubmarineCables.js';

// Use Vite's ?url import to properly resolve these assets in dev and build
import datacentersUrl from './local_data/datacenters/datacenters.geojsonl?url';
import damsUrl from './local_data/dams/dams.geojsonl?url';

// Passive Monitor — Victorian emergency state, exported from the Passive
// Monitor SQLite database by scripts/export-passive-monitor.mjs. These are
// snapshots, not live feeds; regenerate them by re-running that script.
import pmFireUrl from './local_data/passive-monitor/pm-fire.geojsonl?url';
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
 * Four separate layers rather than one combined feed: the operational question
 * is almost always about a single hazard ("where is the flooding"), and keeping
 * them separate means each gets its own toggle, colour, and label budget. The
 * label caps are lower than the infrastructure layers above because these
 * cluster tightly over Victoria, where a high cap turns into a wall of text.
 */
const passiveMonitorFire = createLocalGeoJsonLayer({
  id: 'local-pm-fire',
  url: pmFireUrl,
  name: 'PM Fire Incidents',
  color: '#ff5a1f', // Warning orange
  icon: '▲',
  source: 'Passive Monitor',
  labels: true,
  labelMax: 120,
  labelGridPx: 140,
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
  passiveMonitorFire,
  passiveMonitorFlood,
  passiveMonitorStorm,
  passiveMonitorPower,
];
