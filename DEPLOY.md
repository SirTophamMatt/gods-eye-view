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

Source changes need the rebuild because the image copies the repo in. There is
no bind mount, so a plain `restart` serves the old source — the rebuild is what
makes the pull visible. It is usually fast: `package.json` rarely changes, so
`npm ci` stays cached and only the `COPY . .` layer and later re-run.

Two things about a real deployment are worth writing down, because both fail in
ways that do not name their own cause.

**The compose file may not live inside the clone.** Keeping it one level up is a
tidy arrangement — the repo stays a pristine checkout you can reset without
touching your deployment config:

```
/opt/gev/
├── compose.yaml          ← build context: ./app
└── app/                  ← the clone; git pull runs HERE
    └── .env              ← env_file, gitignored
```

Then the two commands run in different directories, and running either in the
wrong one gives you "not a git repository" or "no configuration file provided":

```bash
git -C /opt/gev/app pull
cd /opt/gev && docker compose up -d --build
```

**Git and Docker may want different users.** If the clone is owned by a service
account rather than root, git refuses to touch it as root with *"detected
dubious ownership"*. The suggested `safe.directory` exception silences that, but
silencing it and then pulling as root is the wrong repair: the pull writes
root-owned files into a tree the service account owns, and its next operation
fails more confusingly than this one did. Run git as the owner, Docker as root —
Docker needs the daemon socket, git needs the working tree:

```bash
sudo -u gev git -C /opt/gev/app pull
cd /opt/gev && docker compose up -d --build
```

Check for files a past root operation already left behind with
`find /opt/gev/app -user root -not -path '*/node_modules/*' -not -path '*/.git/*'`.

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

A working shape, for reference — note `expose` rather than `ports`, which is the
whole point: the container is reachable from Caddy on the shared network and
from nowhere else, so there is no way to bypass the basicauth by hitting the
port directly.

```yaml
services:
  gods-eye-view:
    build:
      context: ./app
    container_name: gods-eye-view
    restart: unless-stopped
    env_file:
      - ./app/.env
    expose:
      - "4173"
    networks:
      - web

networks:
  web:
    external: true
```

`external: true` means compose expects the network to already exist rather than
creating it — whichever project defines it (Passive Monitor, here) must be up
first, and `docker network create web` if neither has made it yet. The
`container_name` is what Caddy's `reverse_proxy` target has to match.

## Refreshing the Passive Monitor layers

The nine `PM …` layers are a committed snapshot, not a live feed. Regenerate
them from a Passive Monitor database and redeploy:

```bash
node scripts/export-passive-monitor.mjs --db /path/to/unified_monitor.db
git add src/data/local_data/passive-monitor
git commit -m "Refresh Passive Monitor snapshot"
git push
```

## Refreshing the Vicmap Admin boundaries

The seven `VIC …` layers — LGA, CFA district, CFA total fire ban district, DELWP
region, EMV region, FRV district, FRV response area — are also a committed
snapshot, exported from the state's public ArcGIS service:

```bash
node scripts/export-vicmap-admin.mjs
git add src/data/local_data/vicmap-admin
git commit -m "Refresh Vicmap Admin boundaries"
git push
```

Run it on your machine, not the VPS. Unlike every live layer, these never touch
the network at runtime: there is no proxy route, no key to broker, and no rate
limit to trip, so the box only ever reads files that shipped in the image. The
upstream is contacted by this script and nothing else.

Refresh them rarely. The service republishes weekly but the geometry moves on
the order of once a year — a council amalgamation, a ward redistribution — so
there is nothing to gain from a schedule. Re-run it when a boundary actually
changes.

`--tolerance <degrees>` controls server-side generalisation (default `0.001`,
~110 m) and `--only lga,cfa-tfb` refreshes a subset. Mind the tolerance: the
committed export is ~1.6 MB, full-resolution Vicmap coastline is tens of
megabytes, and all of it is bundled into the image. `src/data/vicmapAdmin.test.mjs`
fails the build if the total passes 4 MB, along with the other ways a bad export
goes unnoticed — a truncated page, an emptied name column, a missing `outSR`.

Vicmap Admin is **CC BY 4.0**. Attribution is a condition of use, not a
courtesy, and it is carried in `DATA_CREDITS` (`src/data/dataCredits.js`).
Do not remove it.

The `VIC Fire Stations` layer is the same arrangement from a different Vicmap
product, and refreshes the same way:

```bash
node scripts/export-vicmap-emergency.mjs
git add src/data/local_data/vicmap-emergency
git commit -m "Refresh Vicmap fire stations"
git push
```

