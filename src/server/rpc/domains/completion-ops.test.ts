import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import type { KanbanTicket, Session, SessionMessage, Worktree } from '../../../main/db'
import type { CompletionVerdict } from '@shared/types/completion'
import {
  makeCompletionOpsRpcHandlers,
  makeLiveCompletionOpsRpcService,
  type CompletionOpsDatabase
} from './completion-ops'

const ticket = (over: Partial<KanbanTicket> = {}): KanbanTicket =>
  ({
    id: 't1',
    title: 'Add logout',
    description: 'desc',
    ...over
  }) as KanbanTicket

const session = (over: Partial<Session> = {}): Session =>
  ({ id: 's1', worktree_id: 'w1', ...over }) as Session

const worktree = (over: Partial<Worktree> = {}): Worktree =>
  ({ id: 'w1', path: '/repo/wt', ...over }) as Worktree

const msg = (role: string, content: string): SessionMessage =>
  ({ role, content }) as SessionMessage

function fakeDb(over: Partial<CompletionOpsDatabase> = {}): CompletionOpsDatabase {
  return {
    getKanbanTicket: () => ticket(),
    getSession: () => session(),
    getWorktree: () => worktree(),
    getSessionMessages: () => [msg('assistant', 'done')],
    ...over
  }
}

const goodVerdict: CompletionVerdict = {
  complete: true,
  needsInput: false,
  confidence: 0.8,
  reason: 'looks done'
}

// Detect tests exercise the DB transcript path, so they stub readLiveness to
// `undefined` — otherwise the resolver would dynamic-import the native PTY bridge.
const noLiveness = (): undefined => undefined

describe('completionOps.detectTicketCompletion service', () => {
  it('returns an error envelope when the ticket is missing', async () => {
    const service = makeLiveCompletionOpsRpcService({
      loadDatabase: () => fakeDb({ getKanbanTicket: () => null }),
      detect: vi.fn(),
      buildTail: () => 'tail',
      readLiveness: noLiveness
    })
    const res = await Effect.runPromise(
      service.detectTicketCompletion({ sessionId: 's1', ticketId: 'nope' })
    )
    expect(res.success).toBe(false)
    expect(res.error).toContain('Ticket not found: nope')
  })

  it('resolves cwd from the session worktree and forwards detect inputs', async () => {
    const detect = vi.fn(async () => goodVerdict)
    const buildTail = vi.fn(() => 'TAIL')
    const service = makeLiveCompletionOpsRpcService({
      loadDatabase: () => fakeDb(),
      detect,
      buildTail,
      readLiveness: noLiveness
    })

    const res = await Effect.runPromise(
      service.detectTicketCompletion({
        sessionId: 's1',
        ticketId: 't1',
        maxChars: 1234,
        provider: 'codex'
      })
    )

    expect(res).toEqual({ success: true, verdict: goodVerdict })
    expect(buildTail).toHaveBeenCalledWith([{ role: 'assistant', content: 'done' }], 1234)
    expect(detect).toHaveBeenCalledWith({
      ticketTitle: 'Add logout',
      ticketDescription: 'desc',
      transcriptTail: 'TAIL',
      provider: 'codex',
      cwd: '/repo/wt',
      modelOverride: undefined
    })
  })

  it('forwards the model param to the detector as modelOverride', async () => {
    const detect = vi.fn(async () => goodVerdict)
    const service = makeLiveCompletionOpsRpcService({
      loadDatabase: () => fakeDb(),
      detect,
      buildTail: () => 'tail',
      readLiveness: noLiveness
    })

    await Effect.runPromise(
      service.detectTicketCompletion({
        sessionId: 's1',
        ticketId: 't1',
        model: 'claude-haiku-4-5-20251001'
      })
    )
    expect(detect).toHaveBeenCalledWith(
      expect.objectContaining({ modelOverride: 'claude-haiku-4-5-20251001' })
    )
  })

  it('forwards the systemPrompt param to the detector as systemPromptOverride', async () => {
    const detect = vi.fn(async () => goodVerdict)
    const service = makeLiveCompletionOpsRpcService({
      loadDatabase: () => fakeDb(),
      detect,
      buildTail: () => 'tail',
      readLiveness: noLiveness
    })

    await Effect.runPromise(
      service.detectTicketCompletion({
        sessionId: 's1',
        ticketId: 't1',
        systemPrompt: 'custom reviewer prompt'
      })
    )
    expect(detect).toHaveBeenCalledWith(
      expect.objectContaining({ systemPromptOverride: 'custom reviewer prompt' })
    )
  })

  it('defaults the provider to claude-code and leaves cwd undefined without a worktree', async () => {
    const detect = vi.fn(async () => goodVerdict)
    const service = makeLiveCompletionOpsRpcService({
      loadDatabase: () =>
        fakeDb({ getSession: () => session({ worktree_id: null as unknown as string }) }),
      detect,
      buildTail: () => 'tail',
      readLiveness: noLiveness
    })

    await Effect.runPromise(service.detectTicketCompletion({ sessionId: 's1', ticketId: 't1' }))
    expect(detect).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude-code', cwd: undefined })
    )
  })

  it('converts a detector throw into an error envelope', async () => {
    const service = makeLiveCompletionOpsRpcService({
      loadDatabase: () => fakeDb(),
      detect: async () => {
        throw new Error('provider exploded')
      },
      buildTail: () => 'tail',
      readLiveness: noLiveness
    })
    const res = await Effect.runPromise(
      service.detectTicketCompletion({ sessionId: 's1', ticketId: 't1' })
    )
    expect(res).toEqual({ success: false, error: 'provider exploded' })
  })
})

