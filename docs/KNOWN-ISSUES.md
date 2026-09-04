# KNOWN ISSUES

Updated: September 5, 2026

This file tracks active runtime issues only.

This file records current known issues; historical planning material is not part
of the public release.

---

## Open

### Street traffic can be slow/uneven when panning across dense city blocks
Status: Open (partially mitigated)

Context:
- Current traffic loader fetches one clamped viewport tile at a time (major pass, then full pass).
- In dense cores, some visible roads can appear late after city jumps or fast pans.
- Zooming into adjacent streets does not always immediately trigger higher-detail coverage for all visible roads.

Current mitigation in runtime:
- Fair per-road dot budget allocation (reduces hard starvation under global `MAX_DOTS` cap).
- Center-shift threshold (reduces stale overlap lock while panning).

Next iteration candidates:
- Prioritize currently visible road segments inside the active viewport before off-center segments.
- Add neighbor prefetch ring for nearby tiles after jump-to-city actions.
- Add adaptive dot cap by frame time (coverage first, density second).
- Promote sync chip from loading indicator to true multi-phase progress.

---

### CCTV panel can appear "missing" after layout refactors
Status: Open (workaround available)

Context:
- Panel positions are persisted in local storage and can restore off-screen after UI changes.

Workaround:
- In browser console:
  - `localStorage.removeItem('godsEyeView.v6.panelPos.cctv-panel');`
  - `localStorage.removeItem('godsEyeView.v6.panelCollapsed.cctv-panel');`
  - `location.reload();`

Related keys (current versions):
- Panel positions: `godsEyeView.v7.panelPos.<panel-id>` (re-versioned 2026-06-10)
- Panel collapsed state: `godsEyeView.v6.panelCollapsed.<panel-id>`
- CCTV calibration: `godsEyeView.cctv.calibration.v2`

---

### Height-datum residuals
Status: Open (accepted 2026-07-08, documented)

- **Cold-start floor latency:** at a freshly-visited airport, grounded/low aircraft
  float low for ~1–2 poll cycles (30–60 s) and rise as terrain floors resolve;
  a few stragglers take one more poll.
- **Born-grounded first poll:** a contact first seen on the ground with no altitude
  data renders at the geoid for ≤1 poll until its floor cell warms.
- Full context, improvement ideas, and the verification oracle
  (`scripts/qa-floor-verify.mjs`):
  the height-datum section in `docs/CURRENT-STATE.md`.

### GARS alarm levels are an estimated ramp, not the real response cards
Status: Open (needs source material — operator research)

The response-size control on an FRV-area incident offers GARS alarm levels 1st
through 5th. Only two cells of that table could be sourced publicly:

- **3rd Alarm, structure** — 9 primary appliances, plus a ladder platform, BA
  support, commanders and an assistant chief fire officer. *(FRV published)*
- **1st Alarm, non-structure** — 2 primary appliances. *(FRV published; recorded
  in the module header, not currently offered as its own menu option.)*

Everything else in `GARS_APPLIANCES` (`src/data/responsePlan.js`) is this app's
own even ramp — 3/6/9/12/15, three appliances per alarm — chosen only because it
passes through the one published structure figure. Those levels are flagged
`sourced: false`, shown as "(est.)" in the menu, and carry "estimated, not an FRV
published figure" in their note. Nothing asserts them as fact.

Why it is still worth fixing: the whole point of the FRV branch is to answer
"roughly where does the first strike team come from", and a wrong appliance count
walks the station list to the wrong depth. The CFA side has no equivalent problem
— a Make Tankers 15 carries its own number.

To close it:

- Obtain the real GARS response cards (structure and non-structure, 1st–5th).
- Replace `GARS_APPLIANCES` and set `sourced: true` on each level that now has a
  real figure. The "(est.)" suffix and the note wording both key off that flag,
  so the UI follows automatically.
- Update the `responsePlan.js` header, which currently says in as many words that
  the ramp is a placeholder for these cards.
- `src/data/responsePlan.test.mjs` asserts that `gars3` is the only sourced level
  and that the ramp is even. Both are meant to be rewritten when the real table
  lands, not worked around.

If the cards turn out not to be releasable, the honest close is to keep the
estimate and keep saying so — not to reconstruct them from incident photos or
radio traffic.

---

## Closed / Intentional (for clarity)

### Proxy SSRF and error-surface hardening gaps
Status: Closed as fixed on `main`

Context:
- Proxy middleware previously allowed broader error/internal surface area and looser upstream handling.
- Current `main` includes hardened proxy behavior in `vite.config.js`:
  - CCTV upstream URL no longer accepted from client query params.
  - Error payloads are sanitized.
  - OpenSky cache stores successful responses only.
  - OpenSky token refresh is coalesced.
  - GBFS/CCTV memory growth is bounded.

Validation target:
- `vite.config.js`

---

### NVG vignette edge color bleed
Status: Closed as fixed in current shader composite

Context:
- Earlier builds leaked original scene colors near the NVG tube edge.
- Current composite now masks NVG output with tube falloff before final blend, removing the color edge bleed.

Validation target:
- `src/styles/surveillance.js`

---

### Wildfires layer unavailable / static bundled snapshot
Status: Closed — live FIRMS integration shipped (2026-07-16)

Context:
- Wildfires (NASA FIRMS) were removed from runtime in v0.5.3, returned June 2026 as a
  bundled-snapshot layer (`local-firms`, 2026-05-25 data, ~58 MB in-repo), and were
  converted to **live NASA FIRMS data** on 2026-07-16: the `/api/firms` proxy merges
  three VIIRS NRT sources (trailing 24 h, 30 min cache, serve-stale-on-failure) and the
  bundled snapshot was deleted. Requires a free server-side `FIRMS_MAP_KEY`; without it
  the layer shows a KEY REQUIRED state.
- Weather radar is still held out of OSS v1 after QA found the previous overlay did not provide reliable visible value.
