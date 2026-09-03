import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FLOOD_BANDS,
  floodBand,
  floodGaugeChart,
  floodLevels,
  floodScaleMax,
} from './floodGauge.js';

const SNAPSHOT = fileURLToPath(
  new URL('./local_data/passive-monitor/pm-flood.geojsonl', import.meta.url),
);

/** The real shape of a gauge at Minor in the committed snapshot. */
const AVOCA = {
  name: 'Avoca River at Charlton Town',
  hazard: 'flood',
  severity: 1,
  status: 'Minor',
  detail: '4.07 m · steady · Avoca Catchment · minor 4 / mod 5.9 / maj 7.5',
  heightM: 4.07,
};

test('levels come from structured fields first, the detail string second', () => {
  // The committed snapshot has thresholds only inside the composed line.
  assert.deepEqual(floodLevels(AVOCA), {
    heightM: 4.07, minorM: 4, moderateM: 5.9, majorM: 7.5, trend: 'steady',
  });

  // A re-export supplies them structurally, and those win — including where
  // the two disagree, which is what makes this a preference and not a merge.
  assert.deepEqual(
    floodLevels({ ...AVOCA, minorM: 4.2, moderateM: 6, majorM: 8, tendency: 'RISING' }),
    { heightM: 4.07, minorM: 4.2, moderateM: 6, majorM: 8, trend: 'rising' },
  );

  const bare = floodLevels({ heightM: 0.51, detail: '0.51 m · steady · Thomson Catchment' });
  assert.equal(bare.minorM, null, 'no thresholds in the line means no thresholds');
  assert.equal(bare.trend, 'steady');
});

test('bands classify against whichever thresholds exist', () => {
  const levels = floodLevels(AVOCA);
  assert.equal(floodBand(3.9, levels).key, 'below');
  assert.equal(floodBand(4.07, levels).key, 'minor', 'at the threshold is IN the band');
  assert.equal(floodBand(6.0, levels).key, 'moderate');
  assert.equal(floodBand(9.9, levels).key, 'major');
  assert.equal(floodBand(null, levels), null);

  // A gauge with only a minor level still classifies against it.
  assert.equal(floodBand(5, { minorM: 4 }).key, 'minor');
  assert.equal(floodBand(3, { minorM: 4 }).key, 'below');
  assert.equal(FLOOD_BANDS.length, 4);
});

test('the scale leaves headroom above a gauge that is over major', () => {
  const levels = floodLevels(AVOCA);
  // Below major: the scale is set by major, so the marker sits inside.
  assert.ok(floodScaleMax(4.07, levels) > 7.5);
  // Above major: the scale grows with the reading rather than clipping it —
  // which is precisely when a reader needs to see how far past it has gone.
  const extreme = floodScaleMax(12, levels);
  assert.ok(extreme > 12, `expected headroom above 12, got ${extreme}`);
});

test('a gauge with no thresholds gets no chart', () => {
  // 204 of the 319 committed gauges are in this state. Drawing from a height
  // alone derives the scale from that same height, planting the marker near
  // the right-hand end of the track and making an ordinary river look like it
  // is about to break its banks.
  assert.equal(
    floodGaugeChart({ heightM: 0.51, detail: '0.51 m · steady · Thomson Catchment' }),
    '',
  );
  assert.equal(floodGaugeChart({}), '');
  assert.equal(floodGaugeChart(null), '');
});

test('the chart draws bands, ticks and a marker for a real gauge', () => {
  const svg = floodGaugeChart(AVOCA);
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="0 0 300 74"/);
  assert.match(svg, /role="img"/, 'the chart is announced to assistive tech');
  assert.match(svg, /aria-label="[^"]+"/);

  // Every threshold gets a labelled tick.
  for (const label of ['Minor 4', 'Mod 5.9', 'Maj 7.5']) {
    assert.ok(svg.includes(label), `${label} tick is drawn`);
  }
  // The reading is shown with its trend, in the colour of its band.
  assert.ok(svg.includes('4.07 m steady'));
  assert.ok(svg.includes(FLOOD_BANDS[1].color), 'marker takes the Minor colour');
  assert.ok(svg.includes(FLOOD_BANDS[0].color), 'and the below-flood band is drawn');
});

test('gauge text is escaped, never interpolated as markup', () => {
  // Trend arrives from an upstream feed, so it is treated as data like every
  // other external string in the panel.
  const svg = floodGaugeChart({ heightM: 4, minorM: 3, tendency: '"><script>x</script>' });
  assert.ok(!svg.includes('<script>'), 'no raw tag survives');
  assert.ok(svg.includes('&lt;script&gt;') || !svg.includes('script>'), 'it is inert');
});

test('every committed gauge either charts cleanly or not at all', () => {
  const gauges = readFileSync(SNAPSHOT, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line).properties);
  assert.ok(gauges.length > 300, 'the snapshot is loaded');

  let charted = 0;
  for (const props of gauges) {
    const svg = floodGaugeChart(props);
    if (svg === '') continue;
    charted += 1;
    // A chart that renders must be well-formed and finite: an NaN coordinate
    // silently collapses an SVG element rather than throwing.
    assert.ok(svg.startsWith('<svg ') && svg.endsWith('</svg>'), props.name);
    assert.ok(!/NaN|Infinity|undefined|null/.test(svg), `${props.name} has a bad coordinate`);
  }
  assert.ok(charted > 100, `expected the threshold-carrying gauges to chart, got ${charted}`);
  assert.ok(charted < gauges.length, 'and the ones without thresholds to abstain');
});
