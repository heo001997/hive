import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'
import type { CompletionCheckResult, SessionFingerprint } from '@shared/types/completion'

// Queue prompts (Claude CLI): a verified-complete Review ticket should pop the
// next pending follow-up and dispatch it. These tests drive the store gate
// (`maybeDispatchClaudeCliQueue` via the public actions + the Strict Verify
// settle path) with `dispatchClaudeCliFollowup` mocked so no PTY is touched.

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
  followUpQueue: new Map<string, string[]>(),
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
      pendingFollowUpMessages: hoisted.followUpQueue,
      getSessionById: (id: string) =>
        id === SESSION_ID ? { id, agent_sdk: hoisted.sessionSdk } : null,
      dequeueFollowUpMessage: (id: string): string | null => {
        const q = hoisted.followUpQueue.get(id) ?? []
        if (q.length === 0) return null
        const [head, ...rest] = q
        hoisted.followUpQueue.set(id, rest)
        return head
      },
      requeueFollowUpMessageFront: (id: string, msg: string): void => {
        const q = hoisted.followUpQueue.get(id) ?? []
        hoisted.followUpQueue.set(id, [msg, ...q])
      },
      enqueueFollowUpMessage: (id: string, msg: string): void => {
        const q = hoisted.followUpQueue.get(id) ?? []
        hoisted.followUpQueue.set(id, [...q, msg])
      },
      setPendingFollowUpMessages: (id: string, msgs: string[]): void => {
        hoisted.followUpQueue.set(id, msgs)
      }
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

import { useKanbanStore, ticketKey } from './useKanbanStore'

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
    ...overrides
  }
}

function seed(ticket: KanbanTicket): void {
  useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [ticket]]]) })
}

function columnOf(ticketId: string) {
  return useKanbanStore.getState().tickets.get(PROJECT_ID)?.find((t) => t.id === ticketId)?.column
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
  hoisted.followUpQueue = new Map()
  hoisted.sessionSdk = 'claude-code-cli'
  hoisted.dispatch.mockReset()
  hoisted.dispatch.mockResolvedValue(true)
  hoisted.detect.mockReset()
  hoisted.fingerprint.mockReset()
  hoisted.fingerprint.mockResolvedValue(STABLE_FP)
  useKanbanStore.setState({
    tickets: new Map(),
    dependencyMap: new Map(),
    completionVerdicts: new Map()
  })
})

afterEach(() => {
  vi.useRealTimers()
  useKanbanStore.setState({
    tickets: new Map(),
    dependencyMap: new Map(),
    completionVerdicts: new Map()
  })
})

describe('dispatchClaudeCliQueueIfReady — gating', () => {
  it('dispatches the FIFO head and dequeues it when verified + queued', async () => {
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1')
    hoisted.followUpQueue.set(SESSION_ID, ['first', 'second'])

    const ok = await useKanbanStore
      .getState()
      .dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(true)
    expect(hoisted.dispatch).toHaveBeenCalledTimes(1)
    expect(hoisted.dispatch).toHaveBeenCalledWith(SESSION_ID, 'first')
    expect(hoisted.followUpQueue.get(SESSION_ID)).toEqual(['second'])
  })

  it('requeues the prompt at the front and returns false when dispatch fails', async () => {
    hoisted.dispatch.mockResolvedValue(false)
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1')
    hoisted.followUpQueue.set(SESSION_ID, ['first', 'second'])

    const ok = await useKanbanStore
      .getState()
      .dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    // The dequeued head is restored to the front — nothing is lost.
    expect(hoisted.followUpQueue.get(SESSION_ID)).toEqual(['first', 'second'])
  })

  it('does nothing when the queue is empty', async () => {
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1')

    const ok = await useKanbanStore
      .getState()
      .dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch without a verified-complete verdict', async () => {
    seed(makeTicket({ column: 'review' }))
    hoisted.followUpQueue.set(SESSION_ID, ['first'])

    const ok = await useKanbanStore
      .getState()
      .dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch when the verdict was bounced (movedBack)', async () => {
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1', { complete: false, movedBack: true })
    hoisted.followUpQueue.set(SESSION_ID, ['first'])

    const ok = await useKanbanStore
      .getState()
      .dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch when the verdict belongs to a different session', async () => {
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1', { sessionId: 'other-session' })
    hoisted.followUpQueue.set(SESSION_ID, ['first'])

    const ok = await useKanbanStore
      .getState()
      .dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch when the ticket is not in Review', async () => {
    seed(makeTicket({ column: 'in_progress' }))
    setVerifiedVerdict('ticket-1')
    hoisted.followUpQueue.set(SESSION_ID, ['first'])

    const ok = await useKanbanStore
      .getState()
      .dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch when the global queue toggle is off', async () => {
    hoisted.settings.kanbanQueuePromptsEnabled = false
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1')
    hoisted.followUpQueue.set(SESSION_ID, ['first'])

    const ok = await useKanbanStore
      .getState()
      .dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch when the Reviewer sub-gate is off', async () => {
    hoisted.settings.kanbanStrictVerifyReviewerEnabled = false
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1')
    hoisted.followUpQueue.set(SESSION_ID, ['first'])

    const ok = await useKanbanStore
      .getState()
      .dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })

  it('does not dispatch for a non-Claude-CLI session', async () => {
    hoisted.sessionSdk = 'claude-code'
    seed(makeTicket({ column: 'review' }))
    setVerifiedVerdict('ticket-1')
    hoisted.followUpQueue.set(SESSION_ID, ['first'])

    const ok = await useKanbanStore
      .getState()
      .dispatchClaudeCliQueueIfReady(PROJECT_ID, 'ticket-1')

    expect(ok).toBe(false)
    expect(hoisted.dispatch).not.toHaveBeenCalled()
  })
})

describe('Strict Verify settle drains the queue', () => {
  it('runs Strict Verify on a Review ticket WITH queued follow-ups, then dispatches the head', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'done' }
    })
    hoisted.followUpQueue.set(SESSION_ID, ['the next prompt'])
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    // allowQueued kept the settle alive → the Watcher ran → verified → drained.
    expect(hoisted.detect).toHaveBeenCalledTimes(1)
    expect(hoisted.dispatch).toHaveBeenCalledWith(SESSION_ID, 'the next prompt')
    expect(hoisted.followUpQueue.get(SESSION_ID)).toEqual([])
  })

  it('queue drain takes precedence over Auto Review Bypass (stays in Review, no Done)', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'done' }
    })
    hoisted.followUpQueue.set(SESSION_ID, ['keep going'])
    seed(makeTicket({ column: 'in_progress', auto_approve_review: true }))
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

  it('feature OFF: a queued follow-up blocks the settle so the Watcher never runs', async () => {
    hoisted.settings.kanbanQueuePromptsEnabled = false
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'done' }
    })
    hoisted.followUpQueue.set(SESSION_ID, ['orphan prompt'])
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    // allowQueued=false → non-empty queue aborts the settle guard.
    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(hoisted.dispatch).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('review')
  })

  it('does not drain when the Watcher judges the ticket incomplete', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: false, confidence: 0.9, reason: 'tests failing' }
    })
    hoisted.followUpQueue.set(SESSION_ID, ['too soon'])
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.dispatch).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(hoisted.followUpQueue.get(SESSION_ID)).toEqual(['too soon'])
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
