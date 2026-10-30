// Bundled snapshot URLs for the Victorian datasets. Lazy getters with literal
// `new URL(..., import.meta.url)` so Vite emits each file as an asset without
// importing it at boot, and Node tests can resolve the same paths.

const SNAPSHOT_URLS = Object.freeze({
  'pm-warn-emergency': () =>
    new URL(
      '../../data/local_data/passive-monitor/pm-warn-emergency.geojsonl',
      import.meta.url,
    ).href,
  'pm-warn-watch': () =>
    new URL(
      '../../data/local_data/passive-monitor/pm-warn-watch.geojsonl',
      import.meta.url,
    ).href,
  'pm-warn-advice': () =>
    new URL(
      '../../data/local_data/passive-monitor/pm-warn-advice.geojsonl',
      import.meta.url,
    ).href,
  'pm-warn-community': () =>
    new URL(
      '../../data/local_data/passive-monitor/pm-warn-community.geojsonl',
      import.meta.url,
    ).href,
  'pm-weather-warning': () =>
    new URL(
      '../../data/local_data/passive-monitor/pm-weather-warning.geojsonl',
      import.meta.url,
    ).href,
  'pm-incident': () =>
    new URL(
      '../../data/local_data/passive-monitor/pm-incident.geojsonl',
      import.meta.url,
    ).href,
  'pm-burn': () =>
    new URL(
      '../../data/local_data/passive-monitor/pm-burn.geojsonl',
      import.meta.url,
    ).href,
  'pm-roads': () =>
    new URL(
      '../../data/local_data/passive-monitor/pm-roads.geojsonl',
      import.meta.url,
    ).href,
  'pm-flood': () =>
    new URL(
      '../../data/local_data/passive-monitor/pm-flood.geojsonl',
      import.meta.url,
    ).href,
  'pm-storm': () =>
    new URL(
      '../../data/local_data/passive-monitor/pm-storm.geojsonl',
      import.meta.url,
    ).href,
  'pm-power': () =>
    new URL(
      '../../data/local_data/passive-monitor/pm-power.geojsonl',
      import.meta.url,
    ).href,
  'vicmap-lga': () =>
    new URL(
      '../../data/local_data/vicmap-admin/vicmap-lga.geojsonl',
      import.meta.url,
    ).href,
  'vicmap-cfa-district': () =>
    new URL(
      '../../data/local_data/vicmap-admin/vicmap-cfa-district.geojsonl',
      import.meta.url,
    ).href,
  'vicmap-cfa-tfb': () =>
    new URL(
      '../../data/local_data/vicmap-admin/vicmap-cfa-tfb.geojsonl',
      import.meta.url,
    ).href,
  'vicmap-delwp-region': () =>
    new URL(
      '../../data/local_data/vicmap-admin/vicmap-delwp-region.geojsonl',
      import.meta.url,
    ).href,
  'vicmap-emv-region': () =>
    new URL(
      '../../data/local_data/vicmap-admin/vicmap-emv-region.geojsonl',
      import.meta.url,
    ).href,
  'vicmap-frv-district': () =>
    new URL(
      '../../data/local_data/vicmap-admin/vicmap-frv-district.geojsonl',
      import.meta.url,
    ).href,
  'vicmap-frv-response': () =>
    new URL(
      '../../data/local_data/vicmap-admin/vicmap-frv-response.geojsonl',
      import.meta.url,
    ).href,
  'vicmap-fire-station': () =>
    new URL(
      '../../data/local_data/vicmap-emergency/vicmap-fire-station.geojsonl',
      import.meta.url,
    ).href,
});

/** Snapshot asset URL for a Victorian dataset key. */
export function vicSnapshotUrl(key) {
  const url = SNAPSHOT_URLS[key];
  if (!url) throw new Error(`Unknown Victorian dataset: ${key}`);
  return url();
}
