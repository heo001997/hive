// Thin shim. The WebSocket RPC transport now lives in the platform-neutral
// @hive/client SDK (WsTransport, injected WebSocket impl, reconnect + per-request
// timeout). Re-exported here so existing `@/api/ws-transport` imports keep
// working. Prefer importing from @hive/client directly in new code.
export { WsTransport } from '@hive/client'
export type { WsTransportOptions, ServerEventListener } from '@hive/client'
