import { createVicGeoJsonLayer } from './geojsonLayer.js';
import { vicSnapshotUrl } from './snapshotUrls.js';

export { vicSnapshotUrl };

// The Victorian layers: Passive Monitor hazards, Vicmap Admin boundaries and
// Vicmap fire stations. Registered from src/app/constructCatalog.js.

/**
 * Ask the server once whether a Passive Monitor instance is configured. Any
 * failure reads as "not live", which loads the committed snapshots.
 * @param {function} fetchImpl
 * @returns {function(): Promise<boolean>}
 */
export function createPassiveMonitorStatus(
  fetchImpl = (...args) => globalThis.fetch(...args),
) {
  let pending = null;
  return () => {
    pending ??= (async () => {
      try {
        const response = await fetchImpl('/api/passive-monitor/status', {
          cache: 'no-store',
        });
        if (!response.ok) return false;
        return (await response.json())?.live === true;
      } catch {
        return false;
      }
    })();
    return pending;
  };
}

/**
 * A Passive Monitor layer's source: the live proxy when an instance is
 * configured, otherwise the committed snapshot. Live has no automatic fallback:
 * an unreachable instance reports an error rather than quietly showing old
 * hazard data.
 */
function passiveMonitorSource(pmId, isLive) {
  return async () =>
    (await isLive())
      ? { url: `/api/passive-monitor/geojson/${pmId}`, live: true }
      : { url: vicSnapshotUrl(pmId), live: false };
}

/**
 * Live policy, applied only once the source resolves live (the factory skips
 * refreshes for a snapshot). Two minutes is the cadence the data moves at: the
 * collectors run on their own schedule and the proxy caches for 30 s. Ten
 * minutes of retention rides out a missed poll without asserting a closed job
 * is still running; the card reads NOT IN LAST UPDATE from the first miss.
 */
const PM_LIVE_POLICY = Object.freeze({
  refreshMs: 120_000,
  retentionMs: 600_000,
});

const FLOOD_SEVERITY_STYLE = Object.freeze({
  0: { color: '#2ea8ff', pixelSize: 8 }, // below flood level
  1: { color: '#e6c700', pixelSize: 14 }, // minor
  2: { color: '#ff7f0e', pixelSize: 17 }, // moderate
  3: { color: '#d62728', pixelSize: 20 }, // major
});

/** Flood gauges: the few above flood level have to be findable among ~300. */
export function floodGaugeStyle(props) {
  const severity = Number(props?.severity);
  return (
    FLOOD_SEVERITY_STYLE[Number.isFinite(severity) ? severity : 0] ||
    FLOOD_SEVERITY_STYLE[0]
  );
}

const PM_LAYERS = Object.freeze([
  // Warnings split by escalation level, colours from Passive Monitor's
  // WARNING_STYLE ladder.
  {
    pm: 'pm-warn-emergency',
    name: 'PM Emergency Warnings',
    color: '#d62728',
    icon: '★',
  },
  { pm: 'pm-warn-watch', name: 'PM Watch & Act', color: '#ff7f0e', icon: '▲' },
  { pm: 'pm-warn-advice', name: 'PM Advice', color: '#e6c700', icon: '◆' },
  {
    pm: 'pm-warn-community',
    name: 'PM Community Info',
    color: '#9aa0a6',
    icon: '●',
  },
  {
    pm: 'pm-weather-warning',
    name: 'PM Weather Warnings',
    color: '#00b7ff',
    icon: '◇',
    via: 'BoM',
    labelGridPx: 150,
  },
  { pm: 'pm-incident', name: 'PM Incidents', color: '#00d1b2', icon: '✚' },
  {
    pm: 'pm-burn',
    name: 'PM Burn Areas',
    color: '#8b5a2b',
    icon: '■',
    labelMax: 80,
    labelGridPx: 150,
  },
  {
    pm: 'pm-flood',
    name: 'PM Flood Gauges',
    color: '#2ea8ff',
    icon: '▼',
    styleFeature: floodGaugeStyle,
    labelMax: 140,
    labelGridPx: 172,
  },
  {
    pm: 'pm-storm',
    name: 'PM Storm Cells',
    color: '#b45cff',
    icon: '◈',
    labelMax: 90,
  },
  { pm: 'pm-power', name: 'PM Power Outages', color: '#ffc61a', icon: '◉' },
  {
    pm: 'pm-roads',
    name: 'PM Road Disruptions',
    color: '#ff6b9d',
    icon: '⊘',
    via: 'VicTraffic',
    labelMax: 110,
  },
]);

const VICMAP_BOUNDARIES = Object.freeze([
  {
    key: 'vicmap-lga',
    name: 'VIC Local Government Areas',
    color: '#9fb3c8',
    icon: '▢',
    labelMax: 80,
  },
  {
    key: 'vicmap-cfa-district',
    name: 'VIC CFA Districts',
    color: '#c98a7d',
    icon: '◫',
  },
  {
    key: 'vicmap-cfa-tfb',
    name: 'VIC Total Fire Ban Districts',
    color: '#d9a05b',
    icon: '◪',
  },
  {
    key: 'vicmap-delwp-region',
    name: 'VIC DELWP Regions',
    color: '#7fb069',
    icon: '⬡',
  },
  {
    key: 'vicmap-emv-region',
    name: 'VIC Emergency Management Regions',
    color: '#a89ae0',
    icon: '⬢',
  },
  {
    key: 'vicmap-frv-district',
    name: 'VIC FRV Districts',
    color: '#6fb3ad',
    icon: '◧',
  },
  {
    key: 'vicmap-frv-response',
    name: 'VIC FRV Response Area',
    color: '#4a8f96',
    icon: '◨',
    labelMax: 12,
  },
]);

/**
 * Construct the Victorian layers.
 * @param {object} services `localGeoJsonServices`.
 * @param {{isPassiveMonitorLive?: function(): Promise<boolean>}} [options]
 * @returns {object[]} Layers, in VIC_LAYER_IDS order.
 */
export function createVicLayers(
  services,
  { isPassiveMonitorLive = createPassiveMonitorStatus() } = {},
) {
  const pm = PM_LAYERS.map(({ pm: pmId, via, ...rest }) =>
    createVicGeoJsonLayer(
      {
        labelMax: 120,
        labelGridPx: 140,
        ...rest,
        ...PM_LIVE_POLICY,
        id: `local-${pmId}`,
        url: passiveMonitorSource(pmId, isPassiveMonitorLive),
        source: via ? `Passive Monitor · ${via}` : 'Passive Monitor',
        liveSource: via
          ? `Passive Monitor · LIVE · ${via}`
          : 'Passive Monitor · LIVE',
      },
      services,
    ),
  );
  const boundaries = VICMAP_BOUNDARIES.map(({ key, ...rest }) =>
    createVicGeoJsonLayer(
      {
        outlineOnly: true,
        source: 'Vicmap Admin',
        labelMax: 60,
        labelGridPx: 190,
        ...rest,
        id: `local-${key}`,
        url: vicSnapshotUrl(key),
      },
      services,
    ),
  );
  const fireStations = createVicGeoJsonLayer(
    {
      id: 'local-vicmap-fire-station',
      url: vicSnapshotUrl('vicmap-fire-station'),
      name: 'Fire Stations (VIC + border)',
      color: '#2ecc71',
      icon: '⌂',
      source: 'Vicmap FOI',
      labelMax: 90,
      labelGridPx: 165,
    },
    services,
  );
  return [...pm, ...boundaries, fireStations];
}
