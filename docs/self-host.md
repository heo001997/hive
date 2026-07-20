# Self-hosting the Hive backend

Hive's backend (the HTTP + WebSocket API that the desktop app normally spawns as
a child process) can run **standalone** as a long-lived, supervised service. This
lets you host Hive on a server or NAS and connect from a browser or mobile client
over the network, instead of running the Electron desktop app.

The standalone entry point is `src/server/bin.ts`, built to `out/main/server.js`.
It is a plain Node program (run via the Electron binary in `ELECTRON_RUN_AS_NODE`
mode, or with `node`), with no GUI.

---

## 1. What the service does

- Serves the JSON/WS RPC API on a single port (`3773` by default).
- Optionally serves the built web UI (static files) on the same port.
- Persists all state — SQLite DB, attachments, logs — under one **data dir**.
- Exits `0` on `SIGTERM`/`SIGINT` after gracefully closing WS + HTTP; exits
  non-zero if startup fails (port in use, bad TLS material, invalid config).

On startup it logs a **redacted** config summary to stderr (never the owner
token or bootstrap token — only booleans for whether they are set) and a single
machine-parseable readiness line to stdout:

```json
{"event":"hive-server-ready","httpBaseUrl":"https://…","wsBaseUrl":"wss://…/ws"}
```

---

## 2. Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `HIVE_HEADLESS` | _(unset)_ | Set `1` to mark the process as a headless service (no GUI). |
| `HIVE_SERVER_MODE` | `desktop` | `browser` to serve the web UI / accept remote clients. |
| `HIVE_SERVER_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to expose on all interfaces. |
| `BIND_IP` | _(unset)_ | Alternative bind address; **requires** `HIVE_SERVER_REQUIRE_AUTH=true`. |
| `HIVE_SERVER_PORT` | `3773` | HTTP + WS port. `0` picks a random free port. |
| `HIVE_SERVER_REQUIRE_AUTH` | `true` | `false`/`0` disables auth (loopback only). Required `true` for any non-loopback bind. |
| `HIVE_SERVER_BASE_DIR` | `~/.hive` | Data dir (DB, attachments, logs). Also honored: `HIVE_DATA_DIR` (dev override, highest precedence). |
| `HIVE_SERVER_STATIC_DIR` | _(unset)_ | Directory of the built web UI to serve. Set to `out/renderer-web` to serve the browser client. |
| `HIVE_OWNER_TOKEN` | _(unset)_ | Plaintext owner token for remote single-owner auth. Never persisted; accepted in addition to any minted (hashed) token. **Secret.** |
| `HIVE_SERVER_TLS_CERT` | _(unset)_ | Path to the TLS certificate (PEM). Enables `https`/`wss` when paired with the key. |
| `HIVE_SERVER_TLS_KEY` | _(unset)_ | Path to the TLS private key (PEM). |
| `HIVE_SERVER_ALLOW_INSECURE` | `false` | `true`/`1` allows a non-loopback bind over **plain http** (only safe behind a TLS-terminating proxy). |
| `HIVE_SERVER_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_OAUTH_TOKEN` | _(unset)_ | Claude OAuth token for the agent SDK (the entrypoint maps the latter to the former). |

### Security invariants (enforced at startup)

- A **non-loopback** bind (`0.0.0.0`, a routable IP, or any non-`127.x`/`::1`
  host) **requires** `HIVE_SERVER_REQUIRE_AUTH=true`.
- A non-loopback bind additionally **requires TLS** (`HIVE_SERVER_TLS_CERT` +
  `HIVE_SERVER_TLS_KEY`) **unless** `HIVE_SERVER_ALLOW_INSECURE=true` (use only
  when TLS is terminated by an upstream proxy). This guarantees the owner token
  is never sent in the clear over the network.
- `BIND_IP` requires `HIVE_SERVER_REQUIRE_AUTH=true`.

Violating any of these makes startup fail fast with a non-zero exit code.

---

## 3. Health / readiness probes

Both endpoints are public (no auth) and safe for orchestrator probes:

- `GET /health` → `{"ok":true}` once the HTTP server is listening. Use this for
  liveness **and** readiness — cheap, no side effects.
- `GET /.well-known/hive/environment` → connection descriptor (mode, host, port,
  `httpBaseUrl`, `wsBaseUrl`, `hasOwnerToken`, …). Useful for clients to discover
  how to connect. The desktop parent uses this as its readiness probe.

---

## 4. Run with Docker

```bash
# Build the image (builds the server + web bundles inside the image).
docker build -t hive-backend .

# Run behind your own TLS-terminating proxy (plain http inside the container):
docker run -d --name hive \
  -p 3773:3773 \
  -v hive-data:/data \
  -e HIVE_OWNER_TOKEN="$(openssl rand -hex 32)" \
  hive-backend
