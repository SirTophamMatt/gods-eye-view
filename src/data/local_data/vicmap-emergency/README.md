# Vicmap fire stations

`vicmap-fire-station.geojsonl` — 1,726 CFA and FRV fire stations in Victoria, essentially
the whole public station network.

Two consumers, one file:

- the `local-vicmap-fire-station` layer (`src/data/localLayers.js`), drawn as points
- the detail panel's **Nearest brigades** action (`src/data/fireStationLookup.js`), which
  fetches this file independently of whether the layer is switched on

## What this is not

A station is a building, not a dispatch. Victoria turns out brigades by response area and
turnout agreement — which is what the `vicmap-admin/` CFA district and FRV response area
boundaries encode — **not** by proximity. Anything built on this answers "what is near
this fire". It does not answer "who is coming", and no UI on top of it should imply
otherwise.

## Provenance

- **Source:** [Vicmap Features of Interest](https://discover.data.vic.gov.au/dataset/vicmap-features-of-interest-rest-api),
  State of Victoria (Department of Energy, Environment and Climate Action)
- **Endpoint:** `https://services-ap1.arcgis.com/P744lA0wf4LlBZ84/arcgis/rest/services/Vicmap_Features_of_Interest/FeatureServer`,
  layer 1 (`FOI_POINT`), filtered to `feature_subtype = 'fire station'`
- **License:** **CC BY 4.0** — attribution is a condition of use, carried in `DATA_CREDITS`
  (`src/data/dataCredits.js`). Do not remove it.
- **Retrieved:** 2026-09-03

The filter is deliberately narrow. The subtype vocabulary also holds `fire lookout` (an
unstaffed tower) and `fire station (forest industry)` (private plantation depots); neither
is a brigade, and including them would make a "nearest station" answer quietly wrong in
the bush, which is where it matters most.

## Regenerating

```bash
node scripts/export-vicmap-emergency.mjs
```

Transport is shared with the boundary exporter via `scripts/lib/vicmap-arcgis.mjs`. The
exporter drops placeholder rows (`FIRE SERVICES INFRASTRUCTURE - …`, an administrative
marker rather than a building) and any record without geometry — one row on the last run.
