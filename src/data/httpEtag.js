/**
 * ETag validator helpers for the dev-server proxies.
 *
 * Lives here rather than in vite.config.js so the comparison is unit-testable
 * — the same split the FIRMS CSV parser and the TomTom tile helpers already
 * use. Pure: no Node, no Vite, no I/O.
 *
 * @module data/httpEtag
 */

/**
 * One ETag token, stripped of a weak-validator prefix and its quotes.
 *
 * @param {*} token - Raw token from an ETag or If-None-Match header.
 * @returns {string} Bare validator text ('' when there is nothing left).
 */
export function normalizeEtag(token) {
  const text = String(token ?? '').trim();
  const unweakened = text.startsWith('W/') ? text.slice(2) : text;
  return unweakened.split('"').join('');
}

/**
 * Does the client already hold the body this ETag identifies?
 *
 * A strict `===` is wrong behind the bundled Caddy. `encode gzip` rewrites the
 * ETag of anything it compresses — a `W/` weak prefix, an encoding suffix, or
 * both depending on version — and the client echoes back that rewritten token,
 * which never equals the tag we issued. A strict check would therefore answer
 * 200 every time and the 304 path would silently never fire behind exactly the
 * proxy it exists to help.
 *
 * So: split on commas (a client may present several), drop weak prefixes and
 * quotes, and accept a token that STARTS WITH ours, which covers the suffix
 * case. A false match needs a SHA-1 prefix collision, which is not a real risk.
 *
 * @param {string|string[]|undefined|null} header - Raw If-None-Match header.
 * @param {string} etag - The quoted strong ETag we issued.
 * @returns {boolean} True when the client's copy is still current.
 */
export function etagMatches(header, etag) {
  if (!header || !etag) return false;
  const ours = normalizeEtag(etag);
  if (!ours) return false;
  const raw = Array.isArray(header) ? header.join(',') : String(header);
  return raw.split(',').some((token) => {
    const trimmed = token.trim();
    if (trimmed === '*') return true;
    const normalized = normalizeEtag(trimmed);
    return normalized !== '' && (normalized === ours || normalized.startsWith(ours));
  });
}
