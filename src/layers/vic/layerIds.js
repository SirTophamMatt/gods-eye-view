// Every Victorian layer id, in panel order. Pure data so the voice manifest
// (which the server imports) can name them without loading the layers.
export const VIC_LAYER_IDS = Object.freeze([
  'local-pm-warn-emergency',
  'local-pm-warn-watch',
  'local-pm-warn-advice',
  'local-pm-warn-community',
  'local-pm-weather-warning',
  'local-pm-incident',
  'local-pm-burn',
  'local-pm-flood',
  'local-pm-storm',
  'local-pm-power',
  'local-pm-roads',
  'local-vicmap-lga',
  'local-vicmap-cfa-district',
  'local-vicmap-cfa-tfb',
  'local-vicmap-delwp-region',
  'local-vicmap-emv-region',
  'local-vicmap-frv-district',
  'local-vicmap-frv-response',
  'local-vicmap-fire-station',
]);
