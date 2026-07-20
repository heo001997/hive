// Platform-neutral Hive RPC client. Extracted from
// src/renderer/src/api/hive-client.ts. The renderer's `environment.ts`
// (window / import.meta.env / window.location resolution + desktop bridge) is
// GONE — every target detail is injected via `ClientConfig`, so the same client
// runs in the browser, Node and React Native.

import {
  createOwnerTokenWebSocketTokenProvider,
  createWebSocketTokenProvider
} from './handshake'
import { MemoryTokenStore, type TokenStore } from './token-store'
import type { FetchLike, WebSocketImpl } from './types'
import { WsTransport, type ServerEventListener, type WsTransportOptions } from './ws-transport'
import type { SubscriptionRequest } from './protocol'

export interface ClientConfig {
  /** WebSocket base URL, e.g. `ws://127.0.0.1:3773/ws` (a `/ws` path). */
  readonly baseUrl: string
  /**
   * WebSocket implementation to construct. Defaults to `globalThis.WebSocket`
   * (browser / Node >=22 / RN). Injecting it keeps this SDK DOM-free.
   */
  readonly webSocketImpl?: WebSocketImpl
  /** Session-token cache for the bootstrap handshake. Defaults to in-memory. */
  readonly tokenStore?: TokenStore
  /**
   * HTTP base URL for the auth handshake. Required together with
   * `bootstrapToken` for an authenticated (desktop) backend. Omit both for a
   * token-less dev server (HIVE_SERVER_REQUIRE_AUTH=false).
   */
  readonly httpBaseUrl?: string
  readonly bootstrapToken?: string | null
  /**
   * Durable single-owner credential for a hosted/off-machine web client with no
   * local desktop bootstrap file. Set together with `httpBaseUrl` to
   * authenticate via `/api/auth/owner-exchange` instead of `/api/auth/bootstrap`.
   * Treated as a root secret: cached only via `tokenStore`, never logged.
   */
  readonly ownerToken?: string | null
  /** fetch implementation for the handshake. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: FetchLike
  /**
   * Override the WS-token provider entirely (e.g. a host that mints tokens by
   * some other means). When set, `httpBaseUrl` / `bootstrapToken` /
   * `ownerToken` are ignored.
   */
  readonly webSocketTokenProvider?: () => Promise<string | null>
  readonly idFactory?: () => string
  /** Base reconnect delay in ms; backoff doubles from here up to the cap. Defaults to 250. */
  readonly reconnectDelayMs?: number
  /** Upper bound for the exponential reconnect backoff, in ms. Defaults to 30000. */
  readonly maxReconnectDelayMs?: number
  /**
   * Invoked once on a TERMINAL auth failure (401/403 from the owner-exchange or
   * ws-token handshake). Auto-reconnect is stopped first; the host uses this to
   * re-authenticate (e.g. clear stored creds + return to a login gate). Transient
   * / network / 5xx failures keep reconnecting and never fire this.
   */
  readonly onAuthError?: (error: unknown) => void
  /** Per-request reply timeout in ms before `request()` rejects. Defaults to 30000. */
  readonly requestTimeoutMs?: number
}

export class HiveClient {
  private readonly transport: WsTransport

  constructor(config: ClientConfig) {
    const tokenStore = config.tokenStore ?? new MemoryTokenStore()
    const transportOptions: WsTransportOptions = {
      webSocketImpl: config.webSocketImpl,
      idFactory: config.idFactory,
      reconnectDelayMs: config.reconnectDelayMs,
      maxReconnectDelayMs: config.maxReconnectDelayMs,
      onAuthError: config.onAuthError,
      requestTimeoutMs: config.requestTimeoutMs,
      webSocketTokenProvider: resolveTokenProvider(config, tokenStore)
    }
    this.transport = new WsTransport(config.baseUrl, transportOptions)
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.transport.request(method, params) as Promise<T>
  }

  subscribe(channel: string, listener: ServerEventListener): () => void
  subscribe(
    channel: string,
    params: Partial<Omit<SubscriptionRequest, 'channel'>>,
    listener: ServerEventListener
  ): () => void
  subscribe(
    channel: string,
    paramsOrListener: Partial<Omit<SubscriptionRequest, 'channel'>> | ServerEventListener,
    maybeListener?: ServerEventListener
  ): () => void {
    if (typeof paramsOrListener === 'function') {
      return this.transport.subscribe(channel, paramsOrListener)
    }

    return this.transport.subscribe(channel, maybeListener as ServerEventListener, paramsOrListener)
  }

  close(): void {
    this.transport.close()
  }
}

/** Convenience factory — identical to `new HiveClient(config)`. */
export const createHiveClient = (config: ClientConfig): HiveClient => new HiveClient(config)

const resolveTokenProvider = (
  config: ClientConfig,
  tokenStore: TokenStore
): (() => Promise<string | null>) | undefined => {
  if (config.webSocketTokenProvider) return config.webSocketTokenProvider
  if (!config.httpBaseUrl) return undefined
  // Owner-token (hosted web) path takes precedence over the desktop bootstrap
  // token when both happen to be present.
  if (config.ownerToken) {
    return createOwnerTokenWebSocketTokenProvider({
      httpBaseUrl: config.httpBaseUrl,
      ownerToken: config.ownerToken,
      tokenStore,
      fetchImpl: config.fetchImpl
    })
  }
  if (!config.bootstrapToken) return undefined
  return createWebSocketTokenProvider({
    httpBaseUrl: config.httpBaseUrl,
    bootstrapToken: config.bootstrapToken,
    tokenStore,
    fetchImpl: config.fetchImpl
  })
}
