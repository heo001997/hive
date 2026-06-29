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
/**
 * How many times to ask the provider for a verdict. Models occasionally answer
 * with prose or an unrelated code fence and no parseable JSON; one retry lets a
 * transient bad response self-heal before we surface an error to the engine.
 */
const COMPLETION_PARSE_ATTEMPTS = 2

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

  let lastError: unknown
  for (let attempt = 0; attempt < COMPLETION_PARSE_ATTEMPTS; attempt++) {
    const response = await generateText(prompt, systemPrompt, provider, {
      cwd,
      outputSchema: COMPLETION_JSON_SCHEMA,
      modelOverride
    })
    if (!response) {
      lastError = new Error('AI provider returned an empty response')
      continue
    }
    try {
      return parseVerdict(response)
    } catch (err) {
      lastError = err
      log.warn('Completion verdict parse failed', {
        attempt: attempt + 1,
        attempts: COMPLETION_PARSE_ATTEMPTS,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Could not parse AI completion verdict')
}

/** Parse the LLM response (possibly fenced, possibly with extra prose) into a verdict. */
function parseVerdict(response: string): CompletionVerdict {
  const parsed = extractVerdictObject(response)
  if (!parsed) {
    log.warn('Could not extract a JSON verdict from completion response', {
      responsePrefix: response.slice(0, 200),
      responseLength: response.length
    })
    throw new Error('Could not extract JSON from AI response')
  }

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
 * Find the verdict object in a (possibly messy) LLM response. Models sometimes
 * wrap the JSON in a ```json fence, precede it with prose, or — the failure this
 * guards against — emit an UNRELATED code fence first (e.g. a ```bash block
 * quoting a command) before the real JSON. We therefore gather every plausible
 * JSON candidate and return the first that parses to an object carrying a
 * boolean `complete`, falling back to the first object that parses at all (so
 * the "missing complete field" error still fires for a genuinely malformed
 * verdict rather than a generic "no JSON" error).
 */
function extractVerdictObject(text: string): Record<string, unknown> | null {
  let firstObject: Record<string, unknown> | null = null
  for (const candidate of jsonCandidates(text)) {
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const obj = value as Record<string, unknown>
    if (typeof obj.complete === 'boolean') return obj
    if (!firstObject) firstObject = obj
  }
  return firstObject
}

/**
 * Ordered, de-duplicated JSON-string candidates pulled from a model response,
 * most-likely first: explicit ```json fences, then other fenced blocks, then
 * every balanced `{…}` object in the raw text, then the outermost-brace slice.
 */
function jsonCandidates(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (raw: string | undefined): void => {
    if (!raw) return
    const trimmed = raw.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      out.push(trimmed)
    }
  }

  // 1. Explicit ```json fences (the format the prompt asks for).
  for (const m of text.matchAll(/```json\s*\r?\n?([\s\S]*?)```/gi)) add(m[1])
  // 2. Any other fenced block (```bash, bare ```, …) — discarded later if not JSON.
  for (const m of text.matchAll(/```[^\n`]*\r?\n?([\s\S]*?)```/g)) add(m[1])
  // 3. Every balanced {…} object in the raw text (handles bare JSON amid prose).
  for (const obj of balancedObjects(text)) add(obj)
  // 4. Last resort: the outermost { … } slice.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) add(text.slice(start, end + 1))

  return out
}

/**
 * Yield each top-level balanced `{…}` substring, ignoring braces inside JSON
 * string literals. Lets us pick the real verdict object out of mixed prose/code
 * without the outermost-brace slice swallowing unrelated braces.
 */
function balancedObjects(text: string): string[] {
  const objects: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}' && depth > 0) {
      depth--
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return objects
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
