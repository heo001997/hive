// @hive/client integration for React Native.
//
// This module builds a `HiveClient` wired for a hosted / off-machine mobile
// client using the OWNER-TOKEN handshake (Decision B): the app has no local
// desktop bootstrap file, so it authenticates by presenting the durable owner
// token to `/api/auth/owner-exchange`, and `@hive/client` re-mints a fresh
// short-TTL ws-token from the cached session on every (re)connect.
//
// Everything platform-specific is INJECTED so the SDK stays DOM/Node-free:
//   - `webSocketImpl: WebSocket` — React Native's global WebSocket.
//   - `fetchImpl: fetch`        — React Native's global fetch.
//   - `tokenStore`              — AsyncStorage-backed session-token cache.
//
// The owner token is captured only inside the SDK's handshake closure and this
// module never logs it.

import {
  HiveClient,
  exchangeOwnerToken,
  isAuthError,
  type ClientConfig
} from '@hive/client'

import { createSessionTokenStore, type ServerEndpoints } from './tokenStore'

// RN provides global WebSocket and fetch. Capture them once; they satisfy the
// structural `WebSocketImpl` / `FetchLike` contracts @hive/client expects.
const RNWebSocket = WebSocket as unknown as ClientConfig['webSocketImpl']
const RNFetch = fetch as unknown as ClientConfig['fetchImpl']

/**
 * Normalise a user-entered server URL into the http + ws base URLs the
 * handshake and transport need.
 *
 * We first try the backend's discovery document
 * (`GET /.well-known/hive/environment`), which returns authoritative
 * `httpBaseUrl` / `wsBaseUrl` (same source the shipped `hive` CLI uses). If it
 * is unreachable or lacks a ws URL, we derive one: strip a trailing slash, and
 * map `http(s)://host:port` -> `ws(s)://host:port/ws`.
 */
export async function resolveServerEndpoints(rawUrl: string): Promise<ServerEndpoints> {
  const trimmed = rawUrl.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('Server URL is required.')

  // The owner token is a root secret sent to /api/auth/owner-exchange, so a bare
  // host defaults to HTTPS (never a silent plaintext downgrade). A user who
  // explicitly types http:// (e.g. a loopback dev backend) is respected as-is.
  const httpBaseUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    const res = await fetch(`${httpBaseUrl}/.well-known/hive/environment`)
    if (res.ok) {
      const body = (await res.json()) as {
        httpBaseUrl?: string
        wsBaseUrl?: string
      }
      if (typeof body.wsBaseUrl === 'string' && body.wsBaseUrl) {
        return {
          httpBaseUrl: body.httpBaseUrl || httpBaseUrl,
          wsBaseUrl: body.wsBaseUrl
        }
      }
    }
  } catch {
    // Discovery unreachable (e.g. a proxy that doesn't expose it) — fall through
    // to deriving the ws URL from the http URL.
  }

  const wsBaseUrl = `${httpBaseUrl.replace(/^http/i, 'ws')}/ws`
  return { httpBaseUrl, wsBaseUrl }
}

/**
 * Validate an owner token against a server WITHOUT standing up a full client,
 * surfacing a 401 (wrong token) / 403 (owner auth not configured) so the login
 * screen can message accordingly. Returns nothing on success; throws otherwise.
 */
export async function validateOwnerToken(
  httpBaseUrl: string,
  ownerToken: string
): Promise<void> {
  // Throws OwnerAuthError(status) on rejection; the access token itself is
  // discarded here — we only care that the exchange succeeded.
  await exchangeOwnerToken(httpBaseUrl, ownerToken, RNFetch)
}

export interface BuildClientArgs {
  readonly endpoints: ServerEndpoints
  readonly ownerToken: string
  /**
   * Fired once on a TERMINAL owner-auth failure (the owner token was rotated /
   * revoked). The host clears credentials and returns to Login.
   */
  readonly onAuthError: (error: unknown) => void
}

/** Construct a connected-on-first-request `HiveClient` for the mobile app. */
export function buildHiveClient(args: BuildClientArgs): HiveClient {
  const config: ClientConfig = {
    baseUrl: args.endpoints.wsBaseUrl,
    httpBaseUrl: args.endpoints.httpBaseUrl,
    ownerToken: args.ownerToken,
    webSocketImpl: RNWebSocket,
    fetchImpl: RNFetch,
    tokenStore: createSessionTokenStore(),
    onAuthError: args.onAuthError,
    // A mobile link is flaky: opt into the request backstop (disabled by default
    // in the shared SDK) so a reply that never arrives on a half-open socket
    // rejects instead of hanging the UI forever.
    requestTimeoutMs: 30000
  }
  return new HiveClient(config)
}

export { isAuthError }
