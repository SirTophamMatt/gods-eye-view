# Deploying God's Eye View on a Hostinger VPS

This mirrors the Passive Monitor deployment — Docker Compose plus Caddy for
automatic HTTPS — so both projects can live on the same box with the same
muscle memory.

## Read this first: why the image runs a dev server

God's Eye View reaches its upstream data through **19 API proxies implemented
as Vite plugin middleware inside `vite.config.js`**. They bypass CORS and, for
the secret-bearing providers, keep your keys server-side. Ten of those proxies
register only a `configureServer` hook, which means they exist under the Vite
dev server and nowhere else:

| How you serve it | Working proxies | What breaks |
| --- | --- | --- |
| `vite build` + static host (nginx, Netlify, Hostinger static) | **0 of 19** | every live layer |
| `vite preview` | 9 of 19 | satellites, traffic, fires, aircraft, roads, CCTV, bikeshare, terrain heights, adsb.lol, adsbdb |
| `vite` — what this image runs | **19 of 19** | nothing |

So a static build is not a deployment of this app; it is a deployment of the
globe with the intelligence removed. Until those middlewares are ported into a
standalone Node server, running the dev server behind Caddy is the only
configuration in which the whole app works.

That trade-off is why the bundled `Caddyfile` requires basicauth. Upstream is
explicit that this is "not a hardened production service."

## Before you expose anything

Anyone who can load the page can spend your money. Two separate exposures:

- **Browser-exposed by design:** `GOOGLE_MAPS_API_KEY` and `CESIUM_ION_TOKEN`
  are compiled into the client bundle. Restrict the Google key by HTTP referrer
  in Google Cloud Console, restrict the ion token at Cesium, and set a billing
  budget on both.
- **Brokered server-side:** OpenAI, TomTom, FIRMS, AISStream and OpenSky are
  proxied on behalf of whoever is viewing the page. The `GEV_RATELIMIT_*`
  throttles are app-level guards, **not** billing caps. Set spend limits at each
  provider too.

`GOOGLE_MAPS_API_KEY` is the only required key — it is the base globe, and
without it the app renders an error instead of a map. Every other key is
optional and degrades only its own layer.

## Prerequisites

- A **Hostinger VPS**. Give this one room: the Vite dev server holding the
  Cesium dependency graph is heavier than Passive Monitor. KVM 2 (2 vCPU /
  8 GB) is comfortable; the first cold start takes a couple of minutes while
  Vite pre-bundles.
- A **domain or subdomain** with an `A` record pointing at the VPS IP.
- Docker + Docker Compose (Hostinger's "Ubuntu 22.04 with Docker" template
  ships them; otherwise `curl -fsSL https://get.docker.com | sh`).

## First deploy

```bash
git clone https://github.com/SirTophamMatt/gods-eye-view.git
cd gods-eye-view
```

Create `.env` next to `docker-compose.yml`:

```bash
GOOGLE_MAPS_API_KEY=your_key_here
CESIUM_ION_TOKEN=
OPENAI_API_KEY=
AISSTREAM_API_KEY=
FIRMS_MAP_KEY=
TOMTOM_API_KEY=
OPENSKY_CLIENT_ID=
OPENSKY_CLIENT_SECRET=
```

Generate a password hash and put it, with your domain, into the `Caddyfile`:

```bash
docker run --rm caddy:2 caddy hash-password --plaintext 'your-password'
```

Then bring it up:

```bash
docker compose up -d --build
```

Watch the first boot — Vite's cold optimize pass is slow, and the healthcheck
allows 120 s for it:

```bash
docker compose logs -f app
```

## Updating

The whole point of the local-to-VPS loop:

```bash
git pull
docker compose up -d --build
```

Source changes need the rebuild because the image copies the repo in.

## If Passive Monitor is already on this host

Both projects ship a Caddy that binds `:80` and `:443`, and two containers
cannot both hold those ports. Run **one** Caddy for the box. The simplest fix
is to keep Passive Monitor's Caddy and add a second site block to its
`Caddyfile`:

```
godseye.yourdomain.com {
    basicauth {
        viewer <bcrypt-hash>
    }
    reverse_proxy godseye-app-1:4173
}
```

...then delete the `caddy` service from this project's `docker-compose.yml` and
put both projects' `app` containers on a shared Docker network so Caddy can
resolve them by name.

## Refreshing the Passive Monitor layers

The nine `PM …` layers are a committed snapshot, not a live feed. Regenerate
them from a Passive Monitor database and redeploy:

```bash
node scripts/export-passive-monitor.mjs --db /path/to/unified_monitor.db
git add src/data/local_data/passive-monitor
git commit -m "Refresh Passive Monitor snapshot"
git push
```

## Streaming live from Passive Monitor

The snapshots are the default. To read live instead, point this app at a Passive
Monitor instance exposing the read-only `/api/intel/*` endpoints:

```bash
PASSIVE_MONITOR_URL=https://monitor.yourdomain.com
PASSIVE_MONITOR_BASIC_AUTH=viewer:your-password
```

Add both to the `.env` beside `docker-compose.yml` and pass them through in the
compose `environment:` block. The layers then fetch
`/api/passive-monitor/geojson/<layer>`, which the Vite proxy brokers to that
instance. **Neither value reaches the browser** — only a boolean does, so the
client never learns where the instance lives or how to authenticate to it.

Two behaviours worth knowing:

- **There is no automatic fallback to the snapshots.** If the instance is
  unreachable the layers report an error. Silently serving hours-old hazard data
  as though it were current is the worse failure.
- **Both sources emit an identical property contract**, verified feature-for-
  feature across the whole dataset. Switching source is a URL change and nothing
  else. The two implementations are `scripts/export-passive-monitor.mjs` here and
  `app/api_intel.py` in the Passive Monitor repo — if you change a field in one,
  change it in the other.

If Passive Monitor sits behind its own Caddy basicauth on the same host, prefer
pointing at it over the internal Docker network (`http://passivemonitor-app-1:8050`)
rather than back out through the public hostname — that skips the auth round trip
and keeps the traffic on the box.

## Troubleshooting

**Blocked request / "host is not allowed"** — the dev server only accepts a
foreign `Host` header when it binds all interfaces. Confirm `HOST=0.0.0.0`
reached the container (`docker compose exec app printenv HOST`); `vite.config.js`
keys `allowedHosts: true` off exactly that value.

**Globe renders as an error message** — `GOOGLE_MAPS_API_KEY` is missing or
referrer-restricted to a domain that is not this one.

**A single LIVE layer is empty while others work** — that provider's key is
absent or rate-limited. Check `docker compose logs app` for the proxy's
sanitized error; a missing key never takes the rest of the app down.

**A `PM …` warning layer is empty** — this is usually correct, not a fault.
`PM Emergency Warnings` and `PM Watch & Act` are empty whenever nothing is
current at that level, which is most of the time. The layer still registers and
still toggles, and it fills in on the next export with no code change. A genuine
failure looks different: the layer reports an error rather than a count of zero.
