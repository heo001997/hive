import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import type { KanbanTicket, Session, SessionMessage, Worktree } from '../../../main/db'
import type { CompletionVerdict } from '@shared/types/completion'
import {
  makeCompletionOpsRpcHandlers,
  makeLiveCompletionOpsRpcService,
  serializeEntryForReview,
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
      readLiveness: () => ({ bytes: 12, tail: '\x1b[1mSpec done. Report.\x1b[0m', lastOutputAt: 1000 })
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
      tail: ')▌  bypass permissions on (shift+tab to cycle)',
      lastOutputAt: 1000
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
      readLiveness: () => ({ bytes: 5, tail: '\x1b[1mlive tail\x1b[0m', lastOutputAt: 1000 }),
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

  it('folds tool activity into the JSONL tail so tool-only turns are not dropped (the false-incomplete fix)', async () => {
    // Regression for "ticket in Review judged Not done despite being finished":
    // a build agent typically FINISHES with tool work (write files, run tests,
    // commit) and little/no trailing prose. The reader's text-only `content` field
    // is then blank for those turns, so they were filtered out and the tail ended on
    // stale mid-work narration → the Watcher read "incomplete" → bounce loop. The
    // tool calls + results must survive so the judge sees the real final state.
    const buildTail = vi.fn(() => 'TAIL')
    const readClaudeTranscript = vi.fn(async () => [
      { role: 'assistant', content: 'Let me check the timezone wiring.', parts: [] },
      {
        role: 'assistant',
        content: '', // text-only view: empty — would have been dropped before the fix
        parts: [
          {
            type: 'tool_use',
            toolUse: {
              name: 'Write',
              input: { file_path: '/repo/quickstart.md', content: '# Quickstart' },
              output: 'File created successfully at: /repo/quickstart.md',
              status: 'success'
            }
          }
        ]
      }
    ])
    const service = makeLiveCompletionOpsRpcService({
      loadDatabase: () =>
        fakeDb({
          getSession: () =>
            session({
              agent_sdk: 'claude-code-cli',
              claude_session_id: 'cs-tools'
            } as Partial<Session>),
          getSessionMessages: () => []
        }),
      detect: async () => goodVerdict,
      buildTail,
      readLiveness: noLiveness,
      readClaudeTranscript
    })

    await Effect.runPromise(service.detectTicketCompletion({ sessionId: 's1', ticketId: 't1' }))
    const passed = (buildTail.mock.calls[0] as unknown[])[0] as Array<{
      role: string
      content: string
    }>
    // The tool-only turn survived (2 messages, not 1).
    expect(passed).toHaveLength(2)
    const last = passed[passed.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.content).toContain('⏺ Write(')
    expect(last.content).toContain('quickstart.md')
    expect(last.content).toContain('→ File created successfully')
  })
})

describe('serializeEntryForReview', () => {
  it('returns the plain content when there are no parts (codex/opencode-style entry)', () => {
    expect(serializeEntryForReview({ content: '  all done  ' })).toBe('all done')
    expect(serializeEntryForReview({ content: '   ' })).toBe('')
    expect(serializeEntryForReview({})).toBe('')
  })

  it('renders text parts as-is and folds in tool calls with their results', () => {
    const out = serializeEntryForReview({
      content: 'ignored when parts present',
      parts: [
        { type: 'text', text: 'Implemented the feature.' },
        {
          type: 'tool_use',
          toolUse: { name: 'Bash', input: { command: 'pnpm test' }, output: '37 passed, 0 failed' }
        }
      ]
    })
    expect(out).toContain('Implemented the feature.')
    expect(out).toContain('⏺ Bash({"command":"pnpm test"})')
    expect(out).toContain('→ 37 passed, 0 failed')
  })

  it('renders a tool error with the ✗ marker instead of an output line', () => {
    const out = serializeEntryForReview({
      parts: [
        {
          type: 'tool_use',
          toolUse: { name: 'Bash', input: { command: 'pnpm test' }, error: '3 tests failed' }
        }
      ]
    })
    expect(out).toContain('✗ error: 3 tests failed')
    expect(out).not.toContain('→')
  })

  it('omits thinking/reasoning parts (internal monologue, noisy)', () => {
    const out = serializeEntryForReview({
      parts: [
        { type: 'reasoning', text: 'I should probably double check the edge cases here…' },
        { type: 'text', text: 'Done.' }
      ]
    })
    expect(out).toBe('Done.')
  })

  it('clips a huge tool input and output so one payload cannot eat the whole tail budget', () => {
    const out = serializeEntryForReview({
      parts: [
        {
          type: 'tool_use',
          toolUse: {
            name: 'Write',
            input: { content: 'x'.repeat(5000) },
            output: 'y'.repeat(5000)
          }
        }
      ]
    })
    // 300-char input cap + 800-char output cap + framing — far below the raw 10k.
    expect(out.length).toBeLessThan(1300)
    expect(out).toContain('…')
  })

  it('drops a thinking-only turn to an empty string (so it is filtered from the tail)', () => {
    expect(serializeEntryForReview({ parts: [{ type: 'reasoning', text: 'hmm' }] })).toBe('')
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

  it('fingerprints the live PTY accumulator when present (ANSI stripped) with source:pty + lastOutputAt', async () => {
    const readLiveness = vi.fn(() => ({
      bytes: 4096,
      tail: '\x1b[31mhello\x1b[0m world',
      lastOutputAt: 1_720_000_000_000
    }))
    const service = makeLiveCompletionOpsRpcService({ readLiveness })

    const fp = await Effect.runPromise(service.getSessionFingerprint({ sessionId: 's1' }))
    expect(readLiveness).toHaveBeenCalledWith('s1')
    // The last-emit timestamp is surfaced verbatim so the renderer can ground the
    // frozen check in real terminal output; source flags the PTY (timestamp) path.
    expect(fp).toEqual({
      length: 4096,
      hash: sha256('hello world'),
      lastOutputAt: 1_720_000_000_000,
      source: 'pty'
    })
  })

  it('falls back to a DB message fingerprint (source:db, lastOutputAt:0) when no PTY liveness exists', async () => {
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
    // No live emit stream to timestamp → source:db + lastOutputAt:0 routes the
    // renderer to the two-sample stability comparison instead of the timestamp read.
    expect(fp).toEqual({
      length: concat.length,
      hash: sha256(`${concat} 2 2026-01-02T00:00:00Z`),
      lastOutputAt: 0,
      source: 'db'
    })
  })

  it('changes the fingerprint when live output grows', async () => {
    const a = makeLiveCompletionOpsRpcService({
      readLiveness: () => ({ bytes: 100, tail: 'abc', lastOutputAt: 1000 })
    })
    const b = makeLiveCompletionOpsRpcService({
      readLiveness: () => ({ bytes: 200, tail: 'abcdef', lastOutputAt: 2000 })
    })
    const fpA = await Effect.runPromise(a.getSessionFingerprint({ sessionId: 's1' }))
    const fpB = await Effect.runPromise(b.getSessionFingerprint({ sessionId: 's1' }))
    expect(fpA).not.toEqual(fpB)
  })
})
