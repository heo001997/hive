FROM node:20-slim

# --- Headless Hive backend as a standalone, supervised service ------------------
# Runs the standalone HTTP/WS backend (src/server/bin.ts -> out/main/server.js)
# with no Electron GUI. The Electron binary is only used as a Node runtime via
# ELECTRON_RUN_AS_NODE=1; HIVE_HEADLESS=1 makes the intent explicit.
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:/usr/local/bin:${PATH}"
ENV HIVE_HEADLESS=1
ENV HIVE_SERVER_MODE=browser
ENV HIVE_SERVER_HOST=0.0.0.0
ENV HIVE_SERVER_PORT=3773
# Off-loopback binds require auth; TLS is typically terminated at an upstream
# proxy, so default to plain http INSIDE the container behind that proxy. Flip
# HIVE_SERVER_ALLOW_INSECURE=false and provide TLS cert/key to terminate here.
ENV HIVE_SERVER_REQUIRE_AUTH=true
ENV HIVE_SERVER_ALLOW_INSECURE=true
# Persistent Hive data dir (DB, attachments, logs) — mount a volume here.
ENV HIVE_SERVER_BASE_DIR=/data
# Serve the built web UI. The web build lands at out/renderer-web; when running
# server.js standalone nothing else sets this, so point it explicitly.
ENV HIVE_SERVER_STATIC_DIR=/app/out/renderer-web
ENV ELECTRON_RUN_AS_NODE=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    openssh-client \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@10.24.0 --activate \
  && npm install -g @anthropic-ai/claude-code

WORKDIR /app

# This repo is a pnpm workspace: the root package.json depends on
# "@hive/client": "workspace:*" (link:packages/hive-client in the lockfile), so a
# frozen install needs the workspace manifest AND each workspace package's
# package.json present before `pnpm install` — copying only the root manifest
# makes --frozen-lockfile fail on the missing workspace importer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/hive-client/package.json ./packages/hive-client/
RUN pnpm install --frozen-lockfile
RUN pnpm rebuild better-sqlite3 node-pty

COPY . .
RUN pnpm run build:server && pnpm run build:web
RUN chmod +x /app/docker-entrypoint.sh

# Volumes:
#   /data          Persistent Hive state (SQLite DB, attachments, logs). REQUIRED.
#   /certs         (optional) TLS material when terminating TLS in-container; set
#                  HIVE_SERVER_TLS_CERT / HIVE_SERVER_TLS_KEY to files under here.
VOLUME ["/data"]

# Ports: 3773 = HTTP + WS (same port; WS upgrades on /ws).
EXPOSE 3773

# Container liveness/readiness probe. /health returns {"ok":true} once the
# HTTP server is listening; it is public (no auth) and cheap.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.HIVE_SERVER_PORT||3773)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "out/main/server.js"]
