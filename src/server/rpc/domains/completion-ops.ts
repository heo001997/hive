import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import { z } from 'zod'

import type { KanbanTicket, Session, SessionMessage, Worktree } from '../../../main/db'
import type {
  DetectCompletionOptions,
  TranscriptMessage
} from '../../../main/services/completion-detector'
import {
  COMPLETION_CHECK_PROVIDERS,
  type CompletionCheckProvider,
  type CompletionCheckResult,
  type CompletionVerdict,
  type SessionFingerprint
} from '@shared/types/completion'
import { stripAnsi } from '../../../shared/lib/ansi'
import { createLogger } from '../../../main/services/logger'
import type { RpcHandler } from '../router'

/**
 * Debug logger for the Strict Verify Watcher. Logs land in
 * `~/.hive/logs/hive-<date>.log` (relocated under HIVE_DATA_DIR for `pnpm dev`)
 * AND the dev console. Grep for `[StrictVerify]` to see exactly which transcript
 * source was used, the head/end of the tail we sent, and the verdict we got back.
 */
const log = createLogger({ component: 'StrictVerify' })

/** Single-line, length-capped preview of a blob for logging. */
const preview = (s: string, n = 240): string =>
  (s.length <= n ? s : `${s.slice(0, n)}…`).replace(/\s+/g, ' ').trim()

/** The slice of the database the completion check reads (kept narrow for testability). */
export interface CompletionOpsDatabase {
  getKanbanTicket: (id: string) => KanbanTicket | null
  getSession: (id: string) => Session | null
  getWorktree: (id: string) => Worktree | null
  getSessionMessages: (sessionId: string) => SessionMessage[]
}

export interface DetectTicketCompletionParams {
  sessionId: string
  ticketId: string
  maxChars?: number
  provider?: CompletionCheckProvider
  /** Optional model id forwarded to the provider as a model override. */
  model?: string
  /** Optional system prompt override for the Watcher (blank → built-in default). */
  systemPrompt?: string
}

export interface GetSessionFingerprintParams {
  sessionId: string
}

export interface TestStrictVerifyProviderParams {
  provider?: CompletionCheckProvider
  /** Optional model id forwarded to the provider as an override. */
  model?: string
  /** Optional system prompt override (blank → built-in default), so the test exercises the edited prompt. */
  systemPrompt?: string
}

/** A PTY liveness snapshot, as returned by `terminal-pty-bridge.getTerminalLiveness`. */
export interface SessionLiveness {
  bytes: number
  tail: string
}

export interface CompletionOpsRpcService {
  readonly detectTicketCompletion: (
    params: DetectTicketCompletionParams
  ) => Effect.Effect<CompletionCheckResult, unknown, never>
  readonly getSessionFingerprint: (
    params: GetSessionFingerprintParams
  ) => Effect.Effect<SessionFingerprint, unknown, never>
  readonly testStrictVerifyProvider: (
    params: TestStrictVerifyProviderParams
  ) => Effect.Effect<CompletionCheckResult, unknown, never>
}

/** Injectable dependencies — default to the real DB + detector via dynamic import. */
export interface CompletionOpsRpcDependencies {
  loadDatabase?: () => Promise<CompletionOpsDatabase> | CompletionOpsDatabase
  detect?: (options: DetectCompletionOptions) => Promise<CompletionVerdict>
  buildTail?: (messages: ReadonlyArray<TranscriptMessage>, maxChars?: number) => string
  /** Read a session's live PTY output snapshot (undefined → fall back to DB messages). */
  readLiveness?: (sessionId: string) => SessionLiveness | undefined
  /** Read a Claude Agent SDK JSONL transcript (the `claude-code` provider). */
  readClaudeTranscript?: (worktreePath: string, claudeSessionId: string) => Promise<unknown[]>
}

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex')

/**
 * Resolve a session's transcript as provider-agnostic {@link TranscriptMessage}s
 * for the Watcher (Gate 2) to judge.
 *
 * The guiding principle: the PTY liveness accumulator is for *liveness* (Gate 1's
 * "is the session still emitting?" fingerprint), NOT for *content*. It holds the
 * raw terminal byte stream — for a full-screen TUI like Claude CLI that is screen
 * redraw churn (the thinking spinner, box redraws, the idle input box, the footer),
 * and a TUI never re-emits text that scrolled past. Its last chars are UI noise, not
 * the agent's final summary, so judging completion from it yields false "incomplete".
 *
 * So we prefer the durable, structured transcript and use the live PTY tail only as
 * a last resort. Priority order:
 *
 *   1. claude-code / claude-code-cli — the JSONL transcript under ~/.claude/projects.
 *      Clean, ordered conversation (no redraw noise). Both the Agent SDK and the
 *      interactive CLI write it and populate `claude_session_id`. Preferred even
 *      while the PTY is still alive — by the time Gate 2 runs the session is settled,
 *      so the JSONL is fully flushed.
 *   2. codex / opencode — the `session_messages` DB table (their durable store).
 *   3. Live PTY accumulator — fallback only (JSONL not flushed yet, or a provider
 *      with neither JSONL nor DB messages). ANSI-stripped, last ~16KB.
 *
 * Returns `[]` only when no source has anything — callers treat that as "no
 * transcript to judge".
 */
