import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'
import type { CompletionCheckResult, SessionFingerprint } from '@shared/types/completion'

// Queue prompts (Claude CLI): prompts live in the kanban store's ticket-keyed
// `promptQueues`. A verified-complete Review ticket pops the FIFO head and
// dispatches it. These tests drive the store gate (`maybeDispatchClaudeCliQueue`
// via the public actions + the Strict Verify settle path) plus the CRUD actions,
// with `dispatchClaudeCliFollowup` mocked so no PTY is touched.

vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    ticket: {
      move: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(null),
      create: vi.fn(async (_projectId: string, data: object) => ({ id: 'seeded', ...data })),
      reorder: vi.fn().mockResolvedValue(undefined),
      addTokens: vi.fn().mockResolvedValue(null),
      getBySession: vi.fn().mockResolvedValue([])
    }
  }
}))

vi.mock('../lib/auto-launch', () => ({
  autoLaunchTicket: vi.fn().mockResolvedValue(undefined)
}))

const SESSION_ID = 'sess-1'

const hoisted = vi.hoisted(() => ({
  settings: {
    followUpTriggerColumn: 'done' as const,
    kanbanAutoApproveReview: false,
    kanbanAutoCommitOnReview: false,
    kanbanAutoApproveDelaySeconds: 0,
    kanbanStrictVerifyEnabled: true,
    kanbanStrictVerifySnapshotEnabled: true,
    kanbanStrictVerifyReviewerEnabled: true,
    kanbanStrictVerifyDelaySeconds: 0,
    kanbanStrictVerifyProvider: 'claude-code' as const,
    kanbanStrictVerifyModel: '',
    kanbanStrictVerifyChars: 6000,
    kanbanStrictVerifyConfidenceThreshold: 0.6,
    kanbanInProgressRescueEnabled: false,
    kanbanQueuePromptsEnabled: true
  },
  sessionStatuses: {} as Record<string, { status: string; timestamp: number } | null>,
  // Session-native follow-up queue — read only by `passesSettleGuards` to abort a
  // settle when the queue feature is OFF. Distinct from the ticket promptQueues.
  pendingFollowUp: new Map<string, string[]>(),
  sessionSdk: 'claude-code-cli' as string,
  dispatch: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
  detect: vi.fn<(...args: unknown[]) => Promise<CompletionCheckResult>>(),
  fingerprint: vi.fn<(...args: unknown[]) => Promise<SessionFingerprint>>()
}))

vi.mock('./useSettingsStore', () => ({
  useSettingsStore: { getState: () => hoisted.settings }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: { worktree: { get: vi.fn().mockResolvedValue({ path: '/wt/path' }) } }
}))

vi.mock('@/api/git-api', () => ({
  gitApi: {
    stageAll: vi.fn().mockResolvedValue({ success: true }),
    commit: vi.fn().mockResolvedValue({ success: true, commitHash: 'abc' })
  }
}))

vi.mock('./useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: {
    getState: () => ({
      sessionStatuses: hoisted.sessionStatuses,
      clearCompletedReviewSession: () => {}
    })
  }
}))

vi.mock('./useSessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      pendingFollowUpMessages: hoisted.pendingFollowUp,
      getSessionById: (id: string) =>
        id === SESSION_ID ? { id, agent_sdk: hoisted.sessionSdk } : null
    })
  }
}))

vi.mock('@/api/completion-api', () => ({
  completionApi: {
    detectTicketCompletion: (...args: unknown[]) => hoisted.detect(...args),
    getSessionFingerprint: (...args: unknown[]) => hoisted.fingerprint(...args)
  }
}))

vi.mock('@/lib/claude-cli-followup', () => ({
  dispatchClaudeCliFollowup: (...args: unknown[]) => hoisted.dispatch(...args)
}))

import {
  useKanbanStore,
  ticketKey,
  buildQueuedPromptText,
  type QueuedAttachment
} from './useKanbanStore'

const ATT: QueuedAttachment = {
  id: 'att-1',
  name: 'shot.png',
  mime: 'image/png',
  filePath: '/abs/shot.png'
}

