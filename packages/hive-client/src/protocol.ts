// Wire protocol shapes shared with the Hive backend (src/server + src/shared/rpc).
//
// These are intentionally VENDORED as pure TypeScript types (no `zod`, no runtime
// import) so `@hive/client` stays dependency-free and platform-neutral. The
// backend validates the same envelope with zod schemas in
// `src/shared/rpc/protocol.ts`; keep these declarations in sync with that file.
//
// The RPC envelope is a custom format (NOT JSON-RPC 2.0):
//   request:  { id, method, params? }               // id is a non-empty string
//   response: { id, ok: true, value }
//           | { id, ok: false, error: { code, message, details? } }

export interface RpcRequest {
  readonly id: string
  readonly method: string
  readonly params?: unknown
}

export interface RpcError {
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

export type RpcResponse =
  | { readonly id: string; readonly ok: true; readonly value: unknown }
  | { readonly id: string; readonly ok: false; readonly error: RpcError }

export interface SubscriptionRequest {
  readonly channel: string
  readonly filter?: unknown
}

export interface WebSocketSubscribeMessage extends SubscriptionRequest {
  readonly type: 'subscribe'
}

export interface WebSocketUnsubscribeMessage {
  readonly type: 'unsubscribe'
  readonly channel: string
}

export interface ServerEvent {
  readonly channel: string
  readonly payload: unknown
}
