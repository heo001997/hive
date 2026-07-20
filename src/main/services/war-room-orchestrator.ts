/**
 * War Room orchestrator.
 *
 * Drives a round-robin, auto-run discussion between several persona-driven AI
 * agents ("members") sitting around a virtual round table. Each turn we build a
 * persona system prompt + the shared transcript and ask the chosen agent SDK
 * (Claude / Codex / OpenCode, via the portable `generateText` router — stateless,
 * one-shot per turn) for that member's contribution. Messages are persisted and
 * pushed to the renderer as whole bubbles over the war-room event channel.
 *
 * The human is the CEO: sets the topic, watches, can inject a message anytime, is
 * the escalation target (`@CEO:`), and is the ONLY one who ends a room (Achieve).
 * The run never auto-concludes — after the scheduled rounds it goes idle (paused)
 * and the CEO may keep it going. Pause/resume is cooperative via persisted
 * `current_round`/`current_turn` + a status re-check between turns.
 *
 * Runs in the process that owns the DB + SDK (the server child), invoked from the
 * war-room RPC domain. Pure prompt/format helpers live in ./war-room-prompt.
 */
import { homedir } from 'node:os'
import { getDatabase } from '../db'
import { generateText } from './text-generation-router'
import { loadClaudeSDK } from './claude-sdk-loader'
import type { AgentSdkId } from './agent-sdk-types'
import { createLogger } from './logger'
import type { WarRoom, WarRoomMember, WarRoomOutcome } from '../db/types'
import type { WarRoomStreamEvent } from '@shared/war-room-events'
import {
  SYNTHESIS_SYSTEM_PROMPT,
  buildSystemPrompt,
  buildTurnPrompt,
  estimateTokens,
  extractCeoQuestion,
  formatTranscript,
  parseOutcome
} from './war-room-prompt'

const log = createLogger({ component: 'WarRoomOrchestrator' })

export type WarRoomEmit = (event: WarRoomStreamEvent) => void

/** Default model when a Claude member has none set. */
const DEFAULT_MODEL = 'sonnet'
/** Model + timeout for the final synthesis pass (own SDK call — bypasses the 30s router cap). */
const SYNTHESIS_MODEL = 'opus'
const SYNTHESIS_TIMEOUT_MS = 120_000

/** Room ids with a loop currently in flight — guards against double-launch. */
const activeRuns = new Set<string>()

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const emitStatus = (room: WarRoom, emit: WarRoomEmit, status: string): void => {
  emit({
    type: 'status',
    roomId: room.id,
    status,
    currentRound: room.current_round,
    totalTokens: room.total_tokens
  })
}

const addTokens = (roomId: string, tokens: number): void => {
  const db = getDatabase()
  const room = db.getWarRoom(roomId)
  if (!room) return
  db.updateWarRoom(roomId, { total_tokens: room.total_tokens + tokens })
}

/**
 * Synthesis via a direct Claude SDK call with a generous timeout, so a long
 * transcript over opus doesn't trip the text-generation router's hard 30s cap.
 */
