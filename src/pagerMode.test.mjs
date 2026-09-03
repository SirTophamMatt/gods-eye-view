import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _setPagerAnnotationsForTest,
  dropPins,
  pagerClock,
  pagerRowHtml,
  pagerTickerHtml,
} from './pagerMode.js';

test.afterEach(() => _setPagerAnnotationsForTest());

test('the clock reads a PagerMon epoch-seconds timestamp in local time', () => {
  // 2026-01-15 03:04:00 UTC — the exact zone doesn't matter for the assertion,
  // only that seconds (not ms) produce a real Date and ms don't get treated
  // as seconds (which would land 1000x in the future and fail to format).
  const seconds = Math.floor(Date.UTC(2026, 0, 15, 3, 4, 0) / 1000);
  const clock = pagerClock(seconds);
  assert.match(clock, /^\d{2}:\d{2}$/, `expected HH:MM, got "${clock}"`);
});

test('an unusable timestamp reads as a dash, never a wrong time', () => {
  assert.equal(pagerClock(null), '--:--');
  assert.equal(pagerClock(undefined), '--:--');
  assert.equal(pagerClock(0), '--:--');
  assert.equal(pagerClock(-5), '--:--');
  assert.equal(pagerClock(NaN), '--:--');
  assert.equal(pagerClock('not a number'), '--:--');
});

test('a resolved page renders its station name, unmarked', () => {
  const html = pagerRowHtml({
    address: '1201',
    alias: 'Wendouree',
    message: 'STRUCTURE FIRE - 12 Smith St',
    timestamp: null,
    station: { name: 'Wendouree Fire Station', latitude: -37.54, longitude: 143.83 },
  });
  assert.ok(html.includes('Wendouree Fire Station'));
  assert.ok(html.includes('STRUCTURE FIRE - 12 Smith St'));
  assert.ok(!html.includes('pager-row-unresolved'), 'a placed page is not flagged');
  assert.ok(!html.includes('pager-row-unplaced'));
});

test('an unresolved page is marked, never silently hidden', () => {
  // Dropping it would make a gap in the gazetteer look like a quiet night.
  const html = pagerRowHtml({
    address: '1999',
    alias: 'Nowhere Creek',
    message: 'GRASS FIRE',
    timestamp: null,
    station: null,
  });
  assert.ok(html.includes('Nowhere Creek'), 'the alias is shown even with no station');
  assert.ok(html.includes('pager-row-unresolved'));
  assert.ok(html.includes('pager-row-unplaced'));
});

test('a page with no alias falls back to naming the capcode', () => {
  const html = pagerRowHtml({
    address: '7788', alias: '', message: 'TEST', timestamp: null, station: null,
  });
  assert.ok(html.includes('Capcode 7788'), 'a bare address is still identifiable');
});

test('row text is escaped, never interpolated as markup', () => {
  const html = pagerRowHtml({
    address: '1',
    alias: '<img src=x onerror=alert(1)>',
    message: '<script>alert(2)</script>',
    timestamp: null,
    station: null,
  });
  assert.ok(!html.includes('<img'), 'no raw tag from the alias');
  assert.ok(!html.includes('<script>'), 'no raw tag from the message');
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('the ticker states plainly when no instance is configured', () => {
  const html = pagerTickerHtml({ live: false, error: 'not_configured', unresolved: 0 }, []);
  assert.match(html, /No PagerMon instance configured/);
  assert.ok(!html.includes('pager-dot-live'));
});

test('the ticker distinguishes connecting from listening-with-nothing-yet', () => {
  const connecting = pagerTickerHtml({ live: false, error: null, unresolved: 0 }, []);
  assert.match(connecting, /Connecting/);

  const listening = pagerTickerHtml({ live: true, error: null, unresolved: 0 }, []);
  assert.match(listening, /Listening — no pages yet/);
  assert.ok(listening.includes('pager-dot-live'));
});

test('the unplaced count is only shown when it is nonzero', () => {
  const clean = pagerTickerHtml({ live: true, error: null, unresolved: 0 }, []);
  assert.ok(!clean.includes('pager-head-warn'));

  const dirty = pagerTickerHtml({ live: true, error: null, unresolved: 3 }, []);
  assert.ok(dirty.includes('pager-head-warn'));
  assert.ok(dirty.includes('3 unplaced'));
});

test('the ticker renders every row it is given, in order', () => {
  const pages = [
    { address: '1', alias: 'Wendouree', message: 'A', timestamp: null, station: { name: 'Wendouree Fire Station' } },
    { address: '2', alias: 'Ballarat City', message: 'B', timestamp: null, station: { name: 'Ballarat City Fire Station' } },
  ];
  const html = pagerTickerHtml({ live: true, error: null, unresolved: 0 }, pages);
  const first = html.indexOf('Wendouree Fire Station');
  const second = html.indexOf('Ballarat City Fire Station');
  assert.ok(first > -1 && second > -1 && first < second, 'newest-first order is preserved as given');
});

test('dropPins does nothing without an annotation engine', () => {
  _setPagerAnnotationsForTest(() => null);
  // Must not throw even though there is nothing to call.
  assert.doesNotThrow(() => dropPins([
    { station: { name: 'A', latitude: -37, longitude: 144 }, timestamp: null },
  ]));
});

test('dropPins places only pages that resolved to a station', () => {
  const calls = [];
  _setPagerAnnotationsForTest(() => ({ annotate: (specs, opts) => calls.push({ specs, opts }) }));

  dropPins([
    { station: { name: 'Wendouree Fire Station', latitude: -37.54, longitude: 143.83 }, timestamp: null },
    { station: null, alias: 'Nowhere Creek', timestamp: null },
  ]);

  assert.equal(calls.length, 1, 'one batched annotate call');
  assert.equal(calls[0].specs.length, 1, 'the unresolved page is not placed');
  assert.equal(calls[0].specs[0].type, 'pin');
  assert.equal(calls[0].specs[0].color, 'amber');
  assert.equal(calls[0].specs[0].latitude, -37.54);
  assert.ok(calls[0].specs[0].label.includes('Wendouree Fire Station'));
  assert.equal(calls[0].opts.persist, false, 'a page pin must expire — it is an event, not a place');
});

test('dropPins never calls annotate for an all-unresolved batch', () => {
  const calls = [];
  _setPagerAnnotationsForTest(() => ({ annotate: (...args) => calls.push(args) }));
  dropPins([{ station: null }, { station: null }]);
  assert.equal(calls.length, 0, 'nothing to place means no call at all');
});

test('dropPins caps a batch rather than carpeting the map', () => {
  const calls = [];
  _setPagerAnnotationsForTest(() => ({ annotate: (specs) => calls.push(specs) }));
  const pages = Array.from({ length: 10 }, (_, i) => ({
    station: { name: `Station ${i}`, latitude: -37, longitude: 144 + i },
    timestamp: null,
  }));
  dropPins(pages);
  assert.ok(calls[0].length <= 6, `expected a capped batch, got ${calls[0].length}`);
});

test('a throwing annotation engine does not propagate — the ticker still has the page', () => {
  _setPagerAnnotationsForTest(() => ({ annotate: () => { throw new Error('boom'); } }));
  assert.doesNotThrow(() => dropPins([
    { station: { name: 'A', latitude: -37, longitude: 144 }, timestamp: null },
  ]));
});
