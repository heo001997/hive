// The bootstrap -> ws-token handshake, extracted from
// src/renderer/src/api/hive-client.ts (`createWebSocketTokenProvider`) and
// de-DOM'd. Given an HTTP base URL and a bootstrap token, it produces a
// `webSocketTokenProvider` for `WsTransport`:
//
//   POST {httpBaseUrl}/api/auth/bootstrap { bootstrapToken } -> { session: { accessToken } }
//   POST {httpBaseUrl}/api/auth/ws-token  (Authorization: Bearer <accessToken>)
//                                          -> { webSocketToken: { token } }   (short TTL)
//
// The long-lived session access token is cached in an injected `TokenStore`; a
// FRESH ws-token is minted on every connect (mirroring the renderer). On a
// ws-token failure the store is cleared so the next connect re-bootstraps.

import { resolveFetch } from './globals'
import type { TokenStore } from './token-store'
import type { FetchLike } from './types'

export interface HandshakeConfig {
  readonly httpBaseUrl: string
  readonly bootstrapToken: string
  readonly tokenStore: TokenStore
  readonly fetchImpl?: FetchLike
}

interface AuthSession {
  readonly accessToken: string
}

interface BootstrapResponse {
  readonly session: AuthSession
}

interface WebSocketTokenResponse {
  readonly webSocketToken: {
    readonly token: string
  }
}

export const createWebSocketTokenProvider = (
  config: HandshakeConfig
): (() => Promise<string | null>) => {
  const { httpBaseUrl, bootstrapToken, tokenStore } = config
  const doFetch = resolveFetch(config.fetchImpl)

  const getAccessToken = async (): Promise<string> => {
    const cached = await tokenStore.get()
    if (cached) return cached

    const response = await doFetch(`${httpBaseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken })
    })
    if (!response.ok) throw new Error('Failed to authenticate Hive backend session')
    const body = (await response.json()) as BootstrapResponse
    await tokenStore.set(body.session.accessToken)
    return body.session.accessToken
  }

  return async () => {
    const accessToken = await getAccessToken()
    const response = await doFetch(`${httpBaseUrl}/api/auth/ws-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    if (!response.ok) {
      await tokenStore.clear()
      throw new Error('Failed to issue Hive WebSocket token')
    }

    const body = (await response.json()) as WebSocketTokenResponse
    return body.webSocketToken.token
  }
}
