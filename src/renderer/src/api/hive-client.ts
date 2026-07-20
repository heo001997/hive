// Thin adapter over the platform-neutral @hive/client SDK.
//
// The transport, bootstrap handshake and RPC client all live in @hive/client
// now. This module keeps the historical renderer surface so nothing downstream
// has to change:
//   - `createHiveClient()` still resolves the backend target via environment.ts
//     (desktop bridge / Vite env / window.location) and returns a ready client.
//   - the `HiveClient(target, options)` constructor is preserved (a test and the
//     renderer both rely on the two-arg `BackendTarget` + options shape), mapping
//     those inputs onto @hive/client's `ClientConfig`.
import {
  HiveClient as CoreHiveClient,
  type ClientConfig,
  type ServerEventListener,
  type SubscriptionRequest
} from '@hive/client'
import {
  backendTargetToClientConfig,
  resolveBackendTarget,
  type BackendTarget
} from './environment'

export interface HiveClientOptions {
  readonly target: BackendTarget
  readonly WebSocketCtor?: typeof WebSocket
  readonly idFactory?: () => string
  readonly webSocketTokenProvider?: () => Promise<string | null>
  readonly reconnectDelayMs?: number
  readonly fetch?: typeof fetch
  /** Per-request reply timeout in ms. `<= 0` / omitted waits indefinitely. */
  readonly requestTimeoutMs?: number
}

export class HiveClient {
  private readonly core: CoreHiveClient

  constructor(
    readonly target: BackendTarget,
    options: Omit<HiveClientOptions, 'target'> = {}
  ) {
    const config: ClientConfig = {
      ...backendTargetToClientConfig(target),
      webSocketImpl: options.WebSocketCtor as unknown as ClientConfig['webSocketImpl'],
      fetchImpl: options.fetch as unknown as ClientConfig['fetchImpl'],
      idFactory: options.idFactory,
      reconnectDelayMs: options.reconnectDelayMs,
      requestTimeoutMs: options.requestTimeoutMs,
      webSocketTokenProvider: options.webSocketTokenProvider
    }
    this.core = new CoreHiveClient(config)
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.core.request<T>(method, params)
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
      return this.core.subscribe(channel, paramsOrListener)
    }

    return this.core.subscribe(channel, paramsOrListener, maybeListener as ServerEventListener)
  }

  close(): void {
    this.core.close()
  }
}

export const createHiveClient = async (
  options: Omit<HiveClientOptions, 'target'> = {}
): Promise<HiveClient> => new HiveClient(await resolveBackendTarget(), options)