describe('completionOps transcript source resolution', () => {
  it('uses the live PTY tail (ANSI-stripped) only when there is no structured source', async () => {
    const buildTail = vi.fn(() => 'TAIL')
    const detect = vi.fn(async () => goodVerdict)
    const service = makeLiveCompletionOpsRpcService({
      // No JSONL (session has no agent_sdk/claude_session_id) and no DB messages —
      // the PTY tail is the last-resort fallback.
      loadDatabase: () => fakeDb({ getSessionMessages: () => [] }),
      detect,
      buildTail,
      readLiveness: () => ({ bytes: 12, tail: '\x1b[1mSpec done. Report.\x1b[0m' })
    })

    await Effect.runPromise(service.detectTicketCompletion({ sessionId: 's1', ticketId: 't1' }))
    expect(buildTail).toHaveBeenCalledWith(
      [{ role: 'assistant', content: 'Spec done. Report.' }],
      undefined
    )
  })

  it('prefers the clean Claude JSONL over the noisy live PTY tail (the false-incomplete fix)', async () => {
    // Regression for the "Speckit plan — 2830" false "Not done" 92%: a Claude-CLI
    // session's PTY tail is raw TUI redraw soup — its last chars are the idle input
    // box / footer, not the agent's summary — so the Watcher judged it incomplete.
    // The durable JSONL holds the clean conversation, so it must win even while the
    // PTY is still alive (terminal open).
    const buildTail = vi.fn(() => 'TAIL')
    const readClaudeTranscript = vi.fn(async () => [
      { role: 'assistant', content: 'Artifacts generated. plan.md filled. All done.' }
    ])
    const readLiveness = vi.fn(() => ({
      bytes: 99,
      tail: ')▌  bypass permissions on (shift+tab to cycle)'
    }))
    const service = makeLiveCompletionOpsRpcService({
      loadDatabase: () =>
        fakeDb({
          getSession: () =>
            session({
              agent_sdk: 'claude-code-cli',
              claude_session_id: 'cs-live'
            } as Partial<Session>),
          getSessionMessages: () => []
        }),
      detect: async () => goodVerdict,
      buildTail,
      readLiveness,
      readClaudeTranscript
    })

    await Effect.runPromise(service.detectTicketCompletion({ sessionId: 's1', ticketId: 't1' }))
    expect(readClaudeTranscript).toHaveBeenCalledWith('/repo/wt', 'cs-live')
    expect(buildTail).toHaveBeenCalledWith(
      [{ role: 'assistant', content: 'Artifacts generated. plan.md filled. All done.' }],
      undefined
    )
    // The noisy PTY tail must NOT have become the transcript.
    expect(buildTail).not.toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('bypass permissions') })
      ]),
      undefined
    )
  })

  it('falls back to the live PTY tail when the Claude JSONL is not yet readable', async () => {
    // JSONL empty (not flushed) → use the live tail rather than judging nothing.
    const buildTail = vi.fn(() => 'TAIL')
    const readClaudeTranscript = vi.fn(async () => [])
    const service = makeLiveCompletionOpsRpcService({
      loadDatabase: () =>
        fakeDb({
          getSession: () =>
            session({ agent_sdk: 'claude-code-cli', claude_session_id: 'cs2' } as Partial<Session>),
          getSessionMessages: () => []
        }),
      detect: async () => goodVerdict,
      buildTail,
      readLiveness: () => ({ bytes: 5, tail: '\x1b[1mlive tail\x1b[0m' }),
      readClaudeTranscript
    })

    await Effect.runPromise(service.detectTicketCompletion({ sessionId: 's1', ticketId: 't1' }))
    expect(buildTail).toHaveBeenCalledWith([{ role: 'assistant', content: 'live tail' }], undefined)
  })

  it('falls back to DB messages when there is no PTY liveness (codex/opencode)', async () => {
    const buildTail = vi.fn(() => 'TAIL')
    const service = makeLiveCompletionOpsRpcService({
      loadDatabase: () =>
        fakeDb({ getSessionMessages: () => [msg('user', 'go'), msg('assistant', 'done')] }),
      detect: async () => goodVerdict,
      buildTail,
      readLiveness: noLiveness
    })

    await Effect.runPromise(service.detectTicketCompletion({ sessionId: 's1', ticketId: 't1' }))
    expect(buildTail).toHaveBeenCalledWith(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'done' }
      ],
      undefined
    )
  })

  it('reads the Claude SDK JSONL transcript when DB + PTY are empty (claude-code)', async () => {
    const buildTail = vi.fn(() => 'TAIL')
    const readClaudeTranscript = vi.fn(async () => [
      { role: 'user', content: 'build it' },
      { role: 'assistant', content: 'all done' },
      { role: 'assistant', content: '   ' } // dropped: blank after trim
    ])
    const service = makeLiveCompletionOpsRpcService({
      loadDatabase: () =>
        fakeDb({
          getSession: () =>
            session({ agent_sdk: 'claude-code', claude_session_id: 'cs1' } as Partial<Session>),
          getSessionMessages: () => []
        }),
      detect: async () => goodVerdict,
      buildTail,
      readLiveness: noLiveness,
      readClaudeTranscript
    })

    await Effect.runPromise(service.detectTicketCompletion({ sessionId: 's1', ticketId: 't1' }))
    expect(readClaudeTranscript).toHaveBeenCalledWith('/repo/wt', 'cs1')
    expect(buildTail).toHaveBeenCalledWith(
      [
        { role: 'user', content: 'build it' },
        { role: 'assistant', content: 'all done' }
      ],
      undefined
    )
  })

  it('reads the JSONL transcript for the interactive CLI too (claude-code-cli)', async () => {
    // Claude CLI keeps its transcript in the PTY *and* writes the same JSONL as
    // the Agent SDK. Once the PTY is gone (settled / relaunch → empty liveness),
    // the JSONL is the only durable source — it must be read for the CLI as well.
    const buildTail = vi.fn(() => 'TAIL')
    const readClaudeTranscript = vi.fn(async () => [
      { role: 'assistant', content: 'spec written, all done' }
    ])
    const service = makeLiveCompletionOpsRpcService({
      loadDatabase: () =>
        fakeDb({
          getSession: () =>
            session({
              agent_sdk: 'claude-code-cli',
              claude_session_id: 'cs-cli'
            } as Partial<Session>),
          getSessionMessages: () => []
        }),
      detect: async () => goodVerdict,
      buildTail,
      readLiveness: noLiveness,
      readClaudeTranscript
    })

    await Effect.runPromise(service.detectTicketCompletion({ sessionId: 's1', ticketId: 't1' }))
    expect(readClaudeTranscript).toHaveBeenCalledWith('/repo/wt', 'cs-cli')
    expect(buildTail).toHaveBeenCalledWith(
      [{ role: 'assistant', content: 'spec written, all done' }],
      undefined
    )
  })

  it('passes an empty transcript through when every source is empty', async () => {
    const buildTail = vi.fn(() => '')
    const service = makeLiveCompletionOpsRpcService({
      loadDatabase: () => fakeDb({ getSessionMessages: () => [] }),
      detect: async () => goodVerdict,
      buildTail,
      readLiveness: noLiveness
    })

    await Effect.runPromise(service.detectTicketCompletion({ sessionId: 's1', ticketId: 't1' }))
    expect(buildTail).toHaveBeenCalledWith([], undefined)
  })
})

