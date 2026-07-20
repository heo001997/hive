import { z } from 'zod'

export const RpcRequestSchema = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional()
})

export type RpcRequest = z.infer<typeof RpcRequestSchema>

export const RpcErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional()
})

export type RpcError = z.infer<typeof RpcErrorSchema>

export type RpcResponse =
  | { readonly id: string; readonly ok: true; readonly value: unknown }
  | { readonly id: string; readonly ok: false; readonly error: RpcError }

export const SubscriptionRequestSchema = z
  .object({
    channel: z.string().min(1),
    filter: z.unknown().optional(),
    /**
     * Resumable-subscription cursor. When present, the server replays buffered
     * events with `seq > sinceSeq` (in order) before resuming live delivery. If
     * the cursor is older than the server's in-memory ring-buffer window (or
     * ahead of it, e.g. after a server restart reset the counter), the server
     * emits an explicit resync signal instead so the client refetches state.
     */
    sinceSeq: z.number().int().nonnegative().optional()
  })
  .strict()

export type SubscriptionRequest = z.infer<typeof SubscriptionRequestSchema>

export const WebSocketSubscribeMessageSchema = SubscriptionRequestSchema.extend({
  type: z.literal('subscribe')
}).strict()

export type WebSocketSubscribeMessage = z.infer<typeof WebSocketSubscribeMessageSchema>

export const WebSocketUnsubscribeMessageSchema = z
  .object({
    type: z.literal('unsubscribe'),
    channel: z.string().min(1)
  })
  .strict()

export type WebSocketUnsubscribeMessage = z.infer<typeof WebSocketUnsubscribeMessageSchema>

export interface ServerEvent {
  readonly channel: string
  readonly payload: unknown
  /**
   * Monotonic per-channel sequence number assigned by the event bus at publish
   * time. Optional so emitters that predate resumable subscriptions (and any
   * non-buffered path) remain valid — clients treat its absence as "no
   * resumability" and fall back to legacy behaviour.
   */
  readonly seq?: number
  /**
   * When `true`, this is an out-of-band resync signal rather than a real event:
   * the client's `sinceSeq` fell outside the server's buffer window, so its
   * `payload` is empty and the client must refetch channel state. `seq` (when
   * present) carries the latest server sequence to adopt as the new cursor.
   */
  readonly resync?: boolean
  /** Human-readable reason attached to a resync signal (e.g. `'gap'`). */
  readonly reason?: string
}
