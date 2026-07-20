// @hive/client — platform-neutral Hive RPC SDK.
//
// This entry is DOM-free, Electron-free and dependency-free: it works anywhere a
// WebSocket and (for authenticated backends) a fetch implementation exist —
// browser, Node, React Native. Host-specific helpers that touch Node built-ins
// live behind the `@hive/client/node` subpath, never here.

export { HiveClient, createHiveClient, type ClientConfig } from './hive-client'
export {
  WsTransport,
  type WsTransportOptions,
  type ServerEventListener
} from './ws-transport'
export { createWebSocketTokenProvider, type HandshakeConfig } from './handshake'
export { MemoryTokenStore, type TokenStore } from './token-store'
export {
  setHiveClient,
  getHiveClient,
  resetHiveClientForTests,
  type HiveRpcClient
} from './client-registry'
export type {
  WebSocketImpl,
  WebSocketLike,
  WsMessageEvent,
  FetchLike,
  FetchRequestInit,
  FetchResponseLike
} from './types'
export type {
  RpcRequest,
  RpcResponse,
  RpcError,
  ServerEvent,
  SubscriptionRequest,
  WebSocketSubscribeMessage,
  WebSocketUnsubscribeMessage
} from './protocol'
