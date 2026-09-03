import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildStationIndex,
  normalizeName,
  resolveCapcode,
  resolveCapcodes,
  stationKeys,
} from './capcodeStations.js';
import { parseStations } from './nearestStations.js';

const SNAPSHOT = fileURLToPath(
  new URL('./local_data/vicmap-emergency/vicmap-fire-station.geojsonl', import.meta.url),
);

function victorianStations() {
  return parseStations(readFileSync(SNAPSHOT, 'utf8')).filter((s) => s.state === 'VIC');
}

test('normalisation folds every plausible way an operator writes a brigade', () => {
  // These are the same brigade. If they do not all collapse to one key, the
  // join depends on how the PagerMon operator happened to type it.
  const same = [
    'Wendouree Fire Station',
    'WENDOUREE',
    'CFA Wendouree',
    'wendouree fs',
    'WENDOUREE BRIGADE',
    'Wendouree  Fire  Station ',
  ];
  for (const form of same) {
    assert.equal(normalizeName(form), 'WENDOUREE', `"${form}" should fold to WENDOUREE`);
  }

  assert.equal(normalizeName('Mt Beauty Fire Station'), 'MOUNT BEAUTY', 'Mt expands');
  assert.equal(normalizeName('Napoleons-Enfield Fire Station'), 'NAPOLEONS ENFIELD');
  // Parenthetical is the satellite's HOST locality, never part of the alias.
  assert.equal(normalizeName('Haddon Satellite Fire Station (Smythes Creek)'), 'HADDON SATELLITE');
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName('CFA'), '', 'an agency word alone is not a brigade');
});

test('satellite and rural survive normalisation because they name real places', () => {
  // Stripping these collapsed 86 brigades onto their own satellites and made
  // BOTH sides unresolvable. A word that distinguishes two real stations is
  // not noise, however much it looks like it.
  assert.notEqual(
    normalizeName('Anglesea Fire Station'),
    normalizeName('Anglesea Satellite Fire Station (Anglesea)'),
  );
  assert.notEqual(
    normalizeName('Beechworth Fire Station'),
    normalizeName('Beechworth Rural Fire Station'),
  );
  // The gazetteer's own misspelling is normalised away, so a correctly spelled
  // alias can still reach it.
  assert.equal(
    normalizeName('Melbourne Airport Satelite Fire Station'),
    normalizeName('Melbourne Airport Satellite Fire Station'),
  );
});

test('an "and district" brigade answers to its bare place name too', () => {
  const keys = stationKeys('Clarkefield And District Fire Station');
  assert.deepEqual(keys, ['CLARKEFIELD AND DISTRICT', 'CLARKEFIELD']);
  // Only as a SUFFIX: "Bendigo District" is not "Bendigo".
  assert.deepEqual(stationKeys('Tarwin Lower District Fire Station'), ['TARWIN LOWER DISTRICT']);
});

test('two stations sharing a key resolve to neither', () => {
  // A near-miss silently picking one is indistinguishable, on a map, from a
  // fact. Refusing is the only honest outcome.
  const stations = [
    { name: 'Officer Fire Station', latitude: -38.06, longitude: 145.40 },
    { name: 'Officer Fire Station', latitude: -38.09, longitude: 145.42 },
  ];
  const index = buildStationIndex(stations);
  assert.deepEqual(index.ambiguous, ['OFFICER']);
  assert.equal(resolveCapcode('OFFICER', index).reason, 'ambiguous');
  assert.equal(resolveCapcode('OFFICER', index).station, null);

  // The SAME station listed twice is not a conflict.
  const dupes = buildStationIndex([stations[0], { ...stations[0] }]);
  assert.deepEqual(dupes.ambiguous, []);
  assert.equal(resolveCapcode('OFFICER', dupes).reason, 'matched');
});

test('an override rescues a name normalisation cannot bridge', () => {
  const stations = [{ name: 'Wendouree Fire Station', latitude: -37.54, longitude: 143.83 }];
  const index = buildStationIndex(stations);
  assert.equal(resolveCapcode('BALLARAT NORTH WEST', index).reason, 'unknown');

  const overrides = new Map([['BALLARAT NORTH WEST', 'Wendouree Fire Station']]);
  const hit = resolveCapcode('BALLARAT NORTH WEST', index, overrides);
  assert.equal(hit.reason, 'override');
  assert.equal(hit.station.name, 'Wendouree Fire Station');
});

test('the report names every capcode that did not place', () => {
  // A resolver that quietly places 40% looks identical on screen to one that
  // places all of them: the missing pages simply never appear.
  const stations = [{ name: 'Wendouree Fire Station', latitude: -37.54, longitude: 143.83 }];
  const { resolved, unresolved, stats } = resolveCapcodes([
    { address: '1201', alias: 'Wendouree', agency: 'CFA' },
    { address: '1202', alias: 'Nowhere Creek' },
    { address: '1203', alias: '' },
    { address: '', alias: 'ignored — no address' },
  ], stations);

  assert.equal(stats.total, 3, 'a capcode with no address is not a capcode');
  assert.equal(stats.matched, 1);
  assert.equal(stats.unknown, 1);
  assert.equal(stats.empty, 1);
  assert.equal(stats.hitRate, 33);

  // Keyed by ADDRESS, which is what a page actually carries.
  assert.deepEqual(resolved.get('1201'), {
    address: '1201',
    alias: 'Wendouree',
    agency: 'CFA',
    name: 'Wendouree Fire Station',
    latitude: -37.54,
    longitude: 143.83,
  });
  assert.deepEqual(unresolved.map((u) => u.address).sort(), ['1202', '1203']);
  assert.equal(unresolved.find((u) => u.address === '1202').reason, 'unknown');
});

test('the shipped gazetteer resolves the brigade network however it is written', () => {
  // The real measurement, against the real 1,288 Victorian stations. Every
  // alias form an operator plausibly types must land on the same station.
  const stations = victorianStations();
  assert.ok(stations.length > 1200, `expected the VIC network, got ${stations.length}`);

  const forms = [
    (n) => n,
    (n) => n.replace(/ Fire Station.*$/, ''),
    (n) => n.replace(/ Fire Station.*$/, '').toUpperCase(),
    (n) => `CFA ${n.replace(/ Fire Station.*$/, '').toUpperCase()}`,
    (n) => `${n.replace(/ Fire Station.*$/, '').toUpperCase()} FS`,
    (n) => `${n.replace(/ Fire Station.*$/, '').toUpperCase()} BRIGADE`,
  ];

  for (const form of forms) {
    const capcodes = stations.map((s, i) => ({ address: String(1000 + i), alias: form(s.name) }));
    const { stats } = resolveCapcodes(capcodes, stations);
    assert.equal(stats.unknown, 0, 'no alias form should go unrecognised');
    assert.ok(stats.hitRate >= 98, `hit rate fell to ${stats.hitRate}%`);
  }

  // The residue is genuine: stations whose names really are identical once the
  // facility words come off. Small, and fixable only by an override.
  const index = buildStationIndex(stations);
  assert.ok(
    index.ambiguous.length <= 12,
    `${index.ambiguous.length} ambiguous keys: ${index.ambiguous.join(', ')}`,
  );
});
