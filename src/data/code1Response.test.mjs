import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SPEED_KMH,
  SPEED_UPLIFT,
  code1Duration,
  formatMinutes,
} from './code1Response.js';

const KMH = 1 / 3.6;

test('the uplift is applied per segment, so a cap bites only where it should', () => {
  // 1 km at 100 km/h then 1 km at 40 km/h. Uplifted: 120 → capped to 110, and
  // 48 uncapped. Doing this on the ROUTE AVERAGE instead would uplift ~57 km/h
  // to 69 and never reach the cap at all, which is the whole reason the proxy
  // now returns per-segment annotations.
  const route = {
    distanceM: 2000,
    durationS: (1000 / (100 * KMH)) + (1000 / (40 * KMH)),
    annotation: {
      distance: [1000, 1000],
      duration: [1000 / (100 * KMH), 1000 / (40 * KMH)],
      speed: [100 * KMH, 40 * KMH],
    },
  };

  const result = code1Duration(route);
  assert.equal(result.basis, 'segments');

  const expected = (1000 / (MAX_SPEED_KMH * KMH)) + (1000 / (40 * SPEED_UPLIFT * KMH));
  assert.ok(
    Math.abs(result.durationS - expected) < 0.01,
    `expected ${expected.toFixed(2)}s, got ${result.durationS.toFixed(2)}s`,
  );
  assert.ok(result.durationS < route.durationS, 'a priority run is never slower');
});

test('the cap holds no matter how fast the segment was', () => {
  const route = {
    distanceM: 10000,
    durationS: 10000 / (150 * KMH),
    annotation: {
      distance: [10000],
      duration: [10000 / (150 * KMH)],
      speed: [150 * KMH], // already over the cap before any uplift
    },
  };
  const result = code1Duration(route);
  const atCap = 10000 / (MAX_SPEED_KMH * KMH);
  assert.ok(Math.abs(result.durationS - atCap) < 0.01, 'never faster than the ceiling');
  assert.ok(result.durationS > route.durationS, 'and slower than a 150 km/h route really was');
});

test('a stopped segment keeps its own duration instead of vanishing', () => {
  // OSRM reports 0 m/s where it modelled a stop. Dividing by the uplifted zero
  // would be Infinity; dropping the segment would make the route look free.
  const route = {
    distanceM: 100,
    durationS: 40,
    annotation: { distance: [0, 100], duration: [30, 10], speed: [0, 10] },
  };
  const result = code1Duration(route);
  assert.ok(Number.isFinite(result.durationS));
  assert.ok(result.durationS > 0 && result.durationS < 40);
});

test('without annotations it falls back to the route average and says so', () => {
  const route = { distanceM: 6000, durationS: 600 }; // 36 km/h average
  const result = code1Duration(route);
  assert.equal(result.basis, 'average', 'the caller can tell which method ran');
  const expected = 6000 / (36 * SPEED_UPLIFT * KMH);
  assert.ok(Math.abs(result.durationS - expected) < 0.01);
});

test('a route with no usable timing yields null rather than a fabricated number', () => {
  assert.equal(code1Duration(null), null);
  assert.equal(code1Duration({}), null);
  assert.equal(code1Duration({ distanceM: 100, durationS: 0 }), null);
  // Mismatched annotation arrays fall through to the average path, not a crash.
  assert.equal(code1Duration({ annotation: { speed: [10], distance: [] } }), null);
});

test('minutes never round down to zero', () => {
  // "0 min" reads as a broken value; a 20-second run is "1 min".
  assert.equal(formatMinutes(20), '1 min');
  assert.equal(formatMinutes(200), '3 min');
  assert.equal(formatMinutes(0), '1 min');
  assert.equal(formatMinutes(NaN), '');
  assert.equal(formatMinutes(-5), '');
});
