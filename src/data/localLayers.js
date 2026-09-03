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
import pmWeatherWarningUrl from './local_data/passive-monitor/pm-weather-warning.geojsonl?url';
import pmIncidentUrl from './local_data/passive-monitor/pm-incident.geojsonl?url';
import pmBurnUrl from './local_data/passive-monitor/pm-burn.geojsonl?url';
import pmRoadsUrl from './local_data/passive-monitor/pm-roads.geojsonl?url';
import pmFloodUrl from './local_data/passive-monitor/pm-flood.geojsonl?url';
import pmStormUrl from './local_data/passive-monitor/pm-storm.geojsonl?url';
import pmPowerUrl from './local_data/passive-monitor/pm-power.geojsonl?url';

// Vicmap Admin boundaries — the reference geometry the Passive Monitor layers
// above are implicitly issued against. Snapshots only, produced by
// scripts/export-vicmap-admin.mjs; see that script for why these are not live.
import vicLgaUrl from './local_data/vicmap-admin/vicmap-lga.geojsonl?url';
import vicCfaDistrictUrl from './local_data/vicmap-admin/vicmap-cfa-district.geojsonl?url';
import vicCfaTfbUrl from './local_data/vicmap-admin/vicmap-cfa-tfb.geojsonl?url';
import vicDelwpRegionUrl from './local_data/vicmap-admin/vicmap-delwp-region.geojsonl?url';
import vicEmvRegionUrl from './local_data/vicmap-admin/vicmap-emv-region.geojsonl?url';
import vicFrvDistrictUrl from './local_data/vicmap-admin/vicmap-frv-district.geojsonl?url';
import vicFrvResponseUrl from './local_data/vicmap-admin/vicmap-frv-response.geojsonl?url';
import vicFireStationUrl from './local_data/vicmap-emergency/vicmap-fire-station.geojsonl?url';

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
 * Bureau-issued warnings — riverine flood, damaging wind, severe weather —
 * lifted out of BOTH the escalation ladder and the Incidents layer so weather
 * can be toggled independently of fire.
 *
 * Matched on 'Met' in EITHER category column, because the feed classifies these
 * two different ways: flood warnings arrive as feed_type 'warning' with
 * category2='Met', while district wind warnings arrive as feed_type 'incident'
 * with category1='Met'. Checking one column left the wind warnings showing as
 * incidents.
 *
 * This is the SPATIAL half of the BoM products that Passive Monitor also stores
 * as text in `weather_warnings`. That table is not drawn: 5 of its 12 rows are
 * whole-district products ("East Gippsland forecast district", "Victoria") with
 * no point to place, and name-matching the rest to a gauge would pin a
 * whole-reach warning onto one arbitrary station. These records carry the real
 * warning-area polygons instead.
 */
