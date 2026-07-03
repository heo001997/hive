import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable harness so each test can shape the session-store + terminal responses.
const hoisted = vi.hoisted(() => ({
  createSession: vi.fn<(...args: unknown[]) => Promise<{ success: boolean; session?: { id: string }; error?: string }>>(),
  getSessionById: vi.fn<(id: string) => unknown>(),
  setTicketActiveView: vi.fn(),
  dequeuePendingMessage: vi.fn<(id: string) => string | null>(),
  requeuePendingMessage: vi.fn(),
  createClaudeCli: vi.fn<(...args: unknown[]) => Promise<{ success: boolean; error?: string }>>()
}))

vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      createSession: hoisted.createSession,
      getSessionById: hoisted.getSessionById,
      setTicketActiveView: hoisted.setTicketActiveView,
      dequeuePendingMessage: hoisted.dequeuePendingMessage,
      requeuePendingMessage: hoisted.requeuePendingMessage
    })
  }
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: { createClaudeCli: (...args: unknown[]) => hoisted.createClaudeCli(...args) }
}))

// unwrapEnvelope is identity for our already-unwrapped fakes.
vi.mock('@/lib/ipc-envelope', () => ({
  unwrapEnvelope: <A,>(x: A): A => x
}))

import { buildJudgePrompt, dispatchReviewJudge } from './run-review-judge'

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.createSession.mockResolvedValue({ success: true, session: { id: 'judge-1' } })
  hoisted.getSessionById.mockReturnValue(null)
  hoisted.dequeuePendingMessage.mockReturnValue('PROMPT')
  hoisted.createClaudeCli.mockResolvedValue({ success: true })
})

describe('buildJudgePrompt', () => {
  it('composes {standard}\\n\\nContext:\\n{context}, trimming both', () => {
    expect(buildJudgePrompt('  STANDARD  ', '  ctx tail  ')).toBe('STANDARD\n\nContext:\nctx tail')
  })

  it('preserves internal newlines in each part', () => {
    expect(buildJudgePrompt('line1\nline2', 'a\nb')).toBe('line1\nline2\n\nContext:\na\nb')
  })
})

describe('dispatchReviewJudge', () => {
  const base = {
    worktreeId: 'wt-1',
    projectId: 'proj-1',
    ticketId: 'ticket-1',
    prompt: 'JUDGE\n\nContext:\nstuff'
  }

  it('inherits the reviewed session model as the modelOverride', async () => {
    hoisted.getSessionById.mockReturnValue({
      model_provider_id: 'anthropic',
      model_id: 'claude-opus-4-8',
      model_variant: 'thinking'
    })

    const res = await dispatchReviewJudge({ ...base, reviewedSessionId: 'reviewed-1' })

    expect(res).toEqual({ success: true, sessionId: 'judge-1' })
    const opts = hoisted.createSession.mock.calls[0][4] as { modelOverride?: unknown; pendingMessage?: string }
    expect(opts.modelOverride).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-opus-4-8',
      variant: 'thinking'
    })
    expect(opts.pendingMessage).toBe(base.prompt)
  })

  it('omits modelOverride when the reviewed session has no stored model', async () => {
    hoisted.getSessionById.mockReturnValue({ model_provider_id: null, model_id: null })

    await dispatchReviewJudge({ ...base, reviewedSessionId: 'reviewed-1' })

    const opts = hoisted.createSession.mock.calls[0][4] as { modelOverride?: unknown }
    expect(opts.modelOverride).toBeUndefined()
  })

  it('surfaces the judge inline and delivers the prompt exactly once (dequeue → createClaudeCli)', async () => {
    await dispatchReviewJudge({ ...base, reviewedSessionId: null })

    expect(hoisted.setTicketActiveView).toHaveBeenCalledWith('ticket-1', 'judge-1')
    // Prompt is claimed from the queue before spawn so the mount path can't re-enter it.
    expect(hoisted.dequeuePendingMessage).toHaveBeenCalledWith('judge-1')
    expect(hoisted.createClaudeCli).toHaveBeenCalledWith('judge-1', { pendingPrompt: 'PROMPT' })
    expect(hoisted.requeuePendingMessage).not.toHaveBeenCalled()
  })

  it('returns failure and does not spawn a CLI when createSession fails', async () => {
    hoisted.createSession.mockResolvedValue({ success: false, error: 'boom' })

    const res = await dispatchReviewJudge({ ...base, reviewedSessionId: null })

    expect(res.success).toBe(false)
    expect(res.error).toBe('boom')
    expect(hoisted.createClaudeCli).not.toHaveBeenCalled()
  })

  it('requeues the prompt and reports failure when the CLI spawn fails', async () => {
    hoisted.createClaudeCli.mockResolvedValue({ success: false, error: 'no pty' })

    const res = await dispatchReviewJudge({ ...base, reviewedSessionId: null })

    expect(res.success).toBe(false)
    expect(res.error).toBe('no pty')
    expect(hoisted.requeuePendingMessage).toHaveBeenCalledWith('judge-1', 'PROMPT')
  })

  it('requeues the prompt when the CLI spawn throws', async () => {
    hoisted.createClaudeCli.mockRejectedValue(new Error('crash'))

    const res = await dispatchReviewJudge({ ...base, reviewedSessionId: null })

    expect(res.success).toBe(false)
    expect(res.error).toBe('crash')
    expect(hoisted.requeuePendingMessage).toHaveBeenCalledWith('judge-1', 'PROMPT')
  })
})
