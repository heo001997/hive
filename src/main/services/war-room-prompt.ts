/**
 * Pure prompt/format helpers for the War Room orchestrator.
 *
 * Kept free of DB / SDK imports so it is unit-testable without loading
 * better-sqlite3 (which is unavailable in the local vitest runtime). The
 * orchestrator (war-room-orchestrator.ts) imports these; so do the tests.
 */
import type { WarRoom, WarRoomMember, WarRoomMessage, WarRoomOutcome } from '../db/types'

/** Escalation marker a member appends when it needs the CEO to decide. */
export const CEO_MARKER = '@CEO:'
/** Rolling window of most-recent verbatim messages fed to each turn (cost guard). */
export const MAX_TRANSCRIPT_MESSAGES = 40

/** Very rough token estimate for the live meter (no exact counts from the router). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/** Pull the `@CEO:` question out of a member message, or null if none. */
export const extractCeoQuestion = (text: string): string | null => {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.toUpperCase().startsWith(CEO_MARKER.toUpperCase())) {
      return trimmed.slice(CEO_MARKER.length).trim()
    }
  }
  return null
}

export const memberLabel = (m: WarRoomMember): string => (m.role ? `${m.name} (${m.role})` : m.name)

/** Render the tail of the transcript as "Name (role): content" / "CEO: content" lines. */
export const formatTranscript = (
  messages: WarRoomMessage[],
  members: WarRoomMember[]
): string => {
  const byId = new Map(members.map((m) => [m.id, m]))
  const windowed = messages.slice(-MAX_TRANSCRIPT_MESSAGES)
  if (windowed.length === 0) return '(no messages yet — you may open the discussion)'
  return windowed
    .map((msg) => {
      if (msg.role === 'ceo') return `CEO: ${msg.content}`
      if (msg.role === 'system') return `[Topic] ${msg.content}`
      const member = msg.member_id ? byId.get(msg.member_id) : undefined
      return `${member ? memberLabel(member) : 'Unknown'}: ${msg.content}`
    })
    .join('\n\n')
}

export const buildSystemPrompt = (
  member: WarRoomMember,
  members: WarRoomMember[],
  allowDrafts: boolean
): string => {
  const roster = members.map((m) => `- ${memberLabel(m)}`).join('\n')
  const lines = [
    `You are ${member.name}, a participant in a WAR ROOM — a focused round-table discussion between several AI experts working toward a concrete agreement.`,
    member.role ? `Your role: ${member.role}.` : '',
    member.stance ? `Your assigned stance: ${member.stance}.` : '',
    member.system_prompt ? `\n${member.system_prompt}\n` : '',
    `Other participants:\n${roster}`,
    `\nRules:`,
    `- Speak ONLY as ${member.name}, in the first person. Be concise: 2–6 sentences.`,
    `- Engage directly with what others said — agree, build on it, or DISAGREE with specific reasons. Do not rubber-stamp or repeat points already made.`,
    `- Never write other participants' lines or narrate the room.`,
    `- Stay on the topic. Push the discussion toward a decision.`,
    `- If you need a decision only the CEO (the human) can make, or the room is blocked by unresolved disagreement, end your message with a line that starts exactly "${CEO_MARKER}" followed by your question. Use this sparingly.`,
    allowDrafts
      ? `- When (and only when) you want to propose concrete Hive tickets, append a fenced block exactly like:\n\`\`\`board-ticket-drafts\n{"drafts":[{"title":"Short title","description":"What to do and why"}]}\n\`\`\`\nInclude it only for real, actionable work — omit it otherwise. The CEO can turn it into board tickets.`
      : ''
  ]
  return lines.filter(Boolean).join('\n')
}

export const buildTurnPrompt = (
  room: WarRoom,
  member: WarRoomMember,
  messages: WarRoomMessage[],
  members: WarRoomMember[],
  round: number
): string => {
  return [
    `Topic: ${room.topic || room.title}`,
    `Round ${round + 1} of ${room.max_rounds}.`,
    ``,
    `Discussion so far:`,
    formatTranscript(messages, members),
    ``,
    `It is now your turn, ${member.name}. Give your contribution to the discussion.`
  ].join('\n')
}

export const SYNTHESIS_SYSTEM_PROMPT = [
  `You are the neutral facilitator of a war-room discussion. Read the full transcript and synthesize where the participants landed.`,
  `Respond with ONLY a JSON object (no prose, no code fences) of exactly this shape:`,
  `{`,
  `  "decision": string,        // the agreement reached, or the leading position if not unanimous`,
  `  "rationale": string,       // 1-3 sentences on why`,
  `  "openQuestions": string[], // unresolved points, may be empty`,
  `  "actionItems": string[]    // concrete next steps, may be empty`,
  `}`
].join('\n')

export const parseOutcome = (raw: string | null): WarRoomOutcome => {
  const text = (raw ?? '').trim()
  if (!text) return { decision: '(synthesis returned nothing)', openQuestions: [], actionItems: [] }
  // Strip ```json fences if the model added them despite instructions.
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  try {
    const parsed = JSON.parse(unfenced) as Partial<WarRoomOutcome>
    return {
      decision: typeof parsed.decision === 'string' ? parsed.decision : text,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : null,
      openQuestions: Array.isArray(parsed.openQuestions)
        ? parsed.openQuestions.filter((x): x is string => typeof x === 'string')
        : [],
      actionItems: Array.isArray(parsed.actionItems)
        ? parsed.actionItems.filter((x): x is string => typeof x === 'string')
        : []
    }
  } catch {
    // Model didn't return clean JSON — treat the whole text as the decision.
    return { decision: text, rationale: null, openQuestions: [], actionItems: [] }
  }
}