```

The image sets sensible headless defaults (`HIVE_HEADLESS=1`,
`HIVE_SERVER_MODE=browser`, `HIVE_SERVER_HOST=0.0.0.0`,
`HIVE_SERVER_REQUIRE_AUTH=true`, `HIVE_SERVER_ALLOW_INSECURE=true`,
`HIVE_SERVER_BASE_DIR=/data`, `HIVE_SERVER_STATIC_DIR=/app/out/renderer-web`).

### Terminating TLS inside the container

```bash
docker run -d --name hive \
  -p 3773:3773 \
  -v hive-data:/data \
  -v /etc/hive/certs:/certs:ro \
  -e HIVE_SERVER_ALLOW_INSECURE=false \
  -e HIVE_SERVER_TLS_CERT=/certs/fullchain.pem \
  -e HIVE_SERVER_TLS_KEY=/certs/privkey.pem \
  -e HIVE_OWNER_TOKEN="$(openssl rand -hex 32)" \
  hive-backend
```

**Volumes**

- `/data` — **required**, persistent Hive state (SQLite DB, attachments, logs).
- `/certs` — optional, TLS material when terminating TLS in-container.

**Ports**

- `3773` — HTTP + WebSocket (WS upgrades on `/ws`; same port).

The image declares a `HEALTHCHECK` hitting `/health`. The entrypoint runs the
server as PID 1 via `exec`, so `docker stop` (SIGTERM) triggers graceful
shutdown.

---

## 5. Run without Docker

Build once, then run:

```bash
pnpm run build:headless          # builds out/main/server.js + out/renderer-web
pnpm run start:server:headless   # serves the web UI on 127.0.0.1:3773
```

`start:server:headless` runs the server via the Electron binary in
`ELECTRON_RUN_AS_NODE` mode (no GUI). For a network-exposed deployment set the
env vars from §2 (e.g. `HIVE_SERVER_HOST=0.0.0.0`, TLS paths, owner token).

### systemd unit (Linux)

`/etc/systemd/system/hive-backend.service`:

```ini
[Unit]
Description=Hive backend (headless)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hive
Group=hive
WorkingDirectory=/opt/hive
Environment=HIVE_HEADLESS=1
Environment=HIVE_SERVER_MODE=browser
Environment=HIVE_SERVER_HOST=0.0.0.0
Environment=HIVE_SERVER_PORT=3773
Environment=HIVE_SERVER_REQUIRE_AUTH=true
Environment=HIVE_SERVER_BASE_DIR=/var/lib/hive
Environment=HIVE_SERVER_STATIC_DIR=/opt/hive/out/renderer-web
Environment=HIVE_SERVER_TLS_CERT=/etc/hive/certs/fullchain.pem
Environment=HIVE_SERVER_TLS_KEY=/etc/hive/certs/privkey.pem
Environment=ELECTRON_RUN_AS_NODE=1
# Secrets: keep out of the unit file. Use an EnvironmentFile with 0600 perms.
EnvironmentFile=-/etc/hive/hive-backend.env
ExecStart=/usr/bin/node /opt/hive/out/main/server.js
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

`/etc/hive/hive-backend.env` (mode `0600`, owned by `hive`):

```
HIVE_OWNER_TOKEN=<64-hex-chars>
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hive-backend
journalctl -u hive-backend -f
```

### launchd plist (macOS)

`~/Library/LaunchAgents/io.hive.backend.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.hive.backend</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/opt/hive/out/main/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/opt/hive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HIVE_HEADLESS</key><string>1</string>
    <key>HIVE_SERVER_MODE</key><string>browser</string>
    <key>HIVE_SERVER_HOST</key><string>127.0.0.1</string>
    <key>HIVE_SERVER_PORT</key><string>3773</string>
    <key>HIVE_SERVER_BASE_DIR</key><string>/Users/Shared/hive</string>
    <key>HIVE_SERVER_STATIC_DIR</key><string>/opt/hive/out/renderer-web</string>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
    <!-- Set HIVE_OWNER_TOKEN here or via a wrapper that reads it from Keychain. -->
  </dict>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/Users/Shared/hive/logs/backend.out.log</string>
  <key>StandardErrorPath</key><string>/Users/Shared/hive/logs/backend.err.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/io.hive.backend.plist
launchctl list | grep io.hive.backend
```

`launchctl` sends `SIGTERM` on unload/stop, which triggers graceful shutdown.

---

## 6. How a client connects (owner token → wss)

The web/mobile client authenticates with the **owner token** and then upgrades to
the WebSocket RPC channel:

1. **Discover** the connection descriptor:
   `GET /.well-known/hive/environment` → `httpBaseUrl`, `wsBaseUrl`,
   `hasOwnerToken`.
2. **Exchange** the owner token for an auth session:
   `POST /api/auth/owner-exchange` with `{ "token": "<HIVE_OWNER_TOKEN>" }`
   → returns an `AuthSession` (access token).
3. **Mint a WS token** using the access token:
   `POST /api/auth/ws-token` (Authorization: Bearer `<accessToken>`)
   → `{ "webSocketToken": "…" }`.
4. **Connect** to `wsBaseUrl` (e.g. `wss://host:3773/ws`), presenting the
   WebSocket token. All RPC traffic flows over this socket.

Over the network this is always `https`/`wss` (TLS enforced by the startup
invariants in §2). On loopback with auth disabled, a browser may connect to
`ws://127.0.0.1:3773/ws` without a token.

Generate an owner token with e.g. `openssl rand -hex 32` and pass it via
`HIVE_OWNER_TOKEN`. Treat it as a password: it grants full access.
