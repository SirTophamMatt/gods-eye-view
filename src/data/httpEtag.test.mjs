import test from 'node:test';
import assert from 'node:assert/strict';
import { etagMatches, normalizeEtag } from './httpEtag.js';

const TAG = '"abc123"';

test('normalizeEtag strips quotes', () => {
  assert.equal(normalizeEtag('"abc123"'), 'abc123');
});

test('normalizeEtag strips a weak-validator prefix', () => {
  assert.equal(normalizeEtag('W/"abc123"'), 'abc123');
});

test('normalizeEtag tolerates whitespace and empties', () => {
  assert.equal(normalizeEtag('  "abc123" '), 'abc123');
  assert.equal(normalizeEtag(''), '');
  assert.equal(normalizeEtag(null), '');
  assert.equal(normalizeEtag(undefined), '');
});

test('exact tag matches', () => {
  assert.equal(etagMatches('"abc123"', TAG), true);
});

test('Caddy weak-prefixed tag still matches', () => {
  assert.equal(etagMatches('W/"abc123"', TAG), true);
});

test('Caddy encoding-suffixed tag still matches', () => {
  assert.equal(etagMatches('"abc123.gz"', TAG), true);
  assert.equal(etagMatches('W/"abc123-gzip"', TAG), true);
});

test('one match inside a multi-token header is enough', () => {
  assert.equal(etagMatches('"other", W/"abc123", "more"', TAG), true);
});

test('wildcard matches', () => {
  assert.equal(etagMatches('*', TAG), true);
});

test('a different tag does not match', () => {
  assert.equal(etagMatches('"zzz999"', TAG), false);
  assert.equal(etagMatches('W/"abc12"', TAG), false, 'a prefix of ours is not a match');
});

test('missing or empty inputs never match', () => {
  assert.equal(etagMatches(undefined, TAG), false);
  assert.equal(etagMatches('', TAG), false);
  assert.equal(etagMatches('"abc123"', ''), false);
  assert.equal(etagMatches('""', TAG), false, 'an empty client token must not match');
});

test('header arrays are accepted', () => {
  assert.equal(etagMatches(['"nope"', 'W/"abc123"'], TAG), true);
});
