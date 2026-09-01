# God's Eye View for a single VPS.
#
# This image runs the VITE DEV SERVER, deliberately. The app's ~19 upstream API
# proxies — the things that broker your keys and bypass CORS for OpenSky,
# CelesTrak, TomTom, FIRMS, Overpass, CCTV, AISStream and the rest — are
# implemented as Vite plugin middleware in vite.config.js. Ten of them register
# ONLY a `configureServer` hook, so they exist under `vite` and nowhere else:
#
#   `vite build` + a static file server  → all 19 proxies gone
#   `vite preview`                       → 9 survive, 10 dead (satellites,
#                                          traffic, fires, aircraft, roads,
#                                          CCTV, bikeshare, terrain heights,
#                                          adsb.lol, adsbdb)
#   `vite` (this image)                  → all 19 working
#
# Serving a dev server is a real trade-off — upstream calls this app "not a
# hardened production service" — so keep it behind the Caddy basicauth in the
# bundled Caddyfile rather than exposing it openly. The long-term fix is to
# port those middlewares into a small standalone Node server; until then this
# is the only configuration in which every layer actually works.

FROM node:24-bookworm-slim

# Vite is a devDependency and is required at runtime here, so dev dependencies
# cannot be omitted. Puppeteer is also a devDependency but is only used by the
# scripts/qa-*.mjs harnesses, so skip its ~150 MB Chromium download.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    NODE_ENV=development \
    npm_config_update_notifier=false

WORKDIR /app

# curl backs the compose healthcheck.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Copy manifests first so `npm ci` is cached across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Bind every interface so Caddy can reach the server from its own container.
# vite.config.js keys `allowedHosts: true` off exactly this value, which is what
# lets the dev server answer for your real domain instead of rejecting it as an
# unrecognised Host header.
ENV HOST=0.0.0.0 \
    PORT=4173

EXPOSE 4173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "4173"]
