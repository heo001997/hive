// Platform-neutral Hive RPC client. Extracted from
// src/renderer/src/api/hive-client.ts. The renderer's `environment.ts`
// (window / import.meta.env / window.location resolution + desktop bridge) is
// GONE — every target detail is injected via `ClientConfig`, so the same client
// runs in the browser, Node and React Native.

import { createWebSocketTokenProvider } from './handshake'
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
  /** fetch implementation for the handshake. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: FetchLike
  /**
   * Override the WS-token provider entirely (e.g. a host that mints tokens by
   * some other means). When set, `httpBaseUrl` / `bootstrapToken` are ignored.
   */
  readonly webSocketTokenProvider?: () => Promise<string | null>
  readonly idFactory?: () => string
  readonly reconnectDelayMs?: number
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
  if (!config.httpBaseUrl || !config.bootstrapToken) return undefined
  return createWebSocketTokenProvider({
    httpBaseUrl: config.httpBaseUrl,
    bootstrapToken: config.bootstrapToken,
    tokenStore,
    fetchImpl: config.fetchImpl
  })
}
