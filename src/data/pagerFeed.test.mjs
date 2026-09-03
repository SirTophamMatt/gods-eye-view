import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagerFeed, normalizePage } from './pagerFeed.js';

const STATIONS = [
  { name: 'Wendouree Fire Station', latitude: -37.5401, longitude: 143.8302 },
  { name: 'Ballarat City Fire Station', latitude: -37.5622, longitude: 143.8503 },
];

/** A PagerMon message row, as its API returns one (capcodes already joined). */
function row(id, alias, message, timestamp = 1_770_000_000) {
  return {
    id, address: `12${id}`, alias, agency: 'CFA', message, source: 'rx1', timestamp,
  };
}

/** Feed wired to a scripted responder, with the interval under test control. */
function harness(pages) {
  let tick = null;
  const responses = [...pages];
  const feed = createPagerFeed({
    loadStations: async () => STATIONS,
    fetchImpl: async () => {
      const next = responses.length > 1 ? responses.shift() : responses[0];
      if (next instanceof Error) throw next;
      if (typeof next === 'number') return { ok: false, status: next };
      // Upstream returns newest first.
      return { ok: true, json: async () => [...next].reverse() };
    },
    setIntervalImpl: (fn) => { tick = fn; return 'handle'; },
    clearIntervalImpl: () => { tick = null; },
  });
  return { feed, tick: () => tick && tick() };
}

test('a message row normalises, or is refused', () => {
  assert.deepEqual(normalizePage(row(7, 'Wendouree', 'STRUCTURE FIRE')), {
    id: 7,
    address: '127',
    alias: 'Wendouree',
    agency: 'CFA',
    message: 'STRUCTURE FIRE',
    source: 'rx1',
    timestamp: 1_770_000_000,
  });

  assert.equal(normalizePage({ message: 'no id' }), null, 'an id is the dedup key');
  assert.equal(normalizePage({ id: 1, message: '', address: '' }), null, 'and it must say something');
  assert.equal(normalizePage(null), null);
  assert.equal(normalizePage({ id: 2, address: '99', message: '' }).agency, null);
});

test('the first poll loads backlog without announcing it', async () => {
  // 50 historical pages arriving as 50 map pops, for incidents possibly hours
  // old, is the worst possible first impression of the mode.
  const announced = [];
  const { feed } = harness([[row(1, 'Wendouree', 'A'), row(2, 'Ballarat City', 'B')]]);
  feed.onPages((pages) => announced.push(...pages));

  await feed.poll();

  assert.equal(announced.length, 0, 'backlog is silent');
  assert.equal(feed.getHistory().length, 2, 'but it is loaded');
  assert.equal(feed.getStatus().live, true);
});

test('only genuinely new pages are announced, however often it polls', async () => {
  const announced = [];
  const first = [row(1, 'Wendouree', 'A')];
  const second = [row(1, 'Wendouree', 'A'), row(2, 'Ballarat City', 'B')];
  const { feed } = harness([first, second]);
  feed.onPages((pages) => announced.push(...pages));

  await feed.poll(); // primes
  await feed.poll(); // sees 1 again, plus 2
  assert.deepEqual(announced.map((p) => p.id), [2], 'the repeat is not re-announced');

  await feed.poll(); // same window again
  assert.deepEqual(announced.map((p) => p.id), [2], 'and still is not');
  assert.deepEqual(feed.getHistory().map((p) => p.id), [2, 1], 'newest first');
});

test('a page carries the station it resolved to, or admits it did not', async () => {
  const { feed } = harness([[
    row(1, 'Wendouree', 'STRUCTURE FIRE'),
    row(2, 'Nowhere Creek', 'GRASS FIRE'),
  ]]);
  await feed.poll();

  const [nowhere, wendouree] = feed.getHistory();
  assert.equal(wendouree.station.name, 'Wendouree Fire Station');
  assert.equal(wendouree.resolution, 'matched');
  assert.equal(nowhere.station, null, 'an unresolvable brigade still reaches the ticker');
  assert.equal(nowhere.resolution, 'unknown');
  assert.equal(feed.getStatus().unresolved, 1, 'and is counted, not hidden');
});

test('an unconfigured instance is a state, not a fault', async () => {
  const { feed } = harness([503]);
  await feed.poll();
  assert.equal(feed.getStatus().live, false);
  assert.equal(feed.getStatus().error, 'not_configured');
});

test('an unreachable instance reports itself and keeps its history', async () => {
  const { feed } = harness([[row(1, 'Wendouree', 'A')], new Error('socket hang up')]);
  await feed.poll();
  assert.equal(feed.getHistory().length, 1);

  await feed.poll();
  assert.equal(feed.getStatus().live, false);
  assert.match(feed.getStatus().error, /socket hang up/);
  assert.equal(feed.getHistory().length, 1, 'a failed poll does not erase what we had');
});

test('history stays bounded over a long session', async () => {
  let next = 0;
  const feed = createPagerFeed({
    loadStations: async () => STATIONS,
    fetchImpl: async () => {
      next += 1;
      return { ok: true, json: async () => [row(next, 'Wendouree', `page ${next}`)] };
    },
  });
  for (let i = 0; i < 200; i += 1) await feed.poll();

  const history = feed.getHistory();
  assert.ok(history.length <= 60, `history grew to ${history.length}`);
  assert.equal(history[0].id, 200, 'and keeps the newest');
});

test('a throwing subscriber cannot take the feed down with it', async () => {
  const seen = [];
  const { feed } = harness([[row(1, 'Wendouree', 'A')], [row(1, 'Wendouree', 'A'), row(2, 'Wendouree', 'B')]]);
  feed.onPages(() => { throw new Error('bad listener'); });
  feed.onPages((pages) => seen.push(...pages));

  await feed.poll();
  await feed.poll();
  assert.deepEqual(seen.map((p) => p.id), [2], 'the good subscriber still hears it');
});

test('start is idempotent and stop halts polling', () => {
  const { feed, tick } = harness([[row(1, 'Wendouree', 'A')]]);
  feed.start();
  feed.start();
  assert.equal(feed.isRunning(), true);
  feed.stop();
  assert.equal(feed.isRunning(), false);
  assert.equal(tick(), null, 'the interval handle was released');
});

test('skipInitialPoll lets a caller prime the backlog itself without a race', async () => {
  // pagerMode.js awaits one poll() itself (to settle "Connecting…" before
  // starting the recurring loop) and then calls start(). Without this option,
  // start()'s own immediate poll would run concurrently with that awaited
  // one — the priming poll announces nothing by design, so the race could
  // resolve with the FIRST real batch never reaching a subscriber at all.
  let calls = 0;
  const feed = createPagerFeed({
    loadStations: async () => STATIONS,
    fetchImpl: async () => { calls += 1; return { ok: true, json: async () => [] }; },
  });
  await feed.poll(); // the caller's own priming poll
  assert.equal(calls, 1);

  feed.start({ skipInitialPoll: true });
  assert.equal(calls, 1, 'start() must not poll again when told to skip it');
  feed.stop();
});

test('a plain start() still polls immediately, unchanged for every existing caller', async () => {
  let calls = 0;
  const feed = createPagerFeed({
    loadStations: async () => STATIONS,
    fetchImpl: async () => { calls += 1; return { ok: true, json: async () => [] }; },
  });
  feed.start();
  await new Promise((resolve) => { setTimeout(resolve, 0); }); // let the fire-and-forget poll() settle
  assert.equal(calls, 1, 'the default behaviour is unchanged');
  feed.stop();
});
