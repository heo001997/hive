/**
 * Live events emitted by the war-room orchestrator (server process) and pushed to
 * the renderer over the WebSocket RPC event channel. The orchestrator runs in the
 * background after `warRoom.start`; the renderer subscribes to this channel to
 * update the transcript, roster status, and outcome without polling.
 *
 * Kept self-contained (no DB-type imports) so `src/shared` stays a leaf module.
 * The payload message/outcome shapes are structurally identical to the DB
 * `WarRoomMessage` / `WarRoomOutcome` types, so the orchestrator can pass DB rows
 * straight through and the renderer can treat them as those types.
 */
export const WAR_ROOM_EVENT_CHANNEL = 'war-room:event'

export interface WarRoomStreamMessage {
  id: string
  war_room_id: string
  member_id: string | null
  round: number
  role: 'member' | 'ceo' | 'system'
  content: string
  needs_ceo: boolean
  created_at: string
}

export interface WarRoomStreamOutcome {
  decision: string
  rationale?: string | null
  openQuestions?: string[]
  actionItems?: string[]
}

export type WarRoomStreamEvent =
  | {
      type: 'status'
      roomId: string
      status: string
      currentRound: number
      totalTokens: number
    }
  | { type: 'thinking'; roomId: string; memberId: string; memberName: string; round: number }
  | { type: 'message'; roomId: string; message: WarRoomStreamMessage }
  | { type: 'awaiting_ceo'; roomId: string; question: string; memberName: string }
  | { type: 'concluded'; roomId: string; outcome: WarRoomStreamOutcome }
  | { type: 'error'; roomId: string; error: string }

export const isWarRoomStreamEvent = (value: unknown): value is WarRoomStreamEvent => {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.type === 'string' && typeof v.roomId === 'string'
}
