// The bootstrap -> ws-token handshake, extracted from
// src/renderer/src/api/hive-client.ts (`createWebSocketTokenProvider`) and
// de-DOM'd. Given an HTTP base URL and a bootstrap token, it produces a
// `webSocketTokenProvider` for `WsTransport`:
//
//   POST {httpBaseUrl}/api/auth/bootstrap { bootstrapToken } -> { session: { accessToken } }
//   POST {httpBaseUrl}/api/auth/ws-token  (Authorization: Bearer <accessToken>)
//                                          -> { webSocketToken: { token } }   (short TTL)
//
// The OWNER-TOKEN variant (`createOwnerTokenWebSocketTokenProvider`) is identical
// except the first leg hits `/api/auth/owner-exchange { ownerToken }` — the
// durable single-owner credential a hosted/off-machine web client presents. Both
// mint a FRESH ws-token on every connect from the same cached session token, so
// everything downstream (ws-token, ws upgrade) is shared and unchanged.
//
// The long-lived session access token is cached in an injected `TokenStore`; a
// FRESH ws-token is minted on every connect (mirroring the renderer). On a
// ws-token failure the store is cleared so the next connect re-authenticates.

import { resolveFetch } from './globals'
import type { TokenStore } from './token-store'
import type { FetchLike, FetchResponseLike } from './types'

export interface HandshakeConfig {
  readonly httpBaseUrl: string
  readonly bootstrapToken: string
  readonly tokenStore: TokenStore
  readonly fetchImpl?: FetchLike
}

export interface OwnerHandshakeConfig {
  readonly httpBaseUrl: string
  readonly ownerToken: string
  readonly tokenStore: TokenStore
  readonly fetchImpl?: FetchLike
}

interface AuthSession {
  readonly accessToken: string
}

interface AuthExchangeResponse {
  readonly session: AuthSession
}

interface WebSocketTokenResponse {
  readonly webSocketToken: {
    readonly token: string
  }
}

/**
 * Which handshake leg produced an `OwnerAuthError`. Only the FIRST leg
 * (`owner-exchange`) ever raises one: the durable owner credential itself was
 * rejected, which is not recoverable by retrying — terminal (the web client
 * clears the token and returns to the login gate). A ws-token 401/403 is never
 * terminal for either provider — `createProvider` self-heals it by re-minting the
 * session first. The `ws-token` member is retained only for back-compat of the
 * exported type; nothing raises it.
 */
export type OwnerAuthPhase = 'owner-exchange' | 'ws-token'

/**
 * Raised when a handshake leg rejects the presented credential. `status`
 * distinguishes 401 (wrong token) from 403 (owner auth not configured) so a login
 * UI can message accordingly. `phase` records which leg rejected. Never carries
 * the token itself.
 */
export class OwnerAuthError extends Error {
  readonly status: number
  readonly phase: OwnerAuthPhase

  constructor(status: number, message = 'Owner token rejected', phase: OwnerAuthPhase = 'owner-exchange') {
    super(message)
    this.name = 'OwnerAuthError'
    this.status = status
    this.phase = phase
  }
}

// True for a TERMINAL auth rejection (a 401/403 carried by an `OwnerAuthError`):
// the presented credential is known-bad, so auto-reconnecting is futile. Any
// other failure — a 5xx, a network error, a generic `Error` — is transient and
// stays eligible for reconnect.
//
// Only the owner (web) first leg (`exchangeOwnerToken`) ever raises an
// `OwnerAuthError`, so this is effectively "true only for an owner-exchange
// 401/403" — the one case with a recovery path (clear token, return to login).
// A ws-token 401/403 self-heals for both providers (re-mint the session, retry
// once) and never reaches here. The desktop bootstrap first leg throws a generic
// (transient) Error, so desktop never latches terminal — it keeps reconnecting
// and re-bootstrapping, its historical behaviour.
export const isAuthError = (error: unknown): boolean =>
  error instanceof OwnerAuthError && (error.status === 401 || error.status === 403)