const passiveMonitorWeatherWarning = createLocalGeoJsonLayer({
  id: 'local-pm-weather-warning',
  url: passiveMonitorSource('pm-weather-warning', pmWeatherWarningUrl),
  name: 'PM Weather Warnings',
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

/**
 * Flood-gauge styling by classification.
 *
 * The layer is 319 gauges of which, on a normal day, three are above their
 * flood level. Drawn as one uniform field of blue dots, the three that matter
 * are the three you cannot find — the layer answers "where are the gauges"
 * when the question is "which ones are up".
 *
 * Colours are Passive Monitor's own warning palette, the same one the
 * escalation ladder uses, so a gauge at Moderate reads as the same orange as a
 * Watch and Act. Size carries the same signal redundantly, because at a
 * state-wide camera a 9 px dot and a 14 px dot separate long before their hues
 * do — and because colour alone excludes anyone who cannot distinguish these
 * hues.
 *
 * Below-flood gauges get SMALLER than the old uniform 10 px rather than
 * staying put: they are context, and 316 of them at full size is the wall the
 * three signals have to compete with.
 */
const FLOOD_SEVERITY_STYLE = Object.freeze({
  0: { color: '#2ea8ff', pixelSize: 8 }, // Below flood level — water blue
  1: { color: '#e6c700', pixelSize: 14 }, // Minor — PM Advice yellow
  2: { color: '#ff7f0e', pixelSize: 17 }, // Moderate — PM Watch and Act orange
  3: { color: '#d62728', pixelSize: 20 }, // Major — PM Emergency Warning red
});

/**
 * @param {object} props Gauge feature properties.
 * @returns {{color: string, pixelSize: number}} Style for this gauge.
 */
function floodGaugeStyle(props) {
  const severity = Number(props?.severity);
  return FLOOD_SEVERITY_STYLE[Number.isFinite(severity) ? severity : 0]
    || FLOOD_SEVERITY_STYLE[0];
}

const passiveMonitorFlood = createLocalGeoJsonLayer({
  id: 'local-pm-flood',
  url: passiveMonitorSource('pm-flood', pmFloodUrl),
  name: 'PM Flood Gauges',
  color: '#2ea8ff', // Water blue — the layer chip and the below-flood majority
  icon: '▼',
  source: PM_SOURCE_LABEL,
  styleFeature: floodGaugeStyle,
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

/**
 * Vicmap Admin boundary layers.
 *
 * These answer a different question from every layer above them. A hazard
 * layer says what is happening; a boundary layer says whose problem it is —
 * which brigade district a fire sits in, which council will run the recovery,
 * which region a total fire ban actually covers. On their own they are
 * furniture; under the Passive Monitor layers they are the frame that makes
 * the hazards legible.
 *
 * They are the only `outlineOnly` layers in the registry, and the palette
 * follows from that: every hazard layer above owns a SATURATED hue, so the
 * boundaries take desaturated ones and group by agency (the two FRV layers
 * share a teal family, the two CFA layers a warm-earth one). A boundary can
 * then never be mistaken for a warning at a glance, which matters most in
 * exactly the situation these are drawn for.
 *
 * Labels are capped low and gridded wide. There are only ~140 polygons across
 * all seven, but they are all in one state, so at a Victoria-wide camera every
 * label competes with every other one — and with whatever hazard cards are
 * already on screen.
 */
const VICMAP_SOURCE = 'Vicmap Admin';
const VICMAP_BOUNDARY_DEFAULTS = Object.freeze({
  outlineOnly: true,
  source: VICMAP_SOURCE,
  labels: true,
  labelMax: 60,
  labelGridPx: 190,
});

const vicmapLga = createLocalGeoJsonLayer({
  ...VICMAP_BOUNDARY_DEFAULTS,
  id: 'local-vicmap-lga',
  url: vicLgaUrl,
  name: 'VIC Local Government Areas',
  color: '#9fb3c8', // Neutral steel — the civil base layer under everything
  icon: '▢',
  // 79 councils plus alpine resorts and unincorporated islands, so this is the
  // densest of the seven and the one most likely to be on with hazards.
  labelMax: 80,
});

const vicmapCfaDistrict = createLocalGeoJsonLayer({
  ...VICMAP_BOUNDARY_DEFAULTS,
  id: 'local-vicmap-cfa-district',
  url: vicCfaDistrictUrl,
  name: 'VIC CFA Districts',
  color: '#c98a7d', // CFA red, desaturated well clear of the warning ladder
  icon: '◫',
});

const vicmapCfaTfb = createLocalGeoJsonLayer({
  ...VICMAP_BOUNDARY_DEFAULTS,
  id: 'local-vicmap-cfa-tfb',
  url: vicCfaTfbUrl,
  name: 'VIC Total Fire Ban Districts',
  color: '#d9a05b', // Warm earth, same family as the CFA districts above
  icon: '◪',
});

const vicmapDelwpRegion = createLocalGeoJsonLayer({
  ...VICMAP_BOUNDARY_DEFAULTS,
  id: 'local-vicmap-delwp-region',
  url: vicDelwpRegionUrl,
  name: 'VIC DELWP Regions',
  color: '#7fb069', // Land-management green
  icon: '⬡',
});

const vicmapEmvRegion = createLocalGeoJsonLayer({
  ...VICMAP_BOUNDARY_DEFAULTS,
  id: 'local-vicmap-emv-region',
  url: vicEmvRegionUrl,
  name: 'VIC Emergency Management Regions',
  color: '#a89ae0', // Coordination violet
  icon: '⬢',
});

const vicmapFrvDistrict = createLocalGeoJsonLayer({
  ...VICMAP_BOUNDARY_DEFAULTS,
  id: 'local-vicmap-frv-district',
  url: vicFrvDistrictUrl,
  name: 'VIC FRV Districts',
  color: '#6fb3ad', // FRV teal
  icon: '◧',
});

const vicmapFrvResponse = createLocalGeoJsonLayer({
  ...VICMAP_BOUNDARY_DEFAULTS,
  id: 'local-vicmap-frv-response',
  url: vicFrvResponseUrl,
  name: 'VIC FRV Response Area',
  color: '#4a8f96', // Deeper FRV teal — same agency, one rung down
  icon: '◨',
  // One dissolved region in 22 parts, every part sharing a name. The line is
  // the product here, not the label, so the cap only needs to cover the few
  // parts big enough to read.
  labelMax: 12,
});

/**
 * Fire stations from the Vicmap gazetteer — 1,705 of them, and a quarter are
 * NOT Victorian: Vicmap covers the border overlap, so 334 NSW and 81 SA
 * brigades sit alongside the 1,288 VIC ones. Kept rather than filtered,
 * because near Nelson or Mallacoota the nearest brigade really is over the
 * line, and the layer name says so rather than overclaiming.
 *
 * A point layer, so it needs none of the boundary machinery above: the
 * stem-and-point presentation the datacenters layer has always used is exactly
 * right for "a thing is HERE".
 *
 * Green, not red, and that is the whole reasoning. Standard emergency-
 * management convention reads red as hazard and green as resource, and this
 * app already spends its reds on the warning ladder — a station drawn in
 * CFA red would sit one hue away from an Emergency Warning on the same globe.
 *
 * The label budget is the tightest in the registry. 1,705 points over one
 * state is denser than any other layer here, and they cluster hardest around
 * Melbourne where the hazard cards already compete for room.
 */
const vicmapFireStation = createLocalGeoJsonLayer({
  id: 'local-vicmap-fire-station',
  url: vicFireStationUrl,
  name: 'Fire Stations (VIC + border)',
  color: '#2ecc71',
  icon: '⌂',
  source: 'Vicmap FOI',
  labels: true,
  labelMax: 90,
  labelGridPx: 165,
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
  passiveMonitorWeatherWarning,
  passiveMonitorIncident,
  passiveMonitorBurn,
  passiveMonitorFlood,
  passiveMonitorStorm,
  passiveMonitorPower,
  passiveMonitorRoads,
  // Boundaries last: they are the frame the hazards above are read against,
  // and this order is what the layer tray shows.
  vicmapLga,
  vicmapCfaDistrict,
  vicmapCfaTfb,
  vicmapDelwpRegion,
  vicmapEmvRegion,
  vicmapFrvDistrict,
  vicmapFrvResponse,
  // Resources, after the boundaries that dispatch them.
  vicmapFireStation,
];