async function resolveTranscriptMessages(
  db: CompletionOpsDatabase,
  session: Session | null,
  worktree: Worktree | null,
  params: DetectTicketCompletionParams,
  deps: CompletionOpsRpcDependencies
): Promise<TranscriptMessage[]> {
  // 1. Claude JSONL transcript — clean structured conversation, no terminal noise.
  //    The reader flattens each entry's content to a plain string; keep non-empty text.
  const isClaudeJsonl =
    session?.agent_sdk === 'claude-code' || session?.agent_sdk === 'claude-code-cli'
  if (isClaudeJsonl && session?.claude_session_id && worktree?.path) {
    const readClaudeTranscript =
      deps.readClaudeTranscript ??
      (await import('../../../main/services/claude-transcript-reader')).readClaudeTranscript
    try {
      const entries = await readClaudeTranscript(worktree.path, session.claude_session_id)
      const messages = entries
        .map((e) => e as { role?: unknown; content?: unknown })
        .filter((e) => typeof e.content === 'string' && e.content.trim().length > 0)
        .map((e) => ({
          role: typeof e.role === 'string' ? e.role : 'assistant',
          content: e.content as string
        }))
      if (messages.length > 0) {
        log.info('[StrictVerify] source=claude-jsonl', {
          sessionId: params.sessionId,
          claudeSessionId: session.claude_session_id,
          worktreePath: worktree.path,
          messageCount: messages.length,
          lastMessagePreview: preview(messages[messages.length - 1]?.content ?? '')
        })
        return messages
      }
      log.warn('[StrictVerify] claude-jsonl readable but EMPTY → falling through', {
        sessionId: params.sessionId,
        claudeSessionId: session.claude_session_id,
        worktreePath: worktree.path,
        rawEntryCount: entries.length
      })
    } catch (err) {
      log.error(
        '[StrictVerify] failed to read Claude transcript → falling through',
        err instanceof Error ? err : new Error(String(err)),
        { sessionId: params.sessionId, claudeSessionId: session.claude_session_id }
      )
    }
  } else {
    log.info('[StrictVerify] not a claude-jsonl source (missing sdk/session/worktree)', {
      sessionId: params.sessionId,
      agentSdk: session?.agent_sdk ?? null,
      hasClaudeSessionId: !!session?.claude_session_id,
      hasWorktreePath: !!worktree?.path
    })
  }

  // 2. Persisted DB messages (codex / opencode).
  const dbMessages = db.getSessionMessages(params.sessionId)
  if (dbMessages.length > 0) {
    log.info('[StrictVerify] source=db-messages', {
      sessionId: params.sessionId,
      messageCount: dbMessages.length
    })
    return dbMessages.map((m) => ({ role: m.role, content: m.content ?? '' }))
  }

  // 3. Live PTY output — last-resort fallback. ANSI-stripped, last ~16KB.
  const readLiveness =
    deps.readLiveness ??
    (await import('../../../main/services/terminal-pty-bridge')).getTerminalLiveness
  const live = readLiveness(params.sessionId)
  if (live && live.tail.trim()) {
    log.warn('[StrictVerify] source=pty-liveness (FALLBACK — clean transcript unavailable!)', {
      sessionId: params.sessionId,
      tailBytes: live.bytes,
      tailPreview: preview(stripAnsi(live.tail))
    })
    return [{ role: 'assistant', content: stripAnsi(live.tail) }]
  }

  log.warn('[StrictVerify] source=NONE (no transcript to judge)', { sessionId: params.sessionId })
  return []
}

const detectParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    ticketId: z.string().min(1),
    maxChars: z.number().int().positive().optional(),
    provider: z.enum(COMPLETION_CHECK_PROVIDERS).optional(),
    model: z.string().optional(),
    systemPrompt: z.string().optional()
  })
  .strict()

const fingerprintParamsSchema = z
  .object({
    sessionId: z.string().min(1)
  })
  .strict()

const testProviderParamsSchema = z
  .object({
    provider: z.enum(COMPLETION_CHECK_PROVIDERS).optional(),
    model: z.string().optional(),
    systemPrompt: z.string().optional()
  })
  .strict()

/** A trivial, obviously-complete transcript used only to prove the provider answers. */
const TEST_PROVIDER_TRANSCRIPT =
  'Assistant: I have finished the task. All requirements are implemented and verified. Done.'

