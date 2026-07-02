import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket, KanbanTicketColumn } from '../../../main/db/types'

// Mock the kanban RPC API so moveTicket doesn't hit a real client.
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

// Auto-launch fires when a non-terminal ticket reaches Done — stub it out so the
// chain-advance tests stay isolated to the move logic.
vi.mock('../lib/auto-launch', () => ({
  autoLaunchTicket: vi.fn().mockResolvedValue(undefined)
}))

// Mutable test doubles for the stores/APIs the auto-approve flow consults.
const hoisted = vi.hoisted(() => ({
  settings: {
    followUpTriggerColumn: 'done' as const,
    kanbanAutoApproveReview: false,
    kanbanAutoCommitOnReview: false,
    kanbanAutoApproveDelaySeconds: 0
  },
  worktreeGet: vi.fn(),
  stageAll: vi.fn(),
  commit: vi.fn(),
  sessionStatuses: {} as Record<string, { status: string; timestamp: number } | null>,
  followUpQueue: new Map<string, string[]>()
}))

vi.mock('./useSettingsStore', () => ({
  useSettingsStore: { getState: () => hoisted.settings }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: { worktree: { get: hoisted.worktreeGet } }
}))

vi.mock('@/api/git-api', () => ({
  gitApi: { stageAll: hoisted.stageAll, commit: hoisted.commit }
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
      // Read by the auto-bypass blocking-interaction guard (C3).
      getPendingPlan: () => null
    })
  }
}))

// The auto-bypass guard (`hasBlockingInteraction`) dynamic-imports these three
// interaction stores; mock them so they resolve to "nothing pending" instantly.
// (Dynamic-importing the real, unmocked modules stalls under fake timers.)
vi.mock('./useQuestionStore', () => ({
  useQuestionStore: { getState: () => ({ getQuestions: () => [] }) }
}))
vi.mock('./usePermissionStore', () => ({
  usePermissionStore: { getState: () => ({ getPermissions: () => [] }) }
}))
vi.mock('./useCommandApprovalStore', () => ({
  useCommandApprovalStore: { getState: () => ({ getApprovals: () => [] }) }
}))

import { useKanbanStore, ticketKey } from './useKanbanStore'
import { kanbanApi } from '@/api/kanban-api'

const PROJECT_ID = 'proj-1'
const SESSION_ID = 'sess-1'

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
    auto_approve_review: true,
    auto_approve_plan: false,
    ...overrides
  }
}

function seed(ticket: KanbanTicket): void {
  useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [ticket]]]) })
}

/** Make `dependentId` depend on `blockerId`, so the blocker is non-terminal. */
function addDependent(blockerId: string, dependentId: string): void {
  useKanbanStore.setState({
    dependencyMap: new Map([
      [ticketKey(PROJECT_ID, dependentId), new Set([ticketKey(PROJECT_ID, blockerId)])]
    ])
  })
}

function columnOf(ticketId: string): KanbanTicketColumn | undefined {
  return useKanbanStore
    .getState()
    .tickets.get(PROJECT_ID)
    ?.find((t) => t.id === ticketId)?.column
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  hoisted.settings.kanbanAutoApproveReview = false
  hoisted.settings.kanbanAutoCommitOnReview = false
  hoisted.settings.kanbanAutoApproveDelaySeconds = 0
  hoisted.worktreeGet.mockResolvedValue({ path: '/wt/path' })
  hoisted.stageAll.mockResolvedValue({ success: true })
  hoisted.commit.mockResolvedValue({ success: true, commitHash: 'abc123' })
  // Default: session is genuinely idle and has been for a long time.
  hoisted.sessionStatuses = { [SESSION_ID]: { status: 'completed', timestamp: -1_000_000 } }
  hoisted.followUpQueue = new Map()
  useKanbanStore.setState({ tickets: new Map(), dependencyMap: new Map() })
})

afterEach(() => {
  vi.useRealTimers()
  useKanbanStore.setState({ tickets: new Map(), dependencyMap: new Map() })
})

