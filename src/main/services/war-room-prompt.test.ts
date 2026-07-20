import { describe, it, expect } from 'vitest'
import {
  extractCeoQuestion,
  parseOutcome,
  formatTranscript,
  buildSystemPrompt,
  buildTurnPrompt,
  MAX_TRANSCRIPT_MESSAGES
} from './war-room-prompt'
import type { WarRoom, WarRoomMember, WarRoomMessage } from '../db/types'

const member = (over: Partial<WarRoomMember> = {}): WarRoomMember => ({
  id: 'm1',
  war_room_id: 'r1',
  name: 'Architect',
  role: 'Systems Architect',
  system_prompt: null,
  stance: null,
  color: null,
  agent_sdk: 'claude-code',
  model_id: 'sonnet',
  model_variant: null,
  speaking_order: 0,
  is_moderator: false,
  is_active: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over
})

const message = (over: Partial<WarRoomMessage> = {}): WarRoomMessage => ({
  id: 'x',
  war_room_id: 'r1',
  member_id: 'm1',
  round: 0,
  role: 'member',
  content: 'hello',
  needs_ceo: false,
  created_at: '2026-01-01T00:00:00.000Z',
  ...over
})

const room = (over: Partial<WarRoom> = {}): WarRoom => ({
  id: 'r1',
  project_id: 'p1',
  title: 'Adopt tRPC?',
  topic: 'Should we adopt tRPC?',
  status: 'active',
  orchestration_mode: 'round_robin',
  max_rounds: 3,
  current_round: 0,
  current_turn: 0,
  seed_ticket_id: null,
  outcome: null,
  total_tokens: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  concluded_at: null,
  ...over
})

describe('extractCeoQuestion', () => {
  it('returns the text after the @CEO: marker', () => {
    expect(extractCeoQuestion('I think X.\n@CEO: ship it or not?')).toBe('ship it or not?')
  })
  it('is case-insensitive on the marker', () => {
    expect(extractCeoQuestion('@ceo:   which path?')).toBe('which path?')
  })
  it('returns null when there is no marker', () => {
    expect(extractCeoQuestion('just a normal message')).toBeNull()
  })
  it('only matches the marker at the start of a line', () => {
    expect(extractCeoQuestion('email me @CEO: not a real escalation')).toBeNull()
  })
})

describe('parseOutcome', () => {
  it('parses a clean JSON object', () => {
    const o = parseOutcome(
      '{"decision":"adopt","rationale":"types","openQuestions":["a"],"actionItems":["b","c"]}'
    )
    expect(o.decision).toBe('adopt')
    expect(o.rationale).toBe('types')
    expect(o.openQuestions).toEqual(['a'])
    expect(o.actionItems).toEqual(['b', 'c'])
  })
  it('strips ```json fences the model may add', () => {
    const o = parseOutcome('```json\n{"decision":"go"}\n```')
    expect(o.decision).toBe('go')
    expect(o.openQuestions).toEqual([])
  })
  it('falls back to treating the whole text as the decision on invalid JSON', () => {
    const o = parseOutcome('we agreed to ship')
    expect(o.decision).toBe('we agreed to ship')
    expect(o.rationale).toBeNull()
  })
  it('handles empty / null input', () => {
    expect(parseOutcome('').decision).toContain('nothing')
    expect(parseOutcome(null).decision).toContain('nothing')
  })
  it('drops non-string array entries', () => {
    const o = parseOutcome('{"decision":"d","actionItems":["ok",5,null,"also"]}')
    expect(o.actionItems).toEqual(['ok', 'also'])
  })
})

describe('formatTranscript', () => {
  it('returns a placeholder when empty', () => {
    expect(formatTranscript([], [])).toContain('no messages yet')
  })
  it('labels member, ceo and system messages', () => {
    const t = formatTranscript(
      [
        message({ role: 'system', member_id: null, content: 'Topic here' }),
        message({ role: 'member', member_id: 'm1', content: 'my take' }),
        message({ role: 'ceo', member_id: null, content: 'my call' })
      ],
      [member()]
    )
    expect(t).toContain('[Topic] Topic here')
    expect(t).toContain('Architect (Systems Architect): my take')
    expect(t).toContain('CEO: my call')
  })
  it('windows to the last MAX_TRANSCRIPT_MESSAGES', () => {
    const many = Array.from({ length: MAX_TRANSCRIPT_MESSAGES + 10 }, (_, i) =>
      message({ id: `x${i}`, content: `msg-${i}` })
    )
    const t = formatTranscript(many, [member()])
    expect(t).not.toContain('msg-0')
    expect(t).toContain(`msg-${MAX_TRANSCRIPT_MESSAGES + 9}`)
  })
})

describe('buildSystemPrompt', () => {
  it('includes name, role, stance and the CEO-escalation rule', () => {
    const p = buildSystemPrompt(member({ stance: 'against' }), [member()], false)
    expect(p).toContain('You are Architect')
    expect(p).toContain('Your role: Systems Architect')
    expect(p).toContain('Your assigned stance: against')
    expect(p).toContain('@CEO:')
  })
  it('adds the drafts instruction only when allowed', () => {
    expect(buildSystemPrompt(member(), [member()], false)).not.toContain('board-ticket-drafts')
    expect(buildSystemPrompt(member(), [member()], true)).toContain('board-ticket-drafts')
  })
})

describe('buildTurnPrompt', () => {
  it('includes the topic, round and the turn cue', () => {
    const p = buildTurnPrompt(room(), member(), [], [member()], 1)
    expect(p).toContain('Topic: Should we adopt tRPC?')
    expect(p).toContain('Round 2 of 3')
    expect(p).toContain('It is now your turn, Architect')
  })
})