export const makeLiveCompletionOpsRpcService = (
  deps: CompletionOpsRpcDependencies = {}
): CompletionOpsRpcService => ({
  detectTicketCompletion: (params) =>
    Effect.tryPromise({
      try: async (): Promise<CompletionCheckResult> => {
        // Everything runs inside one try so the handler always resolves to a
        // `{ success, … }` envelope (matching completion-api's contract) rather
        // than letting a DB/transcript/import throw reject the RPC promise.
        try {
          const loadDatabase =
            deps.loadDatabase ?? (async () => (await import('../../../main/db')).getDatabase())
          const buildTail =
            deps.buildTail ??
            (await import('../../../main/services/completion-detector')).buildTranscriptTail
          const detect =
            deps.detect ??
            (await import('../../../main/services/completion-detector')).detectTicketCompletion

          const db = await loadDatabase()

          const ticket = db.getKanbanTicket(params.ticketId)
          if (!ticket) {
            return { success: false, error: `Ticket not found: ${params.ticketId}` }
          }

          const session = db.getSession(params.sessionId)
          const worktree = session?.worktree_id ? db.getWorktree(session.worktree_id) : null
          // cwd lets CLI providers (codex/opencode) run against the ticket's worktree.
          const cwd = worktree?.path ?? undefined

          const messages = await resolveTranscriptMessages(db, session, worktree, params, deps)
          const transcriptTail = buildTail(messages, params.maxChars)

          log.info('[StrictVerify] REQUEST', {
            ticketId: params.ticketId,
            ticketTitle: ticket.title,
            sessionId: params.sessionId,
            provider: params.provider ?? 'claude-code',
            model: params.model ?? '(provider default)',
            customPrompt: !!params.systemPrompt,
            maxChars: params.maxChars ?? 'default',
            tailChars: transcriptTail.length,
            tailHead: preview(transcriptTail, 220),
            tailEnd:
              transcriptTail.length > 500
                ? `…${preview(transcriptTail.slice(-500), 500)}`
                : preview(transcriptTail, 500)
          })

          const verdict = await detect({
            ticketTitle: ticket.title,
            ticketDescription: ticket.description,
            transcriptTail,
            provider: params.provider ?? 'claude-code',
            cwd,
            modelOverride: params.model,
            systemPromptOverride: params.systemPrompt
          })
          log.info('[StrictVerify] VERDICT', {
            ticketId: params.ticketId,
            complete: verdict.complete,
            needsInput: verdict.needsInput,
            confidence: verdict.confidence,
            reason: verdict.reason
          })
          return { success: true, verdict }
        } catch (err) {
          log.error(
            '[StrictVerify] detect failed',
            err instanceof Error ? err : new Error(String(err)),
            { ticketId: params.ticketId }
          )
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
      catch: (cause) => cause
    }),

  getSessionFingerprint: (params) =>
    Effect.tryPromise({
      try: async (): Promise<SessionFingerprint> => {
        // Prefer the live PTY accumulator (works for background sessions, and is
        // byte-accurate). For Claude CLI, sessionId === terminalId.
        const readLiveness =
          deps.readLiveness ??
          (await import('../../../main/services/terminal-pty-bridge')).getTerminalLiveness
        const live = readLiveness(params.sessionId)
        if (live) {
          return { length: live.bytes, hash: sha256(stripAnsi(live.tail)) }
        }

        // Coarse fallback for non-PTY providers: fingerprint the persisted
        // messages by concatenated-content length + count + newest timestamp.
        const loadDatabase =
          deps.loadDatabase ?? (async () => (await import('../../../main/db')).getDatabase())
        const db = await loadDatabase()
        const messages = db.getSessionMessages(params.sessionId)
        const concat = messages.map((m) => m.content ?? '').join('')
        let maxCreatedAt = ''
        for (const m of messages) {
          if (m.created_at && m.created_at > maxCreatedAt) maxCreatedAt = m.created_at
        }
        const hash = sha256(`${concat} ${messages.length} ${maxCreatedAt}`)
        return { length: concat.length, hash }
      },
      catch: (cause) => cause
    }),

  // Settings "Test" button: prove the configured provider + model are actually
  // callable by running the real Watcher against a canned, obviously-complete
  // transcript. A reachable provider returns a verdict; an unreachable one (CLI
  // not installed, bad model id, auth) throws → `{ success: false, error }`.
  testStrictVerifyProvider: (params) =>
    Effect.tryPromise({
      try: async (): Promise<CompletionCheckResult> => {
        const detect =
          deps.detect ??
          (await import('../../../main/services/completion-detector')).detectTicketCompletion
        try {
          const verdict = await detect({
            ticketTitle: 'Completion-check connection test',
            ticketDescription:
              'A probe used by the Strict Verify settings to confirm this provider is reachable.',
            transcriptTail: TEST_PROVIDER_TRANSCRIPT,
            provider: params.provider ?? 'claude-code',
            cwd: undefined,
            modelOverride: params.model,
            systemPromptOverride: params.systemPrompt
          })
          return { success: true, verdict }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
      catch: (cause) => cause
    })
})

export const makeCompletionOpsRpcHandlers = (
  service: CompletionOpsRpcService = makeLiveCompletionOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'completionOps.detectTicketCompletion',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => detectParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.detectTicketCompletion(parsed)
        })
    ],
    [
      'completionOps.getSessionFingerprint',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => fingerprintParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getSessionFingerprint(parsed)
        })
    ],
    [
      'completionOps.testStrictVerifyProvider',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => testProviderParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.testStrictVerifyProvider(parsed)
        })
    ]
  ])