describe('moveTicket — auto approve Review (chain-aware)', () => {
  describe('terminal ticket (nothing depends on it)', () => {
    it('commits but STAYS in Review — never auto-advances to Done', async () => {
      hoisted.settings.kanbanAutoApproveReview = true
      hoisted.settings.kanbanAutoCommitOnReview = true
      seed(makeTicket({ column: 'in_progress', worktree_id: 'wt-1' }))

      await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
      await vi.runAllTimersAsync()

      expect(hoisted.stageAll).toHaveBeenCalledWith('/wt/path')
      expect(hoisted.commit).toHaveBeenCalledWith('/wt/path', 'Implement feature')
      expect(columnOf('ticket-1')).toBe('review')
      expect(kanbanApi.ticket.move).not.toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'done', 0)
    })

    it('stays in Review with nothing else done when commit is off', async () => {
      hoisted.settings.kanbanAutoApproveReview = true
      hoisted.settings.kanbanAutoCommitOnReview = false
      seed(makeTicket({ column: 'in_progress', worktree_id: 'wt-1' }))

      await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
      await vi.runAllTimersAsync()

      expect(hoisted.commit).not.toHaveBeenCalled()
      expect(columnOf('ticket-1')).toBe('review')
    })
  })

  describe('non-terminal ticket (a later chain ticket depends on it)', () => {
    it('commits then advances to Done so the next chain step can launch', async () => {
      hoisted.settings.kanbanAutoApproveReview = true
      hoisted.settings.kanbanAutoCommitOnReview = true
      seed(makeTicket({ column: 'in_progress', worktree_id: 'wt-1' }))
      addDependent('ticket-1', 'ticket-2')

      await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
      await vi.runAllTimersAsync()

      expect(hoisted.commit).toHaveBeenCalledWith('/wt/path', 'Implement feature')
      expect(columnOf('ticket-1')).toBe('done')
      expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'done', 0)
    })

    it('advances to Done even with commit off', async () => {
      hoisted.settings.kanbanAutoApproveReview = true
      hoisted.settings.kanbanAutoCommitOnReview = false
      seed(makeTicket({ column: 'in_progress' }))
      addDependent('ticket-1', 'ticket-2')

      await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
      await vi.runAllTimersAsync()

      expect(hoisted.commit).not.toHaveBeenCalled()
      expect(columnOf('ticket-1')).toBe('done')
    })

    it('still advances when there is nothing to commit', async () => {
      hoisted.settings.kanbanAutoApproveReview = true
      hoisted.settings.kanbanAutoCommitOnReview = true
      hoisted.commit.mockResolvedValue({ success: false, error: 'No staged changes to commit' })
      seed(makeTicket({ column: 'in_progress', worktree_id: 'wt-1' }))
      addDependent('ticket-1', 'ticket-2')

      await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
      await vi.runAllTimersAsync()

      expect(columnOf('ticket-1')).toBe('done')
    })
  })

  describe('safety guards (apply regardless of terminality)', () => {
    it('does NOT act when the session resumed working', async () => {
      hoisted.settings.kanbanAutoApproveReview = true
      hoisted.settings.kanbanAutoCommitOnReview = true
      hoisted.sessionStatuses = { [SESSION_ID]: { status: 'working', timestamp: -1_000_000 } }
      seed(makeTicket({ column: 'in_progress', worktree_id: 'wt-1' }))
      addDependent('ticket-1', 'ticket-2')

      await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
      await vi.runAllTimersAsync()

      expect(columnOf('ticket-1')).toBe('review')
      expect(hoisted.commit).not.toHaveBeenCalled()
    })

    it('does NOT act when follow-up messages are queued', async () => {
      hoisted.settings.kanbanAutoApproveReview = true
      hoisted.settings.kanbanAutoCommitOnReview = true
      hoisted.followUpQueue = new Map([[SESSION_ID, ['do more work']]])
      seed(makeTicket({ column: 'in_progress', worktree_id: 'wt-1' }))
      addDependent('ticket-1', 'ticket-2')

      await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
      await vi.runAllTimersAsync()

      expect(columnOf('ticket-1')).toBe('review')
      expect(hoisted.commit).not.toHaveBeenCalled()
    })

    it('cancels a pending approval when the ticket bounces back to In Progress', async () => {
      hoisted.settings.kanbanAutoApproveReview = true
      hoisted.settings.kanbanAutoApproveDelaySeconds = 5
      seed(makeTicket({ column: 'in_progress' }))
      addDependent('ticket-1', 'ticket-2')

      // Enters Review (schedules a 5s approval), then bounces back to In Progress
      // before the timer fires.
      await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
      await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'in_progress', 0)
      await vi.runAllTimersAsync()

      expect(columnOf('ticket-1')).toBe('in_progress')
      expect(kanbanApi.ticket.move).not.toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'done', 0)
      expect(hoisted.commit).not.toHaveBeenCalled()
    })

    it("does nothing when the ticket's own auto-approve flag is off", async () => {
      // Global default ON must NOT override a ticket that opted out.
      hoisted.settings.kanbanAutoApproveReview = true
      hoisted.settings.kanbanAutoCommitOnReview = true
      seed(makeTicket({ column: 'in_progress', auto_approve_review: false }))
      addDependent('ticket-1', 'ticket-2')

      await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
      await vi.runAllTimersAsync()

      expect(columnOf('ticket-1')).toBe('review')
      expect(hoisted.commit).not.toHaveBeenCalled()
    })

    it('acts on a ticket whose flag is on even when the global default is off', async () => {
      // Seed-only model: the global setting only seeds new tickets; it never gates the engine.
      hoisted.settings.kanbanAutoApproveReview = false
      hoisted.settings.kanbanAutoCommitOnReview = true
      seed(makeTicket({ column: 'in_progress', worktree_id: 'wt-1', auto_approve_review: true }))
      addDependent('ticket-1', 'ticket-2')

      await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
      await vi.runAllTimersAsync()

      expect(hoisted.commit).toHaveBeenCalledWith('/wt/path', 'Implement feature')
      expect(columnOf('ticket-1')).toBe('done')
    })

    it('ignores plan tickets (review is a human gate for plans)', async () => {
      hoisted.settings.kanbanAutoApproveReview = true
      hoisted.settings.kanbanAutoCommitOnReview = true
      seed(makeTicket({ column: 'in_progress', mode: 'plan', plan_ready: true }))
      addDependent('ticket-1', 'ticket-2')

      await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
      await vi.runAllTimersAsync()

      expect(columnOf('ticket-1')).toBe('review')
      expect(hoisted.commit).not.toHaveBeenCalled()
    })
  })
})

