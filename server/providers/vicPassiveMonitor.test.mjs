import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPassiveMonitorMiddleware,
  passiveMonitorBaseUrl,
  passiveMonitorProxy,
  passiveMonitorUpstreamPath,
} from './vicPassiveMonitor.js';

const ENV = {
  PASSIVE_MONITOR_URL: 'https://monitor.example.com/ignored/path',
  PASSIVE_MONITOR_BASIC_AUTH: 'user:secret',
};

function fakeRes() {
  return {
    destroyed: false,
    status: null,
    headers: {},
    body: '',
    statusCode: 200,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers = {}) {
      this.status = status;
      for (const [k, v] of Object.entries(headers))
        this.headers[k.toLowerCase()] = v;
    },
    end(body = '') {
      this.status ??= this.statusCode;
      this.body = String(body);
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

const req = (url, extra = {}) => ({
  method: 'GET',
  url,
  headers: { host: 'localhost:5173' },
  socket: {},
  ...extra,
});

async function call(middleware, url, extra) {
  const res = fakeRes();
  await middleware(req(url, extra), res);
  return res;
}

function fakeUpstream(body = '{"type":"FeatureCollection","features":[]}') {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status: 200 });
  };
  return { calls, fetchImpl };
}

test('the base URL is reduced to an http(s) origin', () => {
  assert.equal(passiveMonitorBaseUrl(ENV), 'https://monitor.example.com');
  assert.equal(passiveMonitorBaseUrl({}), null);
  assert.equal(passiveMonitorBaseUrl({ PASSIVE_MONITOR_URL: 'ftp://x' }), null);
  assert.equal(passiveMonitorBaseUrl({ PASSIVE_MONITOR_URL: 'nope' }), null);
});

test('only the layer list and allowlisted pm-* layers map upstream', () => {
  assert.equal(passiveMonitorUpstreamPath('/layers'), '/api/intel/layers');
  assert.equal(
    passiveMonitorUpstreamPath('/geojson/pm-flood'),
    '/api/intel/geojson/pm-flood',
  );
  assert.equal(passiveMonitorUpstreamPath('/geojson/other'), null);
  assert.equal(passiveMonitorUpstreamPath('/geojson/pm-../x'), null);
  assert.equal(passiveMonitorUpstreamPath('/anything'), null);
});

test('status reports whether an instance is configured', async () => {
  const off = createPassiveMonitorMiddleware({ env: {} });
  assert.deepEqual((await call(off, '/status')).json(), { live: false });
  const on = createPassiveMonitorMiddleware({ env: ENV });
  assert.deepEqual((await call(on, '/status')).json(), { live: true });
});

test('an unconfigured instance answers 503, not 404', async () => {
  const middleware = createPassiveMonitorMiddleware({ env: {} });
  const res = await call(middleware, '/geojson/pm-flood');
  assert.equal(res.status, 503);
  assert.equal(res.json().error, 'not_configured');
});

test('a layer is proxied with basic auth and its body passed through', async () => {
  const { calls, fetchImpl } = fakeUpstream('{"ok":1}');
  const middleware = createPassiveMonitorMiddleware({ env: ENV, fetchImpl });
  const res = await call(middleware, '/geojson/pm-flood');
  assert.equal(res.status, 200);
  assert.equal(res.body, '{"ok":1}');
  assert.equal(
    calls[0].url,
    'https://monitor.example.com/api/intel/geojson/pm-flood',
  );
  assert.equal(
    calls[0].init.headers.Authorization,
    `Basic ${Buffer.from('user:secret').toString('base64')}`,
  );
});

test('viewers polling inside 30 s share one upstream read', async () => {
  let t = 0;
  const { calls, fetchImpl } = fakeUpstream();
  const middleware = createPassiveMonitorMiddleware({
    env: ENV,
    fetchImpl,
    now: () => t,
  });
  await Promise.all([
    call(middleware, '/geojson/pm-flood'),
    call(middleware, '/geojson/pm-flood'),
  ]);
  t = 29_000;
  await call(middleware, '/geojson/pm-flood');
  assert.equal(calls.length, 1);
  t = 31_000;
  await call(middleware, '/geojson/pm-flood');
  assert.equal(calls.length, 2);
});

test('upstream failures map to 502/504 without leaking the body', async () => {
  const denied = createPassiveMonitorMiddleware({
    env: ENV,
    fetchImpl: async () => new Response('<html>login</html>', { status: 401 }),
  });
  const res = await call(denied, '/layers');
  assert.equal(res.status, 502);
  assert.deepEqual(res.json(), { error: 'upstream_error', status: 401 });

  const down = createPassiveMonitorMiddleware({
    env: ENV,
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  const unreachable = await call(down, '/layers');
  assert.equal(unreachable.status, 504);
  assert.equal(unreachable.json().error, 'upstream_unreachable');
});

test('unknown routes, other methods and cross-site requests are refused', async () => {
  const middleware = createPassiveMonitorMiddleware({ env: ENV });
  assert.equal((await call(middleware, '/geojson/secrets')).status, 404);
  assert.equal(
    (await call(middleware, '/layers', { method: 'POST' })).status,
    405,
  );
  const crossSite = await call(middleware, '/layers', {
    headers: { host: 'localhost:5173', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
});

test('construction does not fetch and mounts on dev and preview', () => {
  const plugin = passiveMonitorProxy({
    fetchImpl: () => {
      throw new Error('construction must not fetch');
    },
  });
  const mounted = [];
  const server = { middlewares: { use: (path) => mounted.push(path) } };
  plugin.configureServer(server);
  plugin.configurePreviewServer(server);
  assert.deepEqual(mounted, ['/api/passive-monitor', '/api/passive-monitor']);
});
