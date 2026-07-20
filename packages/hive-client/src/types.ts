// Platform-neutral injection contracts. Nothing here references `window`,
// `document`, the DOM `lib`, Electron, or a preload bridge — every host-specific
// capability (WebSocket, fetch) is expressed as a minimal structural interface
// the caller injects. Real `WebSocket` / `fetch` from the browser, Node (>=22
// globals) and React Native are all structurally assignable to these.

/** The single event field `WsTransport` reads off an incoming `message` event. */
export interface WsMessageEvent {
  readonly data: unknown
}

/**
 * The subset of a WebSocket instance `WsTransport` uses. Browser `WebSocket`,
 * Node's global `WebSocket` (>=22) and React Native's `WebSocket` all satisfy it.
 */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: 'message', listener: (event: WsMessageEvent) => void): void
  addEventListener(type: 'open' | 'close' | 'error', listener: (event?: unknown) => void): void
  removeEventListener(type: string, listener: (event?: unknown) => void): void
}

/**
 * A constructable WebSocket implementation with the `OPEN` ready-state constant.
 * Pass `WebSocket` (browser / Node global / RN) here.
 */
export interface WebSocketImpl {
  new (url: string): WebSocketLike
  readonly OPEN: number
}

/** Minimal response shape the bootstrap handshake reads. */
export interface FetchResponseLike {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
  text(): Promise<string>
}

export interface FetchRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: unknown
}

/**
 * The subset of `fetch` the handshake / discovery helpers use. The global
 * `fetch` in the browser, Node (>=18) and React Native is assignable to this.
 */
export type FetchLike = (input: string, init?: FetchRequestInit) => Promise<FetchResponseLike>
