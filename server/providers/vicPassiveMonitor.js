import { coalesceProxyRequest, readResponseTextCapped } from './common/http.js';
import { admitSameSiteKeyless } from './common/same-site.js';

// Passive Monitor: live Victorian hazard layers (GeoJSON).
//
// Brokers the read-only /api/intel/* endpoints of a Passive Monitor instance
// (github.com/SirTophamMatt/PassiveMotintor). Server-side rather than fetched
// straight from the browser for three reasons: the upstream sets no CORS
// headers, the instance may sit behind HTTP basic auth whose credentials must
// never reach the client, and the URL differs per environment (a local
// instance in development, the VPS in production).
//
//   PASSIVE_MONITOR_URL         base origin, e.g. http://localhost:8050
//                               or https://monitor.example.com
//   PASSIVE_MONITOR_BASIC_AUTH  optional "user:password" for an instance
//                               behind Caddy basicauth
//
// Unset PASSIVE_MONITOR_URL is a normal state, not a fault: /status reports
// live:false and the layers load their committed snapshots instead.

// Layer ids are allowlisted by shape so a request cannot be steered onto an
// arbitrary upstream path.
export const PASSIVE_MONITOR_LAYER_RE = /^pm-[a-z0-9-]{1,40}$/;
const TIMEOUT_MS = 10_000;
// A hazard layer is tens of KB; this only stops a wrong URL streaming forever.
const MAX_BYTES = 12 * 1024 * 1024;
// Collectors run on their own cadence and the endpoint itself says max-age=30,
// so every viewer polling inside that window shares one upstream read.
const CACHE_TTL_MS = 30_000;

/** Origin of the configured instance, or null when unset or not http(s). */
export function passiveMonitorBaseUrl(env = process.env) {
  const raw = String(env.PASSIVE_MONITOR_URL || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function passiveMonitorHeaders(env) {
  const headers = { Accept: 'application/json' };
  const credentials = String(env.PASSIVE_MONITOR_BASIC_AUTH || '').trim();
  if (credentials.includes(':')) {
    headers.Authorization = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
  }
  return headers;
}

/** Upstream path for a request path under /api/passive-monitor, or null. */
export function passiveMonitorUpstreamPath(pathname) {
  if (pathname === '/layers') return '/api/intel/layers';
  const match = /^\/geojson\/([a-z0-9-]{1,40})$/i.exec(pathname);
  if (match && PASSIVE_MONITOR_LAYER_RE.test(match[1])) {
    return `/api/intel/geojson/${match[1]}`;
  }
  return null;
}

export function createPassiveMonitorMiddleware({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();

  const sendJson = (res, status, body) => {
    if (res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };

  async function load(url) {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const upstream = await fetchImpl(url, {
      headers: passiveMonitorHeaders(env),
      redirect: 'error',
      signal,
    });
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      // Surface the upstream status but not its body: a Caddy auth failure
      // returns an HTML login page that would land in JSON.parse.
      throw Object.assign(new Error('upstream_error'), {
        upstreamStatus: upstream.status,
      });
    }
    const text = await readResponseTextCapped(upstream, MAX_BYTES, signal);
    cache.set(url, { at: now(), text });
    return text;
  }

  return async function passiveMonitorMiddleware(req, res) {
    if (admitSameSiteKeyless(req, res)) return;
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    const base = passiveMonitorBaseUrl(env);
    const { pathname } = new URL(req.url || '/', 'http://localhost');
    if (pathname === '/status') {
      sendJson(res, 200, { live: Boolean(base) });
      return;
    }
    const upstreamPath = passiveMonitorUpstreamPath(pathname);
    if (!upstreamPath) {
      sendJson(res, 404, { error: 'unknown_route' });
      return;
    }
    if (!base) {
      // 503 rather than 404: the route exists, the instance is just not
      // configured.
      sendJson(res, 503, { error: 'not_configured' });
      return;
    }

    const url = `${base}${upstreamPath}`;
    try {
      const cached = cache.get(url);
      const text =
        cached && now() - cached.at < CACHE_TTL_MS
          ? cached.text
          : await coalesceProxyRequest(inFlight, url, () => load(url)).promise;
      if (res.destroyed) return;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=30',
      });
      res.end(text);
    } catch (error) {
      if (error?.upstreamStatus) {
        sendJson(res, 502, {
          error: 'upstream_error',
          status: error.upstreamStatus,
        });
      } else if (error?.code === 'RESPONSE_TOO_LARGE') {
        sendJson(res, 502, { error: 'upstream_too_large' });
      } else {
        sendJson(res, 504, {
          error:
            error?.name === 'TimeoutError' || error?.name === 'AbortError'
              ? 'upstream_timeout'
              : 'upstream_unreachable',
        });
      }
    }
  };
}

export function passiveMonitorProxy(options) {
  const middleware = createPassiveMonitorMiddleware(options);
  const mount = ({ middlewares }) => {
    middlewares.use('/api/passive-monitor', middleware);
  };
  return {
    name: 'vic-passive-monitor',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