That file has a second consumer besides its layer: the detail panel's **Nearest
brigades** action reads it directly, so it answers whether or not the layer is
switched on. Deleting the snapshot therefore removes the button's data as well
as the layer's — both fail visibly rather than silently, but they fail together.

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

## Streaming live brigade pages from PagerMon

Off by default, and it stays off with no configuration change needed: the app
never phones home to look for a PagerMon instance, and the pager toggle button
does not even exist in the DOM unless one is configured. Standing one up needs
its own receiver hardware (an RTL-SDR dongle on a paging frequency, decoded
through `multimon-ng`) — this is not a data source you can point at someone
else's public instance and expect to be welcome; ask the operator first, the
same as for any other service that isn't yours.

Once you have an instance:

```bash
PAGERMON_URL=http://localhost:3000
PAGERMON_API_KEY=your-pagermon-api-key
PAGERMON_BASIC_AUTH=viewer:your-password
```

Add whichever apply to the `.env` beside `docker-compose.yml` and pass them
through in the compose `environment:` block. `PAGERMON_API_KEY` is only needed
if the instance has `messages.apiSecurity` turned on — PagerMon ships with it
**off** by default, so a stock install answers without one.
`PAGERMON_BASIC_AUTH` is for an instance sitting behind its own Caddy
basicauth, same shape as the Passive Monitor credential above. As with that
proxy, **none of these three values reach the browser** — only a boolean does,
via `PAGERMON_LIVE`, and that boolean is the only thing that decides whether
the toggle button renders at all.

Two things worth knowing:

- **Polling, not PagerMon's websocket.** PagerMon pushes new messages over
  socket.io, which is genuinely lower latency; this app polls
  `/api/pagermon/messages` every 8 seconds instead, because every other proxy
  in `vite.config.js` is hand-rolled HTTP middleware and a websocket upgrade
  passthrough is different machinery nothing else here needs yet. A few
  seconds of latency on a pager page does not justify being the first thing to
  need it.
- **A capcode that cannot be matched to a station is not hidden.** PagerMon's
  `capcodes` table has no coordinates — the join to the Vicmap fire-station
  gazetteer is done by normalising the brigade's name on both sides
  (`src/data/capcodeStations.js`), which resolves ~99% of the real Victorian
  network however an operator happens to have typed it in. The residue is
  shown in the ticker anyway, marked, with a running "N unplaced" count in the
  header — silently dropping an unmatched page would make a gap in the
  gazetteer indistinguishable from a quiet night.

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

**Nearest brigades lists stations but shows distances instead of times** — the
Code 1 estimate is computed from a real road route, so it needs `/api/route`
(OSRM via `routing.openstreetmap.de`) to be reachable from the container. The
station list, the straight-line distances and the FRV/CFA badges are all
computed from bundled files and keep working without it; only the travel times
drop out, and the lines fall back to a direct segment labelled "direct line (no
route)" rather than passing a straight line off as a road route.

**The PAGER toggle button never appears** — this is correct behaviour, not a
fault, unless `PAGERMON_URL` is actually set. The button only renders when
`PAGERMON_LIVE` stamped `true` at build time; a container built before the
variable was added, or one that had it added after the image was built rather
than before, needs a rebuild (`docker compose up -d --build`), not just a
restart — the value is baked into the client bundle at build time, same as
every other `import.meta.env.*` key in this app.

**The ticker says "Connecting…" and never moves** — `/api/pagermon/messages`
is not returning `HTTP 200`. Check `docker compose logs app` for the proxy's
sanitized error (`upstream_unreachable`, `upstream_timeout`, or an HTTP status
from PagerMon itself); a wrong `PAGERMON_API_KEY` on an instance with
`apiSecurity` enabled looks like `upstream_error` with `status: 401`.

**A page appears in the ticker with no map pin and an "unplaced" count that
keeps climbing** — the capcode's `alias` did not normalise onto any station in
the Vicmap gazetteer. This is shown, not hidden, by design: check the alias
against `src/data/capcodeStations.js`'s `OVERRIDES` map and add a verified
correction there if it is a real Victorian brigade the gazetteer names
differently.

**A `PM …` warning layer is empty** — this is usually correct, not a fault.
`PM Emergency Warnings` and `PM Watch & Act` are empty whenever nothing is
current at that level, which is most of the time. The layer still registers and
still toggles, and it fills in on the next export with no code change. A genuine
failure looks different: the layer reports an error rather than a count of zero.
