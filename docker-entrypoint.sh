#!/bin/sh
# Entrypoint for the headless Hive backend service.
#
# Runs as PID 1 and `exec`s the server so SIGTERM/SIGINT from the orchestrator
# reach Node directly and trigger bin.ts's graceful shutdown (close WS + HTTP,
# flush, exit 0). Do NOT background the process or wrap it in a subshell.
set -eu

# Map the alternate Claude OAuth token env name the agent SDK expects.
if [ -n "${CLAUDE_OAUTH_TOKEN:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_OAUTH_TOKEN"
fi

# Ensure the persistent data dir exists (it is a mounted volume; the SQLite DB,
# attachments and logs live under it).
DATA_DIR="${HIVE_SERVER_BASE_DIR:-/data}"
mkdir -p "$DATA_DIR"

# TLS material must be provided as a matched pair. Fail fast on a half-configured
# pair rather than silently falling back to plain http.
if { [ -n "${HIVE_SERVER_TLS_CERT:-}" ] && [ -z "${HIVE_SERVER_TLS_KEY:-}" ]; } ||
   { [ -z "${HIVE_SERVER_TLS_CERT:-}" ] && [ -n "${HIVE_SERVER_TLS_KEY:-}" ]; }; then
  echo "hive-entrypoint: HIVE_SERVER_TLS_CERT and HIVE_SERVER_TLS_KEY must both be set (or both unset)" >&2
  exit 1
fi
if [ -n "${HIVE_SERVER_TLS_CERT:-}" ] && [ ! -r "${HIVE_SERVER_TLS_CERT}" ]; then
  echo "hive-entrypoint: TLS cert not readable: ${HIVE_SERVER_TLS_CERT}" >&2
  exit 1
fi
if [ -n "${HIVE_SERVER_TLS_KEY:-}" ] && [ ! -r "${HIVE_SERVER_TLS_KEY}" ]; then
  echo "hive-entrypoint: TLS key not readable: ${HIVE_SERVER_TLS_KEY}" >&2
  exit 1
fi

# Warn (do not fail) when auth is required but no owner token is present — a
# minted (hashed) token may already live in the mounted DB, so this is advisory.
if [ "${HIVE_SERVER_REQUIRE_AUTH:-true}" != "false" ] && [ "${HIVE_SERVER_REQUIRE_AUTH:-true}" != "0" ] &&
   [ -z "${HIVE_OWNER_TOKEN:-}" ]; then
  echo "hive-entrypoint: auth is required but HIVE_OWNER_TOKEN is not set; ensure an owner token has been minted, otherwise remote clients cannot authenticate" >&2
fi

exec "$@"
