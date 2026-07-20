// Platform-neutral WebSocket RPC transport. Extracted from
// src/renderer/src/api/ws-transport.ts and de-DOM'd: the WebSocket
// implementation is INJECTED (constructor arg / options) rather than pulled from
// the DOM `WebSocket` global, and the request-id factory no longer assumes a
// `crypto` global. Behaviour (pending-request matching, subscription replay,
// reconnect with backoff, token query-param) is preserved verbatim.

import type {
  RpcRequest,
  RpcResponse,
  ServerEvent,
  SubscriptionRequest,
  WebSocketSubscribeMessage,
  WebSocketUnsubscribeMessage
} from './protocol'
import type { WebSocketImpl, WebSocketLike } from './types'
import { createDefaultIdFactory, resolveWebSocketImpl } from './globals'

export type ServerEventListener = (event: ServerEvent) => void

export interface WsTransportOptions {
  /** WebSocket implementation. Defaults to `globalThis.WebSocket` when present. */
  readonly webSocketImpl?: WebSocketImpl
  readonly idFactory?: () => string
  readonly webSocketTokenProvider?: () => Promise<string | null>
  readonly reconnectDelayMs?: number
  /**
   * Per-request reply timeout in ms. `<= 0` (the default) disables the backstop
   * and waits indefinitely — the historical renderer behaviour. Callers that
   * want the backstop (e.g. mobile/web on a flaky link) opt in with a positive
   * value.
   */
  readonly requestTimeoutMs?: number
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout> | null
}

interface ActiveSubscription {
  readonly listeners: Set<ServerEventListener>
  readonly request: SubscriptionRequest
}