describe('completionOps.testStrictVerifyProvider service', () => {
  it('runs the detector against a canned transcript and returns the verdict', async () => {
    const detect = vi.fn(async () => goodVerdict)
    const service = makeLiveCompletionOpsRpcService({ detect })

    const res = await Effect.runPromise(
      service.testStrictVerifyProvider({ provider: 'codex', model: 'gpt-5-mini' })
    )

    expect(res).toEqual({ success: true, verdict: goodVerdict })
    expect(detect).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex',
        modelOverride: 'gpt-5-mini',
        transcriptTail: expect.stringContaining('finished the task')
      })
    )
  })

  it('defaults the provider to claude-code when none is given', async () => {
    const detect = vi.fn(async () => goodVerdict)
    const service = makeLiveCompletionOpsRpcService({ detect })
    await Effect.runPromise(service.testStrictVerifyProvider({}))
    expect(detect).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude-code', modelOverride: undefined })
    )
  })

  it('forwards the systemPrompt so the test exercises the edited prompt', async () => {
    const detect = vi.fn(async () => goodVerdict)
    const service = makeLiveCompletionOpsRpcService({ detect })
    await Effect.runPromise(
      service.testStrictVerifyProvider({ systemPrompt: 'edited reviewer prompt' })
    )
    expect(detect).toHaveBeenCalledWith(
      expect.objectContaining({ systemPromptOverride: 'edited reviewer prompt' })
    )
  })

  it('returns an error envelope when the provider is unreachable', async () => {
    const service = makeLiveCompletionOpsRpcService({
      detect: async () => {
        throw new Error('claude: command not found')
      }
    })
    const res = await Effect.runPromise(service.testStrictVerifyProvider({ provider: 'claude-code' }))
    expect(res).toEqual({ success: false, error: 'claude: command not found' })
  })
})

