# Vicmap Admin boundaries

Administrative boundaries for Victoria, Australia — the reference geometry the Passive
Monitor hazard layers are implicitly issued against.

| File | Vicmap layer | Source features | Parts written |
|------|--------------|-----------------|---------------|
| `vicmap-lga.geojsonl` | `LGA_POLYGON` (9) | 87 | 92 |
| `vicmap-cfa-district.geojsonl` | `CFA_DISTRICT` (3) | 21 | 35 |
| `vicmap-cfa-tfb.geojsonl` | `CFA_TFB_DISTRICT` (1) | 9 | 12 |
| `vicmap-delwp-region.geojsonl` | `DELWP_REGION` (0) | 6 | 13 |
| `vicmap-emv-region.geojsonl` | `EMERGENCY_MANAGEMENT_REGION` (4) | 8 | 8 |
| `vicmap-frv-district.geojsonl` | `FRV_DISTRICT` (6) | 11 | 39 |
| `vicmap-frv-response.geojsonl` | `FRV_RESPONSE_AREA` (8) | 1 | 22 |

"Parts" exceeds "features" because multipart regions are split into one Polygon per part —
see the exporter header for why.

## Provenance

- **Source:** [Vicmap Admin REST API](https://discover.data.vic.gov.au/dataset/vicmap-admin-rest-api),
  State of Victoria (Department of Energy, Environment and Climate Action)
- **Endpoint:** `https://services-ap1.arcgis.com/P744lA0wf4LlBZ84/arcgis/rest/services/Vicmap_Admin/FeatureServer`
- **License:** **CC BY 4.0** — attribution is a condition of use, and is carried in
  `DATA_CREDITS` (`src/data/dataCredits.js`), which surfaces it in the app's
  "Data attribution" popover. Do not remove it.
- **Retrieved:** 2026-09-03. Upstream refreshes weekly, but the geometry itself changes on
  the order of once a year.

## Regenerating

```bash
node scripts/export-vicmap-admin.mjs
```

Options: `--tolerance <degrees>` to change the server-side generalisation (default `0.001`,
~110 m), `--only lga,cfa-tfb` to refresh a subset. The full transform — attribute mapping,
coordinate rounding, multipart splitting, label priority — is documented in that script's
header, which is the authoritative description of what these files contain.

Layer registration lives in `src/data/localLayers.js` (all seven use `outlineOnly: true`)
and `src/data/layerState.js` (share-link tokens `3`–`9`).