const PROJECT_ID = 'proj-1'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: PROJECT_ID,
    title: 'Implement feature',
    description: null,
    attachments: [],
    column: 'in_progress',
    sort_order: 0,
    current_session_id: SESSION_ID,
    worktree_id: null,
    mode: 'build',
    plan_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    archived_at: null,
    external_provider: null,
    external_id: null,
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    mark: null,
    total_tokens: 0,
    pending_launch_config: null,
    goal_mode: false,
    goal_success_criteria: null,
    note: null,
    created_from_session: true,
    auto_approve_review: false,
    auto_approve_plan: false,
    ...overrides
  }
}

function seed(ticket: KanbanTicket): void {
  useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [ticket]]]) })
}

function columnOf(ticketId: string) {
  return useKanbanStore.getState().tickets.get(PROJECT_ID)?.find((t) => t.id === ticketId)?.column
}

/** Seed the ticket prompt queue by replaying the public add action per item. */
function setQueue(ticketId: string, contents: string[]): void {
  for (const c of contents) {
    useKanbanStore.getState().addQueuedPrompt(PROJECT_ID, ticketId, c)
  }
}

function queueOf(ticketId: string) {
  return useKanbanStore.getState().promptQueues[ticketKey(PROJECT_ID, ticketId)] ?? []
}

function queueContents(ticketId: string): string[] {
  return queueOf(ticketId).map((p) => p.content)
}

function setVerifiedVerdict(ticketId: string, overrides: Record<string, unknown> = {}): void {
  useKanbanStore.getState().setCompletionVerdict(ticketKey(PROJECT_ID, ticketId), {
    complete: true,
    needsInput: false,
    confidence: 0.95,
    reason: 'done',
    sessionId: SESSION_ID,
    checkedAt: 1,
    movedBack: false,
    ...overrides
  })
}

const STABLE_FP: SessionFingerprint = { length: 100, hash: 'stable' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  hoisted.settings.kanbanAutoApproveReview = false
  hoisted.settings.kanbanAutoCommitOnReview = false
  hoisted.settings.kanbanAutoApproveDelaySeconds = 0
  hoisted.settings.kanbanStrictVerifyEnabled = true
  hoisted.settings.kanbanStrictVerifySnapshotEnabled = true
  hoisted.settings.kanbanStrictVerifyReviewerEnabled = true
  hoisted.settings.kanbanStrictVerifyDelaySeconds = 0
  hoisted.settings.kanbanStrictVerifyModel = ''
  hoisted.settings.kanbanStrictVerifyChars = 6000
  hoisted.settings.kanbanStrictVerifyConfidenceThreshold = 0.6
  hoisted.settings.kanbanInProgressRescueEnabled = false
  hoisted.settings.kanbanQueuePromptsEnabled = true
  hoisted.sessionStatuses = { [SESSION_ID]: { status: 'completed', timestamp: -1_000_000 } }
  hoisted.pendingFollowUp = new Map()
  hoisted.sessionSdk = 'claude-code-cli'
  hoisted.dispatch.mockReset()
  hoisted.dispatch.mockResolvedValue(true)
  hoisted.detect.mockReset()
  hoisted.fingerprint.mockReset()
  hoisted.fingerprint.mockResolvedValue(STABLE_FP)
  useKanbanStore.setState({
    tickets: new Map(),
    dependencyMap: new Map(),
    completionVerdicts: new Map(),
    promptQueues: {}
  })
})

afterEach(() => {
  vi.useRealTimers()
  useKanbanStore.setState({
    tickets: new Map(),
    dependencyMap: new Map(),
    completionVerdicts: new Map(),
    promptQueues: {}
  })
})