const synthesize = async (prompt: string, systemPrompt: string): Promise<string | null> => {
  const sdk = await loadClaudeSDK()
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), SYNTHESIS_TIMEOUT_MS)
  let streamedText = ''
  try {
    const query = sdk.query({
      prompt,
      options: {
        cwd: homedir(),
        model: SYNTHESIS_MODEL,
        maxTurns: 2,
        abortController,
        systemPrompt,
        effort: 'low',
        thinking: { type: 'disabled' },
        tools: [],
        persistSession: false
      }
    }) as AsyncIterable<Record<string, unknown>>

    let resultText = ''
    for await (const msg of query) {
      if (msg.type === 'assistant') {
        const content = (msg as Record<string, unknown>).message
        const blocks =
          content && typeof content === 'object'
            ? (content as Record<string, unknown>).content
            : null
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
              streamedText += ((block as Record<string, unknown>).text as string) ?? ''
            }
          }
        }
      }
      if (msg.type === 'result') {
        const r = msg as Record<string, unknown>
        if (typeof r.subtype === 'string' && r.subtype.startsWith('error')) {
          if (r.subtype === 'error_max_turns' && streamedText) {
            resultText = streamedText
            break
          }
          throw new Error(`synthesis error (${r.subtype})`)
        }
        resultText = (r.result as string) ?? ''
        break
      }
    }
    return resultText || streamedText || null
  } catch (err) {
    if (streamedText) return streamedText
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

/** Run a single member's turn: build prompts, call its SDK, return the response text. */
const runMemberTurn = async (
  roomId: string,
  member: WarRoomMember,
  members: WarRoomMember[],
  round: number
): Promise<string> => {
  const db = getDatabase()
  const room = db.getWarRoom(roomId)
  if (!room) return '(room gone)'
  const messages = db.getWarRoomMessages(roomId)
  const systemPrompt = buildSystemPrompt(member, members, Boolean(room.project_id))
  const userPrompt = buildTurnPrompt(room, member, messages, members, round)
  const provider = (member.agent_sdk || 'claude-code') as AgentSdkId
  // Claude has a good default id; codex/opencode use whatever the member picked
  // (fall through to the router's own per-provider default when unset).
  const modelOverride =
    member.model_id || (provider === 'claude-code' ? DEFAULT_MODEL : undefined)
  try {
    const text = await generateText(
      userPrompt,
      systemPrompt,
      provider,
      modelOverride ? { modelOverride } : {}
    )
    return (text ?? '').trim() || '(no response)'
  } catch (err) {
    log.warn('member turn failed', { roomId, member: member.name, error: errMsg(err) })
    return `(${member.name} could not respond: ${errMsg(err)})`
  }
}

/** The cooperative round-robin loop. Resumes from persisted current_round/current_turn. */
const executeRun = async (roomId: string, emit: WarRoomEmit): Promise<void> => {
  const db = getDatabase()
  const start = db.getWarRoom(roomId)
  if (!start) return

  const members = db.getWarRoomMembers(roomId).filter((m) => m.is_active && !m.is_moderator)
  if (members.length === 0) {
    emit({ type: 'error', roomId, error: 'No active members in the room.' })
    const paused = db.updateWarRoom(roomId, { status: 'paused' })
    if (paused) emitStatus(paused, emit, 'paused')
    return
  }

  const maxRounds = start.max_rounds
  for (let round = start.current_round; round < maxRounds; round++) {
    const beginTurn = round === start.current_round ? start.current_turn : 0
    for (let turn = beginTurn; turn < members.length; turn++) {
      const fresh = db.getWarRoom(roomId)
      if (!fresh || fresh.status !== 'active') return // paused / achieved / awaiting — stop
      const member = members[turn]

      db.updateWarRoom(roomId, { current_round: round, current_turn: turn })
      emit({ type: 'thinking', roomId, memberId: member.id, memberName: member.name, round })

      const text = await runMemberTurn(roomId, member, members, round)
      const ceoQuestion = extractCeoQuestion(text)
      const message = db.createWarRoomMessage({
        war_room_id: roomId,
        member_id: member.id,
        round,
        role: 'member',
        content: text,
        needs_ceo: ceoQuestion !== null
      })
      addTokens(roomId, estimateTokens(text))
      emit({ type: 'message', roomId, message })

      if (ceoQuestion !== null) {
        // Advance the cursor past this member so resume continues with the next one.
        db.updateWarRoom(roomId, {
          current_round: round,
          current_turn: turn + 1,
          status: 'awaiting_ceo'
        })
        const room = db.getWarRoom(roomId)
        if (room) emitStatus(room, emit, 'awaiting_ceo')
        emit({ type: 'awaiting_ceo', roomId, question: ceoQuestion, memberName: member.name })
        return
      }
    }
    // Round complete — advance to the next round from its first member.
    db.updateWarRoom(roomId, { current_round: round + 1, current_turn: 0 })
  }

  // All scheduled rounds done → go IDLE (paused), do NOT auto-conclude. Only the
  // CEO ends a room (Achieve). Sending a message resumes and extends by a round.
  const paused = db.updateWarRoom(roomId, { status: 'paused' })
  if (paused) emitStatus(paused, emit, 'paused')
}

/**
 * Public entry: seed the topic message (first run only), extend the horizon if
 * resuming past the cap, mark the room active, and kick off the loop in the
 * background. Returns as soon as the loop is launched.
 */
export const startWarRoom = async (roomId: string, emit: WarRoomEmit): Promise<void> => {
  const db = getDatabase()
  const room = db.getWarRoom(roomId)
  if (!room) throw new Error(`War room ${roomId} not found`)
  if (room.status === 'achieved' || room.status === 'concluded') return

  const existing = db.getWarRoomMessages(roomId)
  if (existing.length === 0 && room.topic) {
    const sys = db.createWarRoomMessage({
      war_room_id: roomId,
      member_id: null,
      round: 0,
      role: 'system',
      content: room.topic
    })
    emit({ type: 'message', roomId, message: sys })
  }

  // Resuming past the round cap (CEO continued the discussion) → extend the
  // horizon by one round so agents respond once more, then go idle again.
  if (room.current_round >= room.max_rounds) {
    db.updateWarRoom(roomId, { max_rounds: room.current_round + 1 })
  }

  // Flip to active FIRST. If a loop from a just-paused run is still finishing its
  // in-flight turn, it re-checks status between turns and will simply keep going.
  const active = db.updateWarRoom(roomId, { status: 'active' })
  if (active) emitStatus(active, emit, 'active')

  if (activeRuns.has(roomId)) return

  activeRuns.add(roomId)
  void executeRun(roomId, emit)
    .catch((err) => {
      log.error(
        'war room run crashed',
        err instanceof Error ? err : new Error(errMsg(err)),
        { roomId }
      )
      emit({ type: 'error', roomId, error: errMsg(err) })
      const paused = db.updateWarRoom(roomId, { status: 'paused' })
      if (paused) emitStatus(paused, emit, 'paused')
    })
    .finally(() => activeRuns.delete(roomId))
}

/** Pause a running room. The loop stops after the current turn finishes. */
export const pauseWarRoom = (roomId: string, emit: WarRoomEmit): void => {
  const db = getDatabase()
  const room = db.getWarRoom(roomId)
  if (!room) return
  if (room.status === 'active' || room.status === 'awaiting_ceo') {
    const paused = db.updateWarRoom(roomId, { status: 'paused' })
    if (paused) emitStatus(paused, emit, 'paused')
  }
}

/**
 * Record a CEO message and keep the discussion going. Empty content is allowed —
 * it means "just continue" (no message added). Resumes the run unless the room is
 * already running or has been achieved (terminal). Sending in a draft room starts
 * it. When resuming past the round cap, `startWarRoom` extends by one round.
 */
export const injectCeo = async (
  roomId: string,
  content: string,
  emit: WarRoomEmit
): Promise<void> => {
  const db = getDatabase()
  const room = db.getWarRoom(roomId)
  if (!room) return
  if (room.status === 'achieved' || room.status === 'concluded') return

  const trimmed = content.trim()
  if (trimmed) {
    const message = db.createWarRoomMessage({
      war_room_id: roomId,
      member_id: null,
      round: room.current_round,
      role: 'ceo',
      content: trimmed
    })
    emit({ type: 'message', roomId, message })
  }

  if (room.status !== 'active') {
    await startWarRoom(roomId, emit)
  }
}

/**
 * CEO-only terminal action. Runs the synthesis pass over the transcript so far,
 * writes the Agreement, and locks the room as `achieved`. This is the ONLY way a
 * room stops. Setting `achieved` up front also halts any in-flight run loop.
 */
export const achieveWarRoom = async (roomId: string, emit: WarRoomEmit): Promise<void> => {
  const db = getDatabase()
  const room = db.getWarRoom(roomId)
  if (!room) return
  if (room.status === 'achieved') return

  const halting = db.updateWarRoom(roomId, { status: 'achieved' })
  if (halting) emitStatus(halting, emit, 'achieved')

  const messages = db.getWarRoomMessages(roomId)
  const members = db.getWarRoomMembers(roomId)
  const memberMessages = messages.filter((m) => m.role === 'member')

  let outcome: WarRoomOutcome
  if (memberMessages.length === 0) {
    outcome = {
      decision: 'No discussion took place — nothing to synthesize.',
      rationale: null,
      openQuestions: [],
      actionItems: []
    }
  } else {
    const transcript = formatTranscript(messages, members)
    try {
      const raw = await synthesize(
        [
          `Topic: ${room.topic || room.title}`,
          ``,
          `Full discussion transcript:`,
          transcript,
          ``,
          `Synthesize the agreement now.`
        ].join('\n'),
        SYNTHESIS_SYSTEM_PROMPT
      )
      outcome = parseOutcome(raw)
      addTokens(roomId, estimateTokens(raw ?? ''))
    } catch (err) {
      log.warn('synthesis failed', { roomId, error: errMsg(err) })
      outcome = {
        decision: `Synthesis failed: ${errMsg(err)}`,
        rationale: null,
        openQuestions: [],
        actionItems: []
      }
    }
  }

  const achieved = db.updateWarRoom(roomId, {
    outcome,
    status: 'achieved',
    concluded_at: new Date().toISOString()
  })
  emit({ type: 'concluded', roomId, outcome })
  if (achieved) emitStatus(achieved, emit, 'achieved')
}