// POST /api/auth/owner-exchange { ownerToken } -> session access token.
// Exported so a login screen can validate a token (and surface 401/403) before
// persisting it, without standing up a full client. The owner token is only ever
// sent in the request body — never logged, never placed in the error.
export const exchangeOwnerToken = async (
  httpBaseUrl: string,
  ownerToken: string,
  fetchImpl?: FetchLike
): Promise<string> => {
  const doFetch = resolveFetch(fetchImpl)
  const response = await doFetch(`${httpBaseUrl}/api/auth/owner-exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerToken })
  })
  if (!response.ok) {
    throw new OwnerAuthError(response.status, 'Failed to authenticate Hive owner session')
  }
  const body = (await response.json()) as AuthExchangeResponse
  return body.session.accessToken
}

// Shared ws-token minting: cache the session token via `getAccessToken`, then
// exchange it for a short-TTL ws-token on every connect. Clears the store on a
// ws-token failure so the next connect re-runs the first leg.
const createProvider = (
  httpBaseUrl: string,
  tokenStore: TokenStore,
  doFetch: FetchLike,
  fetchAccessToken: () => Promise<string>
): (() => Promise<string | null>) => {
  const getAccessToken = async (forceRefresh = false): Promise<string> => {
    if (!forceRefresh) {
      const cached = await tokenStore.get()
      if (cached) return cached
    }

    const accessToken = await fetchAccessToken()
    await tokenStore.set(accessToken)
    return accessToken
  }

  const mintWsToken = (accessToken: string): Promise<FetchResponseLike> =>
    doFetch(`${httpBaseUrl}/api/auth/ws-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` }
    })

  const readWsToken = async (response: FetchResponseLike): Promise<string> => {
    const body = (await response.json()) as WebSocketTokenResponse
    return body.webSocketToken.token
  }

  return async () => {
    const accessToken = await getAccessToken()
    const response = await mintWsToken(accessToken)
    if (response.ok) return readWsToken(response)

    const rejectedAuth = response.status === 401 || response.status === 403

    // A ws-token 401/403 is normally RECOVERABLE for BOTH providers: the
    // short-lived access token expired, or the server restarted and dropped its
    // in-memory sessions — while the durable first-leg credential (owner token /
    // desktop bootstrap token) is still valid and just needs the session
    // re-minted. Invalidate the cached access token, re-run the first leg to mint
    // a fresh one, and retry the ws-token ONCE. Terminal-vs-transient is decided
    // by the first leg's OWN throw type, so each provider keeps its semantics:
    //  - If the re-exchange rejects the credential, `fetchAccessToken` throws:
    //    owner-exchange -> an `OwnerAuthError` (401/403) that IS terminal (the
    //    owner token is bad/rotated -> web bounces to login); desktop bootstrap ->
    //    a generic Error that is TRANSIENT (desktop has no login gate and must keep
    //    reconnecting, its historical behaviour).
    //  - If the ws-token still fails after a SUCCESSFUL fresh session, it is not a
    //    credential problem we can fix here — throw a generic (transient) error so
    //    the transport keeps reconnecting with backoff. Never terminal.
    if (rejectedAuth) {
      await tokenStore.clear()
      const freshAccessToken = await getAccessToken(true)
      const retry = await mintWsToken(freshAccessToken)
      if (retry.ok) return readWsToken(retry)
      await tokenStore.clear()
      throw new Error('Failed to issue Hive WebSocket token')
    }

    // Non-auth failure (5xx / etc): drop the cached session token so the next
    // connect re-runs the first leg, and stay transient (keep reconnecting).
    await tokenStore.clear()
    throw new Error('Failed to issue Hive WebSocket token')
  }
}

export const createWebSocketTokenProvider = (
  config: HandshakeConfig
): (() => Promise<string | null>) => {
  const { httpBaseUrl, bootstrapToken, tokenStore } = config
  const doFetch = resolveFetch(config.fetchImpl)

  return createProvider(
    httpBaseUrl,
    tokenStore,
    doFetch,
    async () => {
      const response = await doFetch(`${httpBaseUrl}/api/auth/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bootstrapToken })
      })
      if (!response.ok) throw new Error('Failed to authenticate Hive backend session')
      const body = (await response.json()) as AuthExchangeResponse
      return body.session.accessToken
    }
  )
}

// Owner-token counterpart to `createWebSocketTokenProvider`, for a hosted web
// client that has no local desktop bootstrap file. The durable owner token is
// captured in the closure and only ever sent to `/api/auth/owner-exchange`.
export const createOwnerTokenWebSocketTokenProvider = (
  config: OwnerHandshakeConfig
): (() => Promise<string | null>) => {
  const { httpBaseUrl, ownerToken, tokenStore } = config
  const doFetch = resolveFetch(config.fetchImpl)

  return createProvider(
    httpBaseUrl,
    tokenStore,
    doFetch,
    () => exchangeOwnerToken(httpBaseUrl, ownerToken, doFetch)
  )
}
