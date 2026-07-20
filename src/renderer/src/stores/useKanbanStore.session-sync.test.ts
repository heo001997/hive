import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket, KanbanTicketColumn } from '../../../main/db/types'

// Mock the kanban RPC API so moveTicket/updateTicket don't hit a real client.
vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    ticket: {
      move: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(null),
      reorder: vi.fn().mockResolvedValue(undefined),
      addTokens: vi.fn().mockResolvedValue(null),
      getBySession: vi.fn().mockResolvedValue([])
    }
  }
}))

// moveTicket dynamically imports useSettingsStore for the follow-up trigger.
vi.mock('./useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ followUpTriggerColumn: 'done' }) }
}))

// session_completed now routes through the In Progress ⟺ Review liveness gate
// (`confirmSessionFrozen`) before promoting: it reads the session-status store and
// fingerprints the terminal. Mock both so the gate reads a quiet (frozen) terminal —
// a PTY fingerprint whose last emit is ancient (Date.now() - 0 ≫ FROZEN_IDLE_MS) —
// so a completed session deterministically advances to Review here.
vi.mock('./useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: {
    getState: () => ({ sessionStatuses: {}, clearCompletedReviewSession: () => {} })
  }
}))

vi.mock('@/api/completion-api', () => ({
  completionApi: {
    getSessionFingerprint: vi
      .fn()
      .mockResolvedValue({ length: 1, hash: 'frozen', source: 'pty', lastOutputAt: 0 }),
    detectTicketCompletion: vi.fn()
  }
}))

import { useKanbanStore } from './useKanbanStore'
import { kanbanApi } from '@/api/kanban-api'
import { completionApi } from '@/api/completion-api'

const SESSION_ID = 'sess-1'
const PROJECT_ID = 'proj-1'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: PROJECT_ID,
    title: 'A ticket',
    description: null,
    attachments: [],
    column: 'done',
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
    auto_approve_plan: false,
    note: null,
    created_from_session: true,
    auto_approve_review: false,
    ...overrides
  }
}

function seed(ticket: KanbanTicket): void {
  useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [ticket]]]) })
}

function columnOf(ticketId: string): KanbanTicketColumn | undefined {
  return useKanbanStore
    .getState()
    .tickets.get(PROJECT_ID)
    ?.find((t) => t.id === ticketId)?.column
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
  useKanbanStore.setState({ tickets: new Map() })
})

afterEach(() => {
  useKanbanStore.setState({ tickets: new Map() })
})

describe('syncTicketWithSession — done is terminal', () => {
  it('does not move a done build ticket to review on session_completed', async () => {
    seed(makeTicket({ column: 'done', mode: 'build' }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
      type: 'session_completed',
      sessionMode: 'build'
    })
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('does not move a done plan ticket to review on session_completed', async () => {
    seed(makeTicket({ column: 'done', mode: 'plan', plan_ready: false }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
      type: 'session_completed',
      sessionMode: 'plan'
    })
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('does not move a done plan ticket to review on plan_ready', async () => {
    seed(makeTicket({ column: 'done', mode: 'plan', plan_ready: false }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'plan_ready' })
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('does not move a done ticket to in_progress on plan_followup', async () => {
    seed(makeTicket({ column: 'done', mode: 'plan', plan_ready: true }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'plan_followup' })
    await flush()

    expect(columnOf('ticket-1')).toBe('done')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })
})

describe('syncTicketWithSession — rider guard (pending_launch_config)', () => {
  // A queued/un-launched ticket carries pending_launch_config and never owns the
  // session it points at — it was only attached to a shared worktree's session (or
  // swept by a handoff relink). It must NOT ride to Review when the real owner's
  // session completes/errors. Regression for the "Speckit fix — 2830" auto-move bug.
  const RIDER_PLC = '{"prompt":"queued","mode":"build"}'

  it('does NOT advance a queued rider to review on session_completed', async () => {
    seed(makeTicket({ column: 'in_progress', mode: 'build', pending_launch_config: RIDER_PLC }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
      type: 'session_completed',
      sessionMode: 'build'
    })
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })

  it('advances the owner but leaves the rider when both share one session', async () => {
    const owner = makeTicket({ id: 'owner', column: 'in_progress', pending_launch_config: null })
    const rider = makeTicket({
      id: 'rider',
      column: 'in_progress',
      sort_order: 1,
      pending_launch_config: RIDER_PLC
    })
    useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [owner, rider]]]) })

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
      type: 'session_completed',
      sessionMode: 'build'
    })
    await flush()

    expect(columnOf('owner')).toBe('review')
    expect(columnOf('rider')).toBe('in_progress')
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'owner', 'review', 0)
    expect(kanbanApi.ticket.move).not.toHaveBeenCalledWith(PROJECT_ID, 'rider', 'review', 1)
  })

  it('does NOT move a queued rider to review on session_error', async () => {
    seed(makeTicket({ column: 'in_progress', mode: 'build', pending_launch_config: RIDER_PLC }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'session_error' })
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()
  })
})

describe('syncTicketWithSession — non-done paths unchanged', () => {
  it('still advances an in_progress build ticket to review on session_completed', async () => {
    seed(makeTicket({ column: 'in_progress', mode: 'build' }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
      type: 'session_completed',
      sessionMode: 'build'
    })
    await flush()

    expect(columnOf('ticket-1')).toBe('review')
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'review', 0)
  })

  it('still returns a review ticket to in_progress on session_working', async () => {
    seed(makeTicket({ column: 'review', mode: 'build', plan_ready: false }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'session_working' })
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'in_progress', 0)
  })
})

describe('syncTicketWithSession — sustained-idle promote gate (anti-flap)', () => {
  // The In Progress ⟺ Review promotion must wait for UNBROKEN silence longer than a
  // between-turns pause (REVIEW_PROMOTE_IDLE_MS = 30s, floored by the frozen-idle
  // setting), NOT the 2.5s animation floor. A live session idle between turns emits a
  // byte within that window (lastOutputAt recent) → confirmSessionFrozen → 'active' →
  // the ticket stays In Progress instead of flip-flopping to Review and back.
  it('does NOT promote a build ticket that went quiet only briefly (idle between turns)', async () => {
    seed(makeTicket({ column: 'in_progress', mode: 'build' }))
    // Last terminal byte 5s ago — inside the 30s sustained window → still "running".
    vi.mocked(completionApi.getSessionFingerprint).mockResolvedValueOnce({
      length: 10,
      hash: 'recent',
      source: 'pty',
      lastOutputAt: Date.now() - 5_000
    })

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
      type: 'session_completed',
      sessionMode: 'build'
    })
    await flush()

    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalled()

    // A resume cancels the pending promote poll and keeps it In Progress (no flap).
    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'session_working' })
    await flush()
    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(kanbanApi.ticket.move).not.toHaveBeenCalledWith(
      PROJECT_ID,
      'ticket-1',
      'review',
      expect.anything()
    )
  })

  it('DOES promote a build ticket once the terminal is silent past the sustained window', async () => {
    seed(makeTicket({ column: 'in_progress', mode: 'build' }))
    // Last terminal byte 31s ago — past the 30s window → truly quiescent.
    vi.mocked(completionApi.getSessionFingerprint).mockResolvedValueOnce({
      length: 10,
      hash: 'stale',
      source: 'pty',
      lastOutputAt: Date.now() - 31_000
    })

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
      type: 'session_completed',
      sessionMode: 'build'
    })
    await flush()

    expect(columnOf('ticket-1')).toBe('review')
    expect(kanbanApi.ticket.move).toHaveBeenCalledWith(PROJECT_ID, 'ticket-1', 'review', 0)
  })
})
