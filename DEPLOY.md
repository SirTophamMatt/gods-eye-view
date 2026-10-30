# Deploying God's Eye View on a Hostinger VPS

This fork runs on a Hostinger VPS beside Passive Monitor, sharing Passive
Monitor's Caddy for HTTPS. The reference files are in `deploy/vps/`:

- `deploy/vps/compose.yaml`: the compose file, kept one level above the clone
  at `/opt/gev/compose.yaml`.
- `deploy/vps/Caddyfile.snippet`: the site block to add to Passive Monitor's
  Caddyfile.

The image is upstream's own `Dockerfile`: Node 24.14 pinned by digest, run as
the unprivileged `node` user, the source copied in, and
`scripts/docker-start.mjs` starting the server. Upstream's `compose.yaml` is a
local-machine setup (loopback port, bind-mounted checkout) and is not used here.

## Read this first: why the image runs a dev server

Every data layer reaches its provider through the server routes in
`server/providers/`, which upstream mounts on the Vite server. `vite preview`
now serves those routes too, but upstream still describes it as "not a
production server", and Provider Settings only exist under the dev server.
`scripts/docker-start.mjs` therefore starts the dev server, and so does this
deployment. That is why the Caddy block requires basicauth.

## Before you expose anything

Anyone who can load the page can spend your money. Two separate exposures:

- **Browser-exposed by design:** `GOOGLE_MAPS_API_KEY` and `CESIUM_ION_TOKEN`
  reach the browser. Restrict the Google key by HTTP referrer in Google Cloud
  Console, restrict the ion token at Cesium, and set a billing budget on both.
- **Brokered server-side:** OpenAI, TomTom, FIRMS, AISStream, OpenSky, Passive
  Monitor and PagerMon are proxied on behalf of whoever is viewing the page.
  The `GEV_RATELIMIT_*` throttles are app-level guards, **not** billing caps,
  and behind Caddy every viewer shares one bucket (upstream keys the limiter on
  the socket address, which is always Caddy's). Set spend limits at each
  provider too.

`GOOGLE_MAPS_API_KEY` is the only required key. Every other key is optional and
degrades only its own layer.

## Upstream's request checks, and what Caddy must do about them

Upstream v0.2.1 added two checks that a reverse proxy runs straight into:

1. **Host allow-list.** Every request whose `Host` is not an IP address,
   `localhost`, or a name listed in `GEV_ALLOWED_HOSTS` gets
   `403 Blocked request. This host is not allowed.` Set
   `GEV_ALLOWED_HOSTS=<your domain>`: exact names, comma-separated, no
   wildcards (a leading dot or `*` is silently dropped). Caddy passes the
   original `Host` through by default.
2. **Same-site gate.** The cost-bearing routes (voice, the HUD AI summary,
   Places, Overpass, TomTom, Mapillary) refuse any request carrying proxy
   headers (`Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP`,
   `CF-Connecting-IP`, `CF-Ray`), and every gated route refuses an `Origin`
   that does not equal `<scheme>://<Host>` as the server sees it. Behind Caddy
   the app only ever sees plain `http`, so a browser's
   `Origin: https://<domain>` never matches.

Caddy therefore removes the proxy headers and `Origin` before passing a request
on (see `deploy/vps/Caddyfile.snippet`). The browser's `Sec-Fetch-Site` check
still runs, so cross-site browser requests are still refused; basicauth is what
keeps everyone else out. This was chosen over patching upstream's gate so the
fork carries no changes to upstream's security code.

## Prerequisites

- A **Hostinger VPS** with room for the Vite dev server (KVM 2, 2 vCPU / 8 GB,
  is comfortable; the first cold start takes a couple of minutes).
- A **domain or subdomain** with an `A` record pointing at the VPS IP.
- Docker + Docker Compose.
- Passive Monitor's stack already up, providing the external `web` network
  and the Caddy that fronts both projects.

## First deploy

```bash
sudo mkdir -p /opt/gev && sudo chown gev:gev /opt/gev
sudo -u gev git clone https://github.com/SirTophamMatt/gods-eye-view.git /opt/gev/app
sudo cp /opt/gev/app/deploy/vps/compose.yaml /opt/gev/compose.yaml
```

Create `/opt/gev/app/.env` (gitignored, and excluded from the image; compose
passes it in with `env_file`). Copy `.env.example` and fill in at least:

```bash
GOOGLE_MAPS_API_KEY=your_key_here
GEV_ALLOWED_HOSTS=godseye.yourdomain.com
GEV_KEY_SETUP_TRUSTED_PEERS=none
PASSIVE_MONITOR_URL=
PASSIVE_MONITOR_BASIC_AUTH=
```

Add the site block from `deploy/vps/Caddyfile.snippet` to Passive Monitor's
Caddyfile with your domain and a password hash
(`docker run --rm caddy:2 caddy hash-password --plaintext 'your-password'`),
reload that Caddy, then bring this project up:

```bash
cd /opt/gev && docker compose up -d --build
docker compose logs -f gods-eye-view
```

Then run the checks under **Verifying a deployment** below.

## Verifying a deployment

From any machine, with your basicauth credentials:

```bash
curl -su viewer:PASSWORD -o /dev/null -w '%{http_code}\n' https://godseye.yourdomain.com/
curl -su viewer:PASSWORD https://godseye.yourdomain.com/api/passive-monitor/status
curl -su viewer:PASSWORD -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -H 'Origin: https://godseye.yourdomain.com' \
  -d '{}' https://godseye.yourdomain.com/api/overpass
```

- The first should print `200`. A `403` with "host is not allowed" means
  `GEV_ALLOWED_HOSTS` is missing or misspelt.
- The second should print `{"live":true}` when `PASSIVE_MONITOR_URL` is set.
- The third must **not** print `403`. A `400` or `502` is fine (the body is
  not a real query). A `403` means Caddy is still passing a proxy header or
  `Origin`; check the snippet was applied and Caddy reloaded.

Then open the page and confirm the voice agent connects and the HUD summary
fills in: both go through the gated routes.

## Moving the VPS onto the upstream-based fork (one-off)

The fork was rebuilt on upstream v0.3.0. On the VPS, the first update after
that change also needs:

1. `GEV_ALLOWED_HOSTS` and `GEV_KEY_SETUP_TRUSTED_PEERS=none` added to
   `/opt/gev/app/.env`.
2. `/opt/gev/compose.yaml` compared against `deploy/vps/compose.yaml`. In
   particular, remove any `curl` healthcheck: upstream's image has no curl and
   carries its own Node-based `HEALTHCHECK`.
3. The Caddy site block replaced with `deploy/vps/Caddyfile.snippet`, and
   Caddy reloaded.
4. Then the normal update, below, and the checks above.

To roll back, check out the previous commit
(`sudo -u gev git -C /opt/gev/app checkout 82d873e`), restore the old Caddy
block, and rebuild.

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

## Sharing Passive Monitor's Caddy

Both projects would otherwise want `:80` and `:443`, so the box runs **one**
Caddy: Passive Monitor's. This project has no Caddy service of its own; its
container joins the external `web` network and is reached by name.

The compose file uses `expose`, not `ports`: the container is reachable from
Caddy on the shared network and from nowhere else, so basicauth cannot be
bypassed by hitting the port directly. `external: true` means the `web`
network must already exist (Passive Monitor creates it, or
`docker network create web`). The `container_name` is what the Caddy
`reverse_proxy` target has to match.

See `deploy/vps/compose.yaml` and `deploy/vps/Caddyfile.snippet`, and the
request-check section above for why the snippet strips headers.

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

That file has a second consumer besides its layer: the detail panel's **Response
timeline** action reads it directly, so it answers whether or not the layer is
switched on. Deleting the snapshot therefore removes the button's data as well
as the layer's — both fail visibly rather than silently, but they fail together.

That action reads two of the Vicmap Admin boundaries the same way. The FRV
response area sets each station's agency badge and decides whether the response
menu offers GARS alarm levels or Make Tankers; the CFA district partition sets
each brigade's turnout standard (`src/data/turnoutStandard.js` — FRV 1:30, CFA
4:00 in Districts 7/8/13/14, 8:00 elsewhere). Both degrade on their own: without
the FRV file every station loses its badge and the menu falls back to the general
response, and without the district file the timeline draws travel only. Neither
failure costs the station list.

