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
import { isAuthError } from './handshake'

export type ServerEventListener = (event: ServerEvent) => void

export interface WsTransportOptions {
  /** WebSocket implementation. Defaults to `globalThis.WebSocket` when present. */
  readonly webSocketImpl?: WebSocketImpl
  readonly idFactory?: () => string
  readonly webSocketTokenProvider?: () => Promise<string | null>
  /**
   * Base reconnect delay in ms. Reconnect uses exponential backoff starting here
   * and doubling each attempt up to `maxReconnectDelayMs`, reset to this base on a
   * successful open. Defaults to 250ms.
   */
  readonly reconnectDelayMs?: number
  /** Upper bound for the exponential reconnect backoff, in ms. Defaults to 30000. */
  readonly maxReconnectDelayMs?: number
  /**
   * Called once when a token handshake fails terminally (a 401/403 auth
   * rejection). Auto-reconnect is stopped first — retrying a known-bad credential
   * is futile — so the host can react (e.g. clear stored creds + return to a login
   * gate). Never receives the token. Transient / network / 5xx failures do NOT
   * fire this and keep reconnecting with backoff.
   */
  readonly onAuthError?: (error: unknown) => void
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
  /**
   * Last per-channel sequence delivered by the server. `undefined` until the
   * first seq-stamped event arrives; on reconnect it becomes the `sinceSeq`
   * cursor so the server replays anything missed while the socket was down.
   */
  lastSeq?: number
  /**
   * Set once this channel has been (sub)scribed over a live connection. Lets a
   * resubscribe after a drop request replay/resync even when no seq-stamped
   * event was ever received (`lastSeq` still undefined): without it, a channel
   * that dropped before its first event would resubscribe with no cursor and
   * silently miss everything published during the downtime. A genuinely
   * first-ever subscribe (flag still false) omits the cursor — nothing to
   * replay.
   */
  hadPriorConnection?: boolean
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
  private readonly maxReconnectDelayMs: number
  private readonly onAuthError?: (error: unknown) => void
  private readonly requestTimeoutMs: number
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private closed = false
  /**
   * Latched once a terminal auth rejection is seen. Retrying a known-bad token is
   * futile, so this permanently disarms auto-reconnect until the transport is
   * recreated (the host recovers via `onAuthError`).
   */
  private authFailed = false