describe('dispatchClaudeCliQueueIfReady — gating', () => {
  it('dispatches the FIFO head and removes it from the queue when verified + queued', async () => {
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1')
    setQueue('ticket-1', ['first', 'second'])

    const ok = await useKanbanStore.getState().dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(true)
    expect(hoisted.dispatch).toHaveBeenCalledTimes(1)
    expect(hoisted.dispatch).toHaveBeenCalledWith(SESSION_ID, 'first')
    expect(queueContents('ticket-1')).toEqual(['second'])
  })

  it('leaves the head in place (no loss) and returns false when dispatch fails', async () => {
    hoisted.dispatch.mockResolvedValue(false)
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1')
    setQueue('ticket-1', ['first', 'second'])

    const ok = await useKanbanStore.getState().dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    // Peek-then-remove-on-success: a delivery failure leaves the queue untouched.
    expect(queueContents('ticket-1')).toEqual(['first', 'second'])
  })

  it('does nothing when the queue is empty', async () => {
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1')

    const ok = await useKanbanStore.getState().dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch without a verified-complete verdict', async () => {
    seed(makeTicket({ column: 'review' }))
    setQueue('ticket-1', ['first'])

    const ok = await useKanbanStore.getState().dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
    expect(queueContents('ticket-1')).toEqual(['first'])
  })

  it('does not dispatch when the verdict was bounced (movedBack)', async () => {
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1', { complete: false, movedBack: true })
    setQueue('ticket-1', ['first'])

    const ok = await useKanbanStore.getState().dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch when the verdict belongs to a different session', async () => {
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1', { sessionId: 'other-session' })
    setQueue('ticket-1', ['first'])

    const ok = await useKanbanStore.getState().dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch when the ticket is not in Review', async () => {
    seed(makeTicket({ column: 'in_progress' }))
    setVerifiedVerdict('ticket-1')
    setQueue('ticket-1', ['first'])

    const ok = await useKanbanStore.getState().dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch when the global queue toggle is off', async () => {
    hoisted.settings.kanbanQueuePromptsEnabled = false
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1')
    setQueue('ticket-1', ['first'])

    const ok = await useKanbanStore.getState().dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch when the Reviewer sub-gate is off', async () => {
    hoisted.settings.kanbanStrictVerifyReviewerEnabled = false
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1')
    setQueue('ticket-1', ['first'])

    const ok = await useKanbanStore.getState().dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch for a non-Claude-CLI session', async () => {
    hoisted.sessionSdk = 'claude-code'
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1')
    setQueue('ticket-1', ['first'])

    const ok = await useKanbanStore.getState().dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })
})

describe('Strict Verify settle drains the queue', () => {
  it('runs Strict Verify on a Review ticket WITH queued prompts, then dispatches the head', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'done' }
    })
    seed(makeTicket({ column: 'in_progress' }))
    setQueue('ticket-1', ['the next prompt'])

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    // allowQueued kept the settle alive → the Watcher ran → verified → drained.
    expect(hoisted.detect).toHaveBeenCalledTimes(1)
    expect(hoisted.dispatch).toHaveBeenCalledWith(SESSION_ID, 'the next prompt')
    expect(queueContents('ticket-1')).toEqual([])
  })

  it('queue drain takes precedence over Auto Review Bypass (stays in Review, no Done)', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'done' }
    })
    seed(makeTicket({ column: 'in_progress', auto_approve_review: true }))
    setQueue('ticket-1', ['keep going'])
    useKanbanStore.setState({
      dependencyMap: new Map([
        [ticketKey(PROJECT_ID, 'ticket-2'), new Set([ticketKey(PROJECT_ID, 'ticket-1')])]
      ])
    })

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.dispatch).toHaveBeenCalledWith(SESSION_ID, 'keep going')
    expect(columnOf('ticket-1')).toBe('review')
  })

  it('feature OFF: a session follow-up blocks the settle so the Watcher never runs', async () => {
    hoisted.settings.kanbanQueuePromptsEnabled = false
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'done' }
    })
    hoisted.pendingFollowUp.set(SESSION_ID, ['orphan prompt'])
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    // allowQueued=false → a non-empty session follow-up queue aborts the settle guard.
    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(hoisted.dispatch).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('review')
  })

  it('does not drain when the Watcher judges the ticket incomplete', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: false, confidence: 0.9, reason: 'tests failing' }
    })
    seed(makeTicket({ column: 'in_progress' }))
    setQueue('ticket-1', ['too soon'])

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.dispatch).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(queueContents('ticket-1')).toEqual(['too soon'])
  })
})

