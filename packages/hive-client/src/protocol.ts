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
  /**
   * Resumable-subscription cursor. On (re)subscribe the transport sets this to
   * the last sequence it saw on the channel; the server replays buffered events
   * with `seq > sinceSeq` before resuming live delivery, or emits a resync
   * signal if the cursor is outside its buffer window. Omitted on a first
   * subscribe (fresh stream — backward compatible).
   */
  readonly sinceSeq?: number
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
  /**
   * Monotonic per-channel sequence assigned by the server event bus. Absent on
   * emitters that predate resumable subscriptions — the transport treats its
   * absence as "no resumability" and never advances its cursor for that event.
   */
  readonly seq?: number
  /**
   * When `true`, this is an out-of-band resync signal (empty `payload`): the
   * transport's `sinceSeq` fell outside the server buffer window, so listeners
   * should refetch channel state. `seq` carries the latest server sequence to
   * adopt as the new cursor.
   */
  readonly resync?: boolean
  /** Human-readable reason attached to a resync signal (e.g. `'gap'`). */
  readonly reason?: string
}
