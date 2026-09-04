import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimeline,
  parseIncidentTime,
  responseTimelineChart,
  rowStatus,
  tickStep,
} from './responseTimeline.js';

const station = (name, sdsS, code1S) => ({
  name,
  agency: sdsS === 90 ? 'frv' : 'cfa',
  sds: { seconds: sdsS, label: `${name} standard` },
  code1S,
});

test('a row totals its standard plus its drive, and keeps them separable', () => {
  const model = buildTimeline([station('Metro', 90, 210)], { incidentMs: 0, nowMs: 0 });
  const [row] = model.rows;
  assert.equal(row.sdsS, 90);
  assert.equal(row.travelS, 210);
  assert.equal(row.totalS, 300);
});

test('an unrouted station has no total rather than a total equal to its turnout', () => {
  // The failure this guards: treating a missing drive as zero would chart the
  // brigade as arriving the instant it rolls out the door.
  const model = buildTimeline([station('No route', 480, null)], { incidentMs: 0, nowMs: 0 });
  assert.equal(model.rows[0].sdsS, 480);
  assert.equal(model.rows[0].travelS, null);
  assert.equal(model.rows[0].totalS, null);
});

test('the scale is the plan span, so an old job does not squash every bar', () => {
  const stations = [station('A', 90, 210), station('B', 480, 600)];
  const model = buildTimeline(stations, { incidentMs: 0, nowMs: 3 * 3600 * 1000 });
  assert.equal(model.scaleS, 1080, 'scale follows the longest plan, not the clock');
  assert.equal(model.elapsedClamped, true);
  assert.equal(model.elapsedS, 3 * 3600);
});

test('elapsed is null when the incident time is unusable, and no marker is claimed', () => {
  const model = buildTimeline([station('A', 90, 210)], { incidentMs: null });
  assert.equal(model.elapsedS, null);
  assert.equal(model.incidentKnown, false);
  assert.ok(!responseTimelineChart(model).includes('rt-now'));
});

test('status walks turning out, on the road, then due', () => {
  assert.equal(rowStatus(30, 90, 300), 'turning-out');
  assert.equal(rowStatus(90, 90, 300), 'on-road', 'the boundary belongs to the drive');
  assert.equal(rowStatus(200, 90, 300), 'on-road');
  assert.equal(rowStatus(300, 90, 300), 'due');
  assert.equal(rowStatus(900, 90, 300), 'due');
});

test('status is withheld, not guessed, when the plan is incomplete', () => {
  assert.equal(rowStatus(null, 90, 300), null);
  assert.equal(rowStatus(120, 90, null), null);
});

test('a station with no standard is on the road as soon as the clock runs', () => {
  // No SDS block means the turnout window is unknown, not zero-length — but
  // "on the road" is the only honest reading once time has passed and the
  // total is known.
  assert.equal(rowStatus(10, null, 300), 'on-road');
});

test('a zoned timestamp is parsed without assuming anything', () => {
  const parsed = parseIncidentTime('2026-09-01T23:56:31Z');
  assert.equal(parsed.zoned, true);
  assert.equal(parsed.ms, Date.parse('2026-09-01T23:56:31Z'));
});

test('a bare wall time is read as Melbourne, and says so', () => {
  // 1 Sep is AEST (UTC+10), so 23:56:31 local is 13:56:31Z.
  const parsed = parseIncidentTime('2026-09-01 23:56:31');
  assert.equal(parsed.zoned, false);
  assert.equal(new Date(parsed.ms).toISOString(), '2026-09-01T13:56:31.000Z');
});

test('the DST boundary is taken from the tz database, not a fixed offset', () => {
  // Melbourne moves to AEDT (UTC+11) on the first Sunday in October. A single
  // offset lookup at the wrong instant lands an hour out right about here.
  const summer = parseIncidentTime('2026-12-15 09:00:00');
  assert.equal(new Date(summer.ms).toISOString(), '2026-12-14T22:00:00.000Z');
  const winter = parseIncidentTime('2026-06-15 09:00:00');
  assert.equal(new Date(winter.ms).toISOString(), '2026-06-14T23:00:00.000Z');
});

test('an unparseable timestamp yields null rather than a wrong instant', () => {
  for (const value of ['', null, undefined, 'yesterday', 'Updated 5 min ago']) {
    assert.equal(parseIncidentTime(value), null, `${String(value)} should not parse`);
  }
});

test('tick spacing stays under nine labels at every scale', () => {
  for (const scaleS of [60, 300, 900, 1800, 3600, 7200]) {
    const step = tickStep(scaleS);
    assert.ok(scaleS / step <= 8, `${scaleS}s / ${step}s produced too many ticks`);
  }
});

test('the chart draws a section per quantity and a marker when time is known', () => {
  const model = buildTimeline([station('Metro', 90, 210)], { incidentMs: 0, nowMs: 120_000 });
  const svg = responseTimelineChart(model);
  assert.match(svg, /--rt-sds/, 'the SDS section is drawn');
  assert.match(svg, /--rt-travel/, 'the drive section is drawn');
  assert.match(svg, /rt-now/, 'the elapsed marker is drawn');
  assert.match(svg, /T\+2:00/, 'the marker is labelled with elapsed time');
});

test('the chart escapes station names rather than interpolating markup', () => {
  const hostile = { name: '<script>x</script>', sds: { seconds: 90, label: '' }, code1S: 60 };
  const svg = responseTimelineChart(buildTimeline([hostile], { incidentMs: 0, nowMs: 0 }));
  assert.ok(!svg.includes('<script>'), 'raw markup must not reach the SVG');
  assert.match(svg, /&lt;script&gt;/);
});

test('an empty station set draws nothing at all', () => {
  assert.equal(responseTimelineChart(buildTimeline([], {})), '');
  assert.equal(responseTimelineChart(null), '');
});