describe('createTicket — seeds the per-ticket flag from the global default', () => {
  it('seeds true when the global default is on', async () => {
    hoisted.settings.kanbanAutoApproveReview = true
    await useKanbanStore.getState().createTicket(PROJECT_ID, {
      project_id: PROJECT_ID,
      title: 'New ticket'
    })
    expect(kanbanApi.ticket.create).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ auto_approve_review: true })
    )
  })

  it('seeds false when the global default is off', async () => {
    hoisted.settings.kanbanAutoApproveReview = false
    await useKanbanStore.getState().createTicket(PROJECT_ID, {
      project_id: PROJECT_ID,
      title: 'New ticket'
    })
    expect(kanbanApi.ticket.create).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ auto_approve_review: false })
    )
  })

  it('respects an explicit per-ticket value over the global default', async () => {
    hoisted.settings.kanbanAutoApproveReview = true
    await useKanbanStore.getState().createTicket(PROJECT_ID, {
      project_id: PROJECT_ID,
      title: 'New ticket',
      auto_approve_review: false
    })
    expect(kanbanApi.ticket.create).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ auto_approve_review: false })
    )
  })
})

describe('updateTicket — toggling the flag in place arms/cancels the settle timer', () => {
  it('arms the timer when the flag is switched on while idle in Review', async () => {
    seed(makeTicket({ column: 'review', worktree_id: 'wt-1', auto_approve_review: false }))
    addDependent('ticket-1', 'ticket-2')

    await useKanbanStore.getState().updateTicket('ticket-1', PROJECT_ID, {
      auto_approve_review: true
    })
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('done')
  })

  it('cancels a pending approval when the flag is switched off in place', async () => {
    hoisted.settings.kanbanAutoApproveDelaySeconds = 5
    seed(makeTicket({ column: 'review', worktree_id: 'wt-1', auto_approve_review: true }))
    addDependent('ticket-1', 'ticket-2')

    await useKanbanStore.getState().updateTicket('ticket-1', PROJECT_ID, {
      auto_approve_review: true
    })
    await useKanbanStore.getState().updateTicket('ticket-1', PROJECT_ID, {
      auto_approve_review: false
    })
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('review')
  })
})
