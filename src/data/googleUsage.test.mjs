import test from 'node:test';
import assert from 'node:assert/strict';
import {
  USAGE_STORAGE_KEY,
  createUsageCounter,
  formatCount,
  formatUsageLine,
  pruneUsage,
  quotaDayKey,
  readUsage,
  usageTooltip,
} from './googleUsage.js';
import { classifyResource } from './googleUsageMeter.js';

/** Minimal Storage stand-in. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _raw: () => map,
  };
}

test('the quota day is Pacific, matching where Google resets it', () => {
  // 2026-09-05 06:00 UTC is still 2026-09-04 in Los Angeles (UTC-7 in
  // September). Keying by UTC — or by Melbourne — would put this request on the
  // wrong side of the boundary from the console it is compared against.
  const at = Date.parse('2026-09-05T06:00:00Z');
  assert.equal(quotaDayKey(at), '2026-09-04');
  assert.equal(quotaDayKey(at, 'UTC'), '2026-09-05');
  assert.equal(quotaDayKey(at, 'Australia/Melbourne'), '2026-09-05');
});

test('counts accumulate per surface on the current quota day', () => {
  const storage = fakeStorage();
  let now = Date.parse('2026-09-05T20:00:00Z'); // 13:00 Pacific, 2026-09-05
  const counter = createUsageCounter({ storage, now: () => now });

  counter.record('tiles', 120);
  counter.record('tiles', 30);
  counter.record('places');

  assert.deepEqual(counter.today(), { day: '2026-09-05', tiles: 150, places: 1 });
});

test('a new quota day starts from zero without losing the old one', () => {
  const storage = fakeStorage();
  let now = Date.parse('2026-09-05T20:00:00Z');
  const counter = createUsageCounter({ storage, now: () => now });
  counter.record('tiles', 500);

  now = Date.parse('2026-09-06T20:00:00Z');
  assert.deepEqual(counter.today(), { day: '2026-09-06', tiles: 0, places: 0 });
  counter.record('tiles', 7);
  assert.equal(counter.all()['2026-09-05'].tiles, 500, 'yesterday is retained');
  assert.equal(counter.all()['2026-09-06'].tiles, 7);
});

test('only the last seven days are kept', () => {
  const storage = fakeStorage();
  let now = Date.parse('2026-09-01T20:00:00Z');
  const counter = createUsageCounter({ storage, now: () => now });
  for (let i = 0; i < 12; i += 1) {
    counter.record('tiles', 1);
    now += 24 * 3600 * 1000;
  }
  const days = Object.keys(counter.all()).sort();
  assert.equal(days.length, 7, 'the tally cannot grow without bound');
  assert.equal(days[days.length - 1], '2026-09-12');
});

test('an unknown surface and a nonsense count are ignored, not recorded', () => {
  const storage = fakeStorage();
  const counter = createUsageCounter({ storage, now: () => Date.parse('2026-09-05T20:00:00Z') });
  counter.record('geocoding', 10);
  counter.record('tiles', -5);
  counter.record('tiles', Number.NaN);
  counter.record('tiles', 'lots');
  assert.deepEqual(counter.today(), { day: '2026-09-05', tiles: 0, places: 0 });
});

test('a corrupt or hostile stored value resets rather than throwing', () => {
  // A readout losing a day's count is a far smaller failure than a HUD that
  // will not render.
  for (const raw of ['not json', '[]', 'null', '{"2026-09-05":"nope"}', '{"junk":{"tiles":5}}']) {
    const storage = fakeStorage({ [USAGE_STORAGE_KEY]: raw });
    assert.doesNotThrow(() => readUsage(storage));
    const counter = createUsageCounter({ storage, now: () => Date.parse('2026-09-05T20:00:00Z') });
    assert.equal(counter.today().tiles, 0);
  }
});

test('a storage that throws still counts, it just cannot remember', () => {
  // Private windows throw on localStorage access. The count is held in memory
  // regardless, so the session's own figure stays right — it simply does not
  // survive a reload. Degrading to "no number at all" would be worse.
  const hostile = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  const counter = createUsageCounter({ storage: hostile, now: () => Date.parse('2026-09-05T20:00:00Z') });
  assert.doesNotThrow(() => counter.record('tiles', 5));
  assert.equal(counter.today().tiles, 5, 'this session still counts');

  const fresh = createUsageCounter({ storage: hostile, now: () => Date.parse('2026-09-05T20:00:00Z') });
  assert.equal(fresh.today().tiles, 0, 'but nothing was persisted');
});

test('pruning never mutates its input', () => {
  const usage = { '2026-09-01': { tiles: 1 }, '2026-09-02': { tiles: 2 } };
  const out = pruneUsage(usage);
  out['2026-09-03'] = { tiles: 3 };
  assert.equal(Object.keys(usage).length, 2);
});

test('resources are classified by which surface bills for them', () => {
  assert.equal(classifyResource('https://tile.googleapis.com/v1/3dtiles/root.json?key=x'), 'tiles');
  assert.equal(classifyResource('https://tile.googleapis.com/v1/3dtiles/datasets/CgIYAQ/files/abc'), 'tiles');
  assert.equal(classifyResource('http://localhost:5173/api/google/nearby-places?lat=1&lon=2'), 'places');
  // Fonts are Google, and are free. Counting them would inflate the figure
  // people are using to judge a bill.
  assert.equal(classifyResource('https://fonts.googleapis.com/css2?family=Inter'), null);
  assert.equal(classifyResource('https://api.openai.com/v1/realtime'), null);
  assert.equal(classifyResource(''), null);
  assert.equal(classifyResource(null), null);
});

test('big counts abbreviate, small ones stay exact', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(812), '812');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1000), '1.0k');
  assert.equal(formatCount(12_400), '12k');
  assert.equal(formatCount(1_250_000), '1.3M');
  assert.equal(formatCount(-5), '0');
  assert.equal(formatCount('nonsense'), '0');
});

test('the readout says TODAY, and the tooltip says what it cannot see', () => {
  const line = formatUsageLine({ tiles: 12_400, places: 18 });
  assert.equal(line, 'MAPS: 12k TILES · 18 PLACES');

  const tip = usageTooltip({ day: '2026-09-05' });
  assert.match(tip, /THIS BROWSER/, 'the scope is stated');
  assert.match(tip, /Not your account total/, 'and what it is not');
  assert.match(tip, /quota cap/, 'and where a real limit is set');
});