## Streaming live from Passive Monitor

The snapshots are the default. To read live instead, point this app at a Passive
Monitor instance exposing the read-only `/api/intel/*` endpoints:

```bash
PASSIVE_MONITOR_URL=https://monitor.yourdomain.com
PASSIVE_MONITOR_BASIC_AUTH=viewer:your-password
```

Add both to `/opt/gev/app/.env`; compose passes it in with `env_file`. The
layers then fetch `/api/passive-monitor/geojson/<layer>`, which
`server/providers/vicPassiveMonitor.js` brokers to that instance (sharing one
upstream read per layer per 30 s across all viewers). **Neither value reaches
the browser**: the page only asks `/api/passive-monitor/status` whether a live
instance is configured, once, when a Passive Monitor layer is first switched
on. Because that is decided at page load rather than baked into the bundle,
changing these values needs a container restart, not a rebuild.

Two behaviours worth knowing:

- **Live layers poll; snapshot layers do not.** Pointed at an instance, each PM
  layer re-fetches every **2 minutes** and holds a record that drops out of the
  feed for a further **10 minutes** before it stops being drawn. A held record is
  marked `NOT IN LAST UPDATE` on its globe card and carries a full explanation in
  the detail panel — a feed dropping a record means either "it closed" or "the
  poll missed it", and the feed never says which, so neither is asserted. The
  policy lives in `PM_LIVE_POLICY` (`src/layers/vic/catalog.js`) and applies only
  when live: a snapshot committed to the build cannot change under a running
  session, so polling it would be pure waste. A failed poll keeps the last good
  data on screen rather than emptying the layer.
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

> **Not yet moved onto the upstream-based fork.** PagerMon, the brigade
> response timeline and Monitor Mode follow in a later step of the port; until
> then this section describes the previous build, and setting `PAGERMON_*`
> has no effect.

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

**Blocked request / "host is not allowed"** — upstream's Host allow-list. Add
the exact domain to `GEV_ALLOWED_HOSTS` in `/opt/gev/app/.env` and restart
(`docker compose exec gods-eye-view printenv GEV_ALLOWED_HOSTS` to confirm it
arrived). Wildcards and leading dots are ignored.

**Voice, the HUD summary, place search or roads fail with 403 "Proxied
requests are not accepted" or "Cross-origin requests are not accepted"** —
Caddy is passing a proxy header or the browser's `Origin` through. Apply
`deploy/vps/Caddyfile.snippet`, reload Caddy, and rerun the checks under
**Verifying a deployment**.

**Globe renders as an error message** — `GOOGLE_MAPS_API_KEY` is missing or
referrer-restricted to a domain that is not this one.

**A single LIVE layer is empty while others work** — that provider's key is
absent or rate-limited. Check `docker compose logs app` for the proxy's
sanitized error; a missing key never takes the rest of the app down.

**Nearest brigades lists stations but shows distances instead of times** (the
action is switched off until the brigade response is moved across) — the
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
