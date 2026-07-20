// Best-effort resolution of host capabilities from `globalThis` (never `window`),
// with clear errors when a capability must be injected instead. Keeps the rest of
// the SDK free of `typeof WebSocket` / `typeof fetch` lib assumptions.

import type { FetchLike, WebSocketImpl } from './types'

export const resolveWebSocketImpl = (impl?: WebSocketImpl): WebSocketImpl => {
  if (impl) return impl
  const candidate = (globalThis as { WebSocket?: WebSocketImpl }).WebSocket
  if (!candidate) {
    throw new Error(
      'No WebSocket implementation available. Pass `webSocketImpl` in ClientConfig ' +
        '(browser WebSocket, Node >=22 global WebSocket, or the React Native WebSocket).'
    )
  }
  return candidate
}

export const resolveFetch = (impl?: FetchLike): FetchLike => {
  if (impl) return impl
  const candidate = (globalThis as { fetch?: FetchLike }).fetch
  if (!candidate) {
    throw new Error('No fetch implementation available. Pass `fetchImpl` in ClientConfig.')
  }
  return candidate
}

// crypto.randomUUID() where available (browser, Node >=19, RN with polyfill),
// otherwise a monotonic fallback that needs no host crypto.
export const createDefaultIdFactory = (): (() => string) => {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  const randomUUID = cryptoRef?.randomUUID?.bind(cryptoRef)
  if (randomUUID) return () => randomUUID()
  let counter = 0
  return () => `hive-${Date.now().toString(36)}-${(counter += 1).toString(36)}`
}