export class WsTransport {
  private socket: WebSocketLike | null = null
  private connectPromise: Promise<WebSocketLike> | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Map<string, ActiveSubscription>()
  private readonly webSocketImpl: WebSocketImpl
  private readonly idFactory: () => string
  private readonly webSocketTokenProvider?: () => Promise<string | null>
  private readonly reconnectDelayMs: number
  private readonly requestTimeoutMs: number
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(
    private readonly wsBaseUrl: string,
    options: WsTransportOptions = {}
  ) {
    this.webSocketImpl = resolveWebSocketImpl(options.webSocketImpl)
    this.idFactory = options.idFactory ?? createDefaultIdFactory()
    this.webSocketTokenProvider = options.webSocketTokenProvider
    this.reconnectDelayMs = options.reconnectDelayMs ?? 250
    this.requestTimeoutMs = options.requestTimeoutMs ?? 0
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const socket = await this.connect()
    const id = this.idFactory()
    const request: RpcRequest = { id, method, params }

    // Optional backstop: an OPEN socket that never replies would otherwise hang
    // this promise forever and leak the pending entry. When requestTimeoutMs is
    // positive we reject after the timeout and drop the entry (mirrors the CLI
    // copy's rpc() backstop); when it is <= 0 we wait indefinitely, preserving
    // the historical renderer behaviour so a legitimately slow op is not killed.
    const response = new Promise<unknown>((resolve, reject) => {
      const timer =
        this.requestTimeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(
                new Error(`Hive RPC timeout: ${method} got no reply in ${this.requestTimeoutMs}ms`)
              )
            }, this.requestTimeoutMs)
          : null
      this.pending.set(id, { resolve, reject, timer })
    })
    socket.send(JSON.stringify(request))
    return response
  }

  subscribe(
    channel: string,
    listener: ServerEventListener,
    request: Partial<Omit<SubscriptionRequest, 'channel'>> = {}
  ): () => void {
    let subscription = this.eventListeners.get(channel)
    this.closed = false
    if (!subscription) {
      subscription = {
        listeners: new Set(),
        request: {
          channel,
          ...request
        }
      }
      this.eventListeners.set(channel, subscription)
    }
    subscription.listeners.add(listener)

    if (subscription.listeners.size === 1) this.sendSubscribe(subscription.request)
    void this.connect().catch(() => undefined)

    return () => {
      subscription?.listeners.delete(listener)
      if (subscription?.listeners.size === 0) {
        this.eventListeners.delete(channel)
        this.sendUnsubscribe(channel)
      }
    }
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.rejectPending(new Error('Hive WebSocket transport closed'))
    this.socket?.close()
    this.socket = null
    this.connectPromise = null
  }

  private connect(): Promise<WebSocketLike> {
    if (this.socket && this.socket.readyState === this.webSocketImpl.OPEN) {
      return Promise.resolve(this.socket)
    }
    if (this.connectPromise) return this.connectPromise

    const openSocket = (webSocketUrl: string): Promise<WebSocketLike> =>
      new Promise<WebSocketLike>((resolve, reject) => {
        const socket = new this.webSocketImpl(webSocketUrl)
        let opened = false
        this.socket = socket

        socket.addEventListener('open', () => {
          opened = true
          this.connectPromise = null
          this.sendSubscriptions(socket)
          resolve(socket)
        })

        socket.addEventListener('message', (event) => {
          this.handleMessage(event.data)
        })

        socket.addEventListener('close', () => {
          if (this.socket === socket) this.socket = null
          if (!opened && this.connectPromise) {
            this.connectPromise = null
            reject(new Error(`Hive WebSocket closed before connecting at ${webSocketUrl}`))
          }
          this.connectPromise = null
          this.rejectPending(new Error('Hive WebSocket connection closed'))
          this.scheduleReconnect()
        })

        socket.addEventListener('error', () => {
          const error = new Error(`Failed to connect Hive WebSocket at ${this.wsBaseUrl}`)
          if (this.connectPromise) {
            this.connectPromise = null
            reject(error)
          }
          this.rejectPending(error)
        })
      })

    const webSocketUrl = this.createWebSocketUrl()
    const connectPromise =
      typeof webSocketUrl === 'string' ? openSocket(webSocketUrl) : webSocketUrl.then(openSocket)
    this.connectPromise = connectPromise.catch((error) => {
      this.connectPromise = null
      // The rejection fired before any socket was constructed (e.g. the token
      // handshake fetch threw because the backend was down at startup), so no
      // 'close' event will ever arm the reconnect. Arm it here instead so the
      // subscription recovers once the backend returns. scheduleReconnect()
      // guards against double-arming and the closed / no-listener cases.
      if (!this.socket) this.scheduleReconnect()
      throw error
    })

    return this.connectPromise
  }

  private createWebSocketUrl(): string | Promise<string> {
    if (!this.webSocketTokenProvider) return this.wsBaseUrl

    return this.webSocketTokenProvider().then((token) => {
      if (!token) return this.wsBaseUrl

      const url = new URL(this.wsBaseUrl)
      url.searchParams.set('token', token)
      return url.toString()
    })
  }

  private handleMessage(raw: unknown): void {
    const message = JSON.parse(String(raw)) as RpcResponse | ServerEvent
    if ('id' in message) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (pending.timer) clearTimeout(pending.timer)

      if (message.ok) {
        pending.resolve(message.value)
      } else {
        const error = new Error(message.error.message) as Error & { details?: unknown }
        error.name = message.error.code
        error.details = message.error.details
        pending.reject(error)
      }
      return
    }

    const subscription = this.eventListeners.get(message.channel)
    if (!subscription) return
    for (const listener of subscription.listeners) listener(message)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private scheduleReconnect(): void {
    if (this.closed || this.eventListeners.size === 0 || this.reconnectTimer) return

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closed || this.eventListeners.size === 0) return

      void this.connect().catch(() => {
        this.scheduleReconnect()
      })
    }, this.reconnectDelayMs)
  }

  private sendSubscriptions(socket: WebSocketLike): void {
    for (const subscription of this.eventListeners.values()) {
      socket.send(JSON.stringify(toSubscribeMessage(subscription.request)))
    }
  }

  private sendSubscribe(request: SubscriptionRequest): void {
    if (this.socket?.readyState === this.webSocketImpl.OPEN) {
      this.socket.send(JSON.stringify(toSubscribeMessage(request)))
    }
  }

  private sendUnsubscribe(channel: string): void {
    if (this.socket?.readyState === this.webSocketImpl.OPEN) {
      const message: WebSocketUnsubscribeMessage = { type: 'unsubscribe', channel }
      this.socket.send(JSON.stringify(message))
    }
  }
}

const toSubscribeMessage = (request: SubscriptionRequest): WebSocketSubscribeMessage => ({
  type: 'subscribe',
  ...request
})