describe('startClaudeCliFollowup', () => {
  it('moves a Review ticket to In Progress and dispatches the prompt now', async () => {
    seed(makeTicket({ column: 'review' }))

    const ok = await useKanbanStore
      .getState()
      .startClaudeCliFollowup(PROJECT_ID, 'ticket-1', '  go now  ')

    expect(ok).toBe(true)
    expect(hoisted.dispatch).toHaveBeenCalledWith(SESSION_ID, 'go now')
    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('returns false without dispatching for an empty prompt', async () => {
    seed(makeTicket({ column: 'review' }))

    const ok = await useKanbanStore
      .getState()
      .startClaudeCliFollowup(PROJECT_ID, 'ticket-1', '   ')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })
})

describe('prompt queue CRUD actions', () => {
  it('addQueuedPrompt appends a trimmed prompt with a generated id', () => {
    useKanbanStore.getState().addQueuedPrompt(PROJECT_ID, 'ticket-1', '  do thing  ')

    const q = queueOf('ticket-1')
    expect(q).toHaveLength(1)
    expect(q[0].content).toBe('do thing')
    expect(typeof q[0].id).toBe('string')
    expect(q[0].id.length).toBeGreaterThan(0)
  })

  it('addQueuedPrompt ignores empty / whitespace-only content', () => {
    useKanbanStore.getState().addQueuedPrompt(PROJECT_ID, 'ticket-1', '   ')
    expect(queueOf('ticket-1')).toEqual([])
    expect(useKanbanStore.getState().promptQueues[ticketKey(PROJECT_ID, 'ticket-1')]).toBeUndefined()
  })

  it('addQueuedPrompt preserves FIFO order across calls', () => {
    setQueue('ticket-1', ['a', 'b', 'c'])
    expect(queueContents('ticket-1')).toEqual(['a', 'b', 'c'])
  })

  it('updateQueuedPrompt edits the targeted prompt content (trimmed)', () => {
    setQueue('ticket-1', ['a', 'b'])
    const [, second] = queueOf('ticket-1')
    useKanbanStore.getState().updateQueuedPrompt(PROJECT_ID, 'ticket-1', second.id, '  edited  ')
    expect(queueContents('ticket-1')).toEqual(['a', 'edited'])
  })

  it('updateQueuedPrompt with empty text removes that prompt', () => {
    setQueue('ticket-1', ['a', 'b'])
    const [first] = queueOf('ticket-1')
    useKanbanStore.getState().updateQueuedPrompt(PROJECT_ID, 'ticket-1', first.id, '   ')
    expect(queueContents('ticket-1')).toEqual(['b'])
  })

  it('updateQueuedPrompt clearing the last prompt deletes the queue key', () => {
    setQueue('ticket-1', ['only'])
    const [only] = queueOf('ticket-1')
    useKanbanStore.getState().updateQueuedPrompt(PROJECT_ID, 'ticket-1', only.id, '')
    expect(useKanbanStore.getState().promptQueues[ticketKey(PROJECT_ID, 'ticket-1')]).toBeUndefined()
  })

  it('removeQueuedPrompt removes the targeted prompt by id', () => {
    setQueue('ticket-1', ['a', 'b', 'c'])
    const [, middle] = queueOf('ticket-1')
    useKanbanStore.getState().removeQueuedPrompt(PROJECT_ID, 'ticket-1', middle.id)
    expect(queueContents('ticket-1')).toEqual(['a', 'c'])
  })

  it('removeQueuedPrompt deletes the queue key when it empties', () => {
    setQueue('ticket-1', ['only'])
    const [only] = queueOf('ticket-1')
    useKanbanStore.getState().removeQueuedPrompt(PROJECT_ID, 'ticket-1', only.id)
    expect(useKanbanStore.getState().promptQueues[ticketKey(PROJECT_ID, 'ticket-1')]).toBeUndefined()
  })

  it('moveQueuedPrompt up / down reorders neighbours', () => {
    setQueue('ticket-1', ['a', 'b', 'c'])
    const ids = queueOf('ticket-1').map((p) => p.id)
    useKanbanStore.getState().moveQueuedPrompt(PROJECT_ID, 'ticket-1', ids[2], 'up')
    expect(queueContents('ticket-1')).toEqual(['a', 'c', 'b'])
    useKanbanStore.getState().moveQueuedPrompt(PROJECT_ID, 'ticket-1', ids[0], 'down')
    expect(queueContents('ticket-1')).toEqual(['c', 'a', 'b'])
  })

  it('moveQueuedPrompt is a no-op at the boundaries', () => {
    setQueue('ticket-1', ['a', 'b'])
    const ids = queueOf('ticket-1').map((p) => p.id)
    useKanbanStore.getState().moveQueuedPrompt(PROJECT_ID, 'ticket-1', ids[0], 'up')
    useKanbanStore.getState().moveQueuedPrompt(PROJECT_ID, 'ticket-1', ids[1], 'down')
    expect(queueContents('ticket-1')).toEqual(['a', 'b'])
  })

  it('clearQueuedPrompts empties the queue for the ticket', () => {
    setQueue('ticket-1', ['a', 'b', 'c'])
    useKanbanStore.getState().clearQueuedPrompts(PROJECT_ID, 'ticket-1')
    expect(useKanbanStore.getState().promptQueues[ticketKey(PROJECT_ID, 'ticket-1')]).toBeUndefined()
  })

  it('queues are isolated per ticket key', () => {
    setQueue('ticket-1', ['x'])
    setQueue('ticket-2', ['y', 'z'])
    expect(queueContents('ticket-1')).toEqual(['x'])
    expect(queueContents('ticket-2')).toEqual(['y', 'z'])
    useKanbanStore.getState().clearQueuedPrompts(PROJECT_ID, 'ticket-1')
    expect(queueContents('ticket-2')).toEqual(['y', 'z'])
  })
})

describe('buildQueuedPromptText', () => {
  it('returns the raw content unchanged when there are no attachments', () => {
    expect(buildQueuedPromptText('do thing')).toBe('do thing')
    expect(buildQueuedPromptText('do thing', [])).toBe('do thing')
  })

  it('prepends an <attached_files> block of file paths before the content', () => {
    const out = buildQueuedPromptText('describe this', [ATT])
    expect(out).toBe(
      '<attached_files>\n<file path="/abs/shot.png">shot.png</file>\n</attached_files>\ndescribe this'
    )
  })

  it('emits only the <attached_files> block for an attachment-only prompt', () => {
    expect(buildQueuedPromptText('', [ATT])).toBe(
      '<attached_files>\n<file path="/abs/shot.png">shot.png</file>\n</attached_files>'
    )
  })
})

describe('prompt queue attachments', () => {
  it('addQueuedPrompt stores attachments alongside the content', () => {
    useKanbanStore.getState().addQueuedPrompt(PROJECT_ID, 'ticket-1', 'look', [ATT])
    const [p] = queueOf('ticket-1')
    expect(p.content).toBe('look')
    expect(p.attachments).toEqual([ATT])
  })

  it('addQueuedPrompt accepts an attachment-only prompt (empty text)', () => {
    useKanbanStore.getState().addQueuedPrompt(PROJECT_ID, 'ticket-1', '   ', [ATT])
    const [p] = queueOf('ticket-1')
    expect(p.content).toBe('')
    expect(p.attachments).toEqual([ATT])
  })

  it('updateQueuedPrompt keeps existing attachments when none are passed', () => {
    useKanbanStore.getState().addQueuedPrompt(PROJECT_ID, 'ticket-1', 'before', [ATT])
    const [p] = queueOf('ticket-1')
    useKanbanStore.getState().updateQueuedPrompt(PROJECT_ID, 'ticket-1', p.id, 'after')
    const [updated] = queueOf('ticket-1')
    expect(updated.content).toBe('after')
    expect(updated.attachments).toEqual([ATT])
  })

  it('updateQueuedPrompt with empty text keeps an attachment-bearing prompt', () => {
    useKanbanStore.getState().addQueuedPrompt(PROJECT_ID, 'ticket-1', 'before', [ATT])
    const [p] = queueOf('ticket-1')
    useKanbanStore.getState().updateQueuedPrompt(PROJECT_ID, 'ticket-1', p.id, '   ')
    const [updated] = queueOf('ticket-1')
    expect(updated?.content).toBe('')
    expect(updated?.attachments).toEqual([ATT])
  })

  it('startClaudeCliFollowup dispatches the prompt with the attachment XML prepended', async () => {
    seed(makeTicket({ column: 'review' }))
    const ok = await useKanbanStore
      .getState()
      .startClaudeCliFollowup(PROJECT_ID, 'ticket-1', 'go now', [ATT])
    expect(ok).toBe(true)
    expect(hoisted.dispatch).toHaveBeenCalledWith(SESSION_ID, buildQueuedPromptText('go now', [ATT]))
  })

  it('the Strict Verify drain dispatches the head with its attachments', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'done' }
    })
    seed(makeTicket({ column: 'in_progress' }))
    useKanbanStore.getState().addQueuedPrompt(PROJECT_ID, 'ticket-1', 'with image', [ATT])

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.dispatch).toHaveBeenCalledWith(
      SESSION_ID,
      buildQueuedPromptText('with image', [ATT])
    )
    expect(queueContents('ticket-1')).toEqual([])
  })
})