describe('completionOps handler param validation', () => {
  // The handler ignores its RpcContext arg; a stub keeps the call type-correct.
  const run = (params: unknown) => {
    const service = makeLiveCompletionOpsRpcService({
      loadDatabase: () => fakeDb(),
      detect: async () => goodVerdict,
      buildTail: () => 'tail',
      readLiveness: noLiveness
    })
    const handler = makeCompletionOpsRpcHandlers(service).get('completionOps.detectTicketCompletion')!
    return Effect.runPromise(handler(params, {} as never))
  }

  it('accepts valid params', async () => {
    const res = (await run({ sessionId: 's1', ticketId: 't1', provider: 'claude-code' })) as {
      success: boolean
    }
    expect(res.success).toBe(true)
  })

  it('accepts an optional model string', async () => {
    const res = (await run({ sessionId: 's1', ticketId: 't1', model: 'gpt-5-mini' })) as {
      success: boolean
    }
    expect(res.success).toBe(true)
  })

  it('accepts an optional systemPrompt string', async () => {
    const res = (await run({ sessionId: 's1', ticketId: 't1', systemPrompt: 'custom' })) as {
      success: boolean
    }
    expect(res.success).toBe(true)
  })

  it('rejects an empty sessionId', async () => {
    await expect(run({ sessionId: '', ticketId: 't1' })).rejects.toBeDefined()
  })

  it('rejects an unknown provider', async () => {
    await expect(run({ sessionId: 's1', ticketId: 't1', provider: 'gpt5' })).rejects.toBeDefined()
  })

  it('rejects unknown keys (strict schema)', async () => {
    await expect(run({ sessionId: 's1', ticketId: 't1', extra: true })).rejects.toBeDefined()
  })
})

describe('completionOps.getSessionFingerprint service', () => {
  const sha256 = (input: string) => createHash('sha256').update(input).digest('hex')

  it('fingerprints the live PTY accumulator when present (ANSI stripped)', async () => {
    const readLiveness = vi.fn(() => ({ bytes: 4096, tail: '\x1b[31mhello\x1b[0m world' }))
    const service = makeLiveCompletionOpsRpcService({ readLiveness })

    const fp = await Effect.runPromise(service.getSessionFingerprint({ sessionId: 's1' }))
    expect(readLiveness).toHaveBeenCalledWith('s1')
    expect(fp).toEqual({ length: 4096, hash: sha256('hello world') })
  })

  it('falls back to a DB message fingerprint when no PTY liveness exists', async () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: 'do it', created_at: '2026-01-01T00:00:00Z' } as SessionMessage,
      { role: 'assistant', content: 'done', created_at: '2026-01-02T00:00:00Z' } as SessionMessage
    ]
    const service = makeLiveCompletionOpsRpcService({
      readLiveness: () => undefined,
      loadDatabase: () => fakeDb({ getSessionMessages: () => messages })
    })

    const fp = await Effect.runPromise(service.getSessionFingerprint({ sessionId: 's1' }))
    const concat = 'do itdone'
    expect(fp).toEqual({
      length: concat.length,
      hash: sha256(`${concat} 2 2026-01-02T00:00:00Z`)
    })
  })

  it('changes the fingerprint when live output grows', async () => {
    const a = makeLiveCompletionOpsRpcService({
      readLiveness: () => ({ bytes: 100, tail: 'abc' })
    })
    const b = makeLiveCompletionOpsRpcService({
      readLiveness: () => ({ bytes: 200, tail: 'abcdef' })
    })
    const fpA = await Effect.runPromise(a.getSessionFingerprint({ sessionId: 's1' }))
    const fpB = await Effect.runPromise(b.getSessionFingerprint({ sessionId: 's1' }))
    expect(fpA).not.toEqual(fpB)
  })
})
