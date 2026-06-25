import { generateText } from './text-generation-router'
import { createLogger } from './logger'
import type { AgentSdkId } from './agent-sdk-types'
import { DEFAULT_STRICT_VERIFY_PROMPT, type CompletionVerdict } from '@shared/types/completion'

export type { CompletionVerdict }

const log = createLogger({ component: 'CompletionDetector' })

/** Hard ceiling on the transcript tail we send, regardless of the user's char budget. */
const MAX_TAIL_CHARS = 24 * 1024
/** Default char budget when the caller doesn't specify one. */
export const DEFAULT_TAIL_CHARS = 6000
const MAX_REASON_LENGTH = 600
const MAX_TITLE_LENGTH = 512
const MAX_DESCRIPTION_LENGTH = 4 * 1024

/** Built-in Watcher system prompt; the user can override it per the settings. */
const SYSTEM_PROMPT = DEFAULT_STRICT_VERIFY_PROMPT

export const COMPLETION_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    complete: { type: 'boolean' },
    needsInput: { type: 'boolean' },
    confidence: { type: 'number' },
    reason: { type: 'string' }
  },
  required: ['complete', 'needsInput', 'confidence', 'reason'],
  additionalProperties: false
})

/** Minimal message shape — decoupled from the DB `SessionMessage` row type. */
export interface TranscriptMessage {
  role: string
  content: string
}

export interface DetectCompletionOptions {
  ticketTitle: string
  ticketDescription: string | null
  transcriptTail: string
  provider: AgentSdkId
  cwd?: string
  /** Optional model id to override the provider's default (e.g. a stronger judge model). */
  modelOverride?: string
  /** Optional system prompt to override the built-in Watcher prompt (blank → built-in). */
  systemPromptOverride?: string
}

/**
 * Build the prompt-ready transcript tail: join messages oldest→newest as
 * `[role] content`, then keep only the last `maxChars` characters (the end of a
 * session is where completion signals — or their absence — live). A leading
 * marker notes when the head was dropped.
 */
export function buildTranscriptTail(
  messages: ReadonlyArray<TranscriptMessage>,
  maxChars: number = DEFAULT_TAIL_CHARS
): string {
  const cap = Math.min(Math.max(1, Math.floor(maxChars)), MAX_TAIL_CHARS)
  const joined = messages
    .map((m) => ({ role: m.role, content: (m.content ?? '').trim() }))
    .filter((m) => m.content.length > 0)
    .map((m) => `[${m.role}] ${m.content}`)
    .join('\n\n')
    .trim()

  if (joined.length <= cap) return joined
  return `… (earlier transcript truncated)\n\n${joined.slice(-cap)}`
}

/**
 * Ask an LLM whether the ticket's goal is genuinely complete, given the tail of
 * the coding agent's transcript. Mirrors {@link generatePRContent}: build a
 * prompt, call the text-generation router with a JSON output schema, parse the
 * response.
 *
 * Throws on provider failure or an unparseable response — callers decide how to
 * degrade (the engine treats a thrown error as "don't act").
 */
export async function detectTicketCompletion(
  options: DetectCompletionOptions
): Promise<CompletionVerdict> {
  const { ticketTitle, ticketDescription, transcriptTail, provider, cwd, modelOverride } = options
  const systemPrompt = options.systemPromptOverride?.trim() || SYSTEM_PROMPT

  const tail = transcriptTail.trim()
  if (!tail) {
    // No transcript to judge — report incomplete with zero confidence rather
    // than spending a model call on nothing.
    return {
      complete: false,
      needsInput: false,
      confidence: 0,
      reason: 'No session transcript available to review.'
    }
  }

  const prompt = `Ticket title: ${truncate(ticketTitle, MAX_TITLE_LENGTH)}

Ticket description:
${truncate((ticketDescription ?? '').trim() || '(none provided)', MAX_DESCRIPTION_LENGTH)}

Transcript tail (most recent agent output, oldest→newest):
${tail}`

  log.info('Detecting ticket completion', { provider, tailLength: tail.length, cwd })

  const response = await generateText(prompt, systemPrompt, provider, {
    cwd,
    outputSchema: COMPLETION_JSON_SCHEMA,
    modelOverride
  })
  if (!response) {
    throw new Error('AI provider returned an empty response')
  }

  return parseVerdict(response)
}

/** Parse the LLM response (possibly fenced) into a normalized verdict. */
function parseVerdict(response: string): CompletionVerdict {
  const json = extractJSON(response)
  if (!json) {
    log.warn('Could not extract JSON from completion response', {
      responsePrefix: response.slice(0, 200),
      responseLength: response.length
    })
    throw new Error('Could not extract JSON from AI response')
  }

  const parsed = JSON.parse(json) as Record<string, unknown>

  if (typeof parsed.complete !== 'boolean') {
    throw new Error('AI response missing required boolean "complete" field')
  }

  const confidence =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0
  const reason =
    typeof parsed.reason === 'string' && parsed.reason.trim()
      ? sanitizeReason(parsed.reason)
      : 'No reason provided.'
  const needsInput = parsed.needsInput === true

  return { complete: parsed.complete, needsInput, confidence, reason }
}

/**
 * Extract a JSON object string from the response — raw, or wrapped in a
 * markdown code fence (```json … ```).
 */
function extractJSON(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (fenceMatch) return fenceMatch[1].trim()

  const braceStart = text.indexOf('{')
  const braceEnd = text.lastIndexOf('}')
  if (braceStart !== -1 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1)
  }
  return null
}

/** Collapse the reason to a single line and enforce a max length. */
function sanitizeReason(reason: string): string {
  const singleLine = reason.replace(/[\r\n]+/g, ' ').trim()
  return singleLine.length > MAX_REASON_LENGTH
    ? singleLine.slice(0, MAX_REASON_LENGTH - 1) + '…'
    : singleLine
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '\n… (truncated)'
}