  constructor(
    private readonly wsBaseUrl: string,
    options: WsTransportOptions = {}
  ) {
    this.webSocketImpl = resolveWebSocketImpl(options.webSocketImpl)
    this.idFactory = options.idFactory ?? createDefaultIdFactory()
    this.webSocketTokenProvider = options.webSocketTokenProvider
    this.reconnectDelayMs = options.reconnectDelayMs ?? 250
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30000
    this.onAuthError = options.onAuthError
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

    if (subscription.listeners.size === 1) this.sendSubscribe(subscription)
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
    // A latched terminal auth failure short-circuits every future connect: reject
    // immediately WITHOUT re-running the handshake. Re-running it would re-hit the
    // known-bad credential and could fire `onAuthError` again; the latch guarantees
    // the callback fired exactly once. This state persists until the transport is
    // recreated — which is exactly how web recovery works (clearWebAuth + reload
    // tears the client down), so a permanent latch until reload/close is fine and
    // never bricks a client that legitimately re-auths (that path builds a new one).
    if (this.authFailed) {
      return Promise.reject(new Error('Hive WebSocket authentication failed'))
    }
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
          // A live connection clears the backoff so the next drop retries fast.
          this.reconnectAttempts = 0
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
      // A terminal auth rejection (rotated/rejected owner or ws token) is not
      // recoverable by retrying: latch it, stop auto-reconnect, and hand off to
      // the host so it can re-authenticate. Never inspect / log the token.
      if (isAuthError(error)) {
        this.handleAuthFailure(error)
        throw error
      }
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

    // Advance the resume cursor from any seq-stamped message (real event or
    // resync). Legacy events without a seq leave the cursor untouched, so a
    // seq-less server is handled exactly as before (no sinceSeq ever sent).
    if (typeof message.seq === 'number') subscription.lastSeq = message.seq

    // A resync signal is surfaced to listeners unchanged (payload is empty and
    // `resync` is set) so they can refetch state. We must not crash on it: the
    // cursor was already advanced above, preventing a resync loop on the next
    // reconnect.
    for (const listener of subscription.listeners) listener(message)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private handleAuthFailure(error: unknown): void {
    // Latch-guarded so `onAuthError` fires exactly once. connect() already
    // short-circuits once `authFailed` is set, but guarding here too makes the
    // exactly-once contract hold regardless of how this path is reached.
    if (this.authFailed) return
    this.authFailed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.onAuthError?.(error)
  }

  private scheduleReconnect(): void {
    if (this.closed || this.authFailed || this.eventListeners.size === 0 || this.reconnectTimer)
      return

    // Exponential backoff: base * 2^attempt, capped, reset to base on a
    // successful open. Bounds the retry rate so a persistent failure no longer
    // hammers the server at a flat cadence.
    const delay = Math.min(
      this.reconnectDelayMs * 2 ** this.reconnectAttempts,
      this.maxReconnectDelayMs
    )
    this.reconnectAttempts += 1

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closed || this.authFailed || this.eventListeners.size === 0) return

      void this.connect().catch(() => {
        this.scheduleReconnect()
      })
    }, delay)
  }

  private sendSubscriptions(socket: WebSocketLike): void {
    // Called on (re)connect: replay every active subscription, carrying each
    // channel's cursor so the server backfills events missed while offline.
    for (const subscription of this.eventListeners.values()) {
      this.sendSubscribeMessage(socket, subscription)
    }
  }

  private sendSubscribe(subscription: ActiveSubscription): void {
    if (this.socket?.readyState === this.webSocketImpl.OPEN) {
      this.sendSubscribeMessage(this.socket, subscription)
    }
  }

  private sendSubscribeMessage(socket: WebSocketLike, subscription: ActiveSubscription): void {
    // Build the message from the CURRENT cursor state (so a first-ever subscribe
    // omits sinceSeq) before recording that this channel has now connected. The
    // flag flips only after a real send over an open socket, so a subscription
    // queued while offline is not mistaken for one that already connected.
    socket.send(JSON.stringify(toSubscribeMessage(subscription)))
    subscription.hadPriorConnection = true
  }

  private sendUnsubscribe(channel: string): void {
    if (this.socket?.readyState === this.webSocketImpl.OPEN) {
      const message: WebSocketUnsubscribeMessage = { type: 'unsubscribe', channel }
      this.socket.send(JSON.stringify(message))
    }
  }
}

const toSubscribeMessage = (subscription: ActiveSubscription): WebSocketSubscribeMessage => {
  // Resume cursor selection:
  //  - lastSeq known           → resume exactly after the last event we saw.
  //  - no lastSeq, but this
  //    channel connected before → resubscribe after a drop that happened before
  //                               any seq-stamped event arrived. Send sinceSeq=0
  //                               to force the server to replay from the start
  //                               of its buffer (or emit a resync if that window
  //                               has already scrolled past), so events during
  //                               the downtime are not silently missed.
  //  - no lastSeq, never
  //    connected                → genuine first-ever subscribe: omit sinceSeq so
  //                               the server treats it as a fresh stream.
  // A seq-less / replay-less server ignores sinceSeq entirely, so the added
  // cursor stays backward compatible.
  const sinceSeq =
    subscription.lastSeq !== undefined
      ? subscription.lastSeq
      : subscription.hadPriorConnection
        ? 0
        : undefined

  return {
    type: 'subscribe',
    ...subscription.request,
    ...(sinceSeq !== undefined ? { sinceSeq } : {})
  }
}
