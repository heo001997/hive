import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket, KanbanTicketColumn } from '../../../main/db/types'
import type { CompletionCheckResult, SessionFingerprint } from '@shared/types/completion'

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

vi.mock('../lib/auto-launch', () => ({
  autoLaunchTicket: vi.fn().mockResolvedValue(undefined)
}))

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
    kanbanInProgressRescueEnabled: false
  },
  sessionStatuses: {} as Record<string, { status: string; timestamp: number } | null>,
  followUpQueue: new Map<string, string[]>(),
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
  useSessionStore: { getState: () => ({ pendingFollowUpMessages: hoisted.followUpQueue }) }
}))

vi.mock('@/api/completion-api', () => ({
  completionApi: {
    detectTicketCompletion: (...args: unknown[]) => hoisted.detect(...args),
    getSessionFingerprint: (...args: unknown[]) => hoisted.fingerprint(...args)
  }
}))

import { useKanbanStore, ticketKey } from './useKanbanStore'

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
    auto_approve_review: false,
    auto_approve_plan: false,
    ...overrides
  }
}

function seed(ticket: KanbanTicket): void {
  useKanbanStore.setState({ tickets: new Map([[PROJECT_ID, [ticket]]]) })
}

function addDependent(blockerId: string, dependentId: string): void {
  useKanbanStore.setState({
    dependencyMap: new Map([
      [ticketKey(PROJECT_ID, dependentId), new Set([ticketKey(PROJECT_ID, blockerId)])]
    ])
  })
}

function columnOf(ticketId: string): KanbanTicketColumn | undefined {
  return useKanbanStore.getState().tickets.get(PROJECT_ID)?.find((t) => t.id === ticketId)?.column
}

function verdictOf(ticketId: string) {
  return useKanbanStore.getState().completionVerdicts.get(ticketKey(PROJECT_ID, ticketId))
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
  hoisted.settings.kanbanStrictVerifyProvider = 'claude-code'
  hoisted.settings.kanbanStrictVerifyModel = ''
  hoisted.settings.kanbanStrictVerifyChars = 6000
  hoisted.settings.kanbanStrictVerifyConfidenceThreshold = 0.6
  hoisted.settings.kanbanInProgressRescueEnabled = false
  hoisted.sessionStatuses = { [SESSION_ID]: { status: 'completed', timestamp: -1_000_000 } }
  hoisted.followUpQueue = new Map()
  hoisted.detect.mockReset()
  hoisted.fingerprint.mockReset()
  // Default: output is frozen (S0 === S1) so Gate 1 passes through to the Watcher.
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

describe('Strict Verify — Gate 1 (frozen check)', () => {
  it('bounces back WITHOUT a model call when output changed since arm time', async () => {
    // S0 (arm) ≠ S1 (settle) → session still emitting → frozen check fails.
    hoisted.fingerprint
      .mockResolvedValueOnce({ length: 10, hash: 'a' })
      .mockResolvedValueOnce({ length: 20, hash: 'b' })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('runs the Watcher when output is frozen (S1 === S0)', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'done' }
    })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.detect).toHaveBeenCalledTimes(1)
    expect(columnOf('ticket-1')).toBe('review')
  })
})

describe('Strict Verify — Gate 2 (the Watcher)', () => {
  it('moves an incomplete ticket back to In Progress and stores the verdict', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: false, confidence: 0.9, reason: 'tests failing' }
    })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.detect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        ticketId: 'ticket-1',
        maxChars: 6000,
        provider: 'claude-code'
      })
    )
    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(verdictOf('ticket-1')).toMatchObject({ movedBack: true, sessionId: SESSION_ID })
  })

  it('forwards the configured model override to the Watcher', async () => {
    hoisted.settings.kanbanStrictVerifyModel = 'claude-haiku-4-5-20251001'
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'ok' }
    })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.detect).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001' })
    )
  })

  it('treats complete=true but low confidence as incomplete', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.4, reason: 'unsure' }
    })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(verdictOf('ticket-1')?.movedBack).toBe(true)
  })

  it('bounces back and flags needsInput when the agent is asking the user', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: true, confidence: 0.9, reason: 'Which DB?' }
    })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(verdictOf('ticket-1')).toMatchObject({ movedBack: true, needsInput: true })
  })

  it('leaves a genuinely complete ticket verified in Review', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'all done' }
    })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('review')
    expect(verdictOf('ticket-1')?.movedBack).toBe(false)
  })

  it('runs even when the per-ticket auto-approve opt-in is off', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: false, confidence: 0.8, reason: 'incomplete' }
    })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.detect).toHaveBeenCalledTimes(1)
    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('fails open: a provider error leaves the verified ticket in Review', async () => {
    hoisted.detect.mockResolvedValue({ success: false, error: 'provider down' })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('review')
  })

  it('does not re-call the provider on a replay for the same session (idempotent)', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: false, confidence: 0.9, reason: 'incomplete' }
    })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()
    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(hoisted.detect).toHaveBeenCalledTimes(1)

    // Replay: shoved back into Review, settles again — cached verdict reused.
    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()
    expect(hoisted.detect).toHaveBeenCalledTimes(1)
    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('re-judges with a FRESH model call when the USER drags the ticket back to Review', async () => {
    // First judge stale-incomplete (bounced); a later fresh read would pass.
    hoisted.detect
      .mockResolvedValueOnce({
        success: true,
        verdict: { complete: false, needsInput: false, confidence: 0.9, reason: 'stale tail' }
      })
      .mockResolvedValueOnce({
        success: true,
        verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'now done' }
      })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()
    expect(hoisted.detect).toHaveBeenCalledTimes(1)
    expect(columnOf('ticket-1')).toBe('in_progress')

    // User manually drags it back into Review → cache busted → fresh judge → passes.
    await useKanbanStore
      .getState()
      .moveTicket('ticket-1', PROJECT_ID, 'review', 0, { userInitiated: true })
    await vi.runAllTimersAsync()
    expect(hoisted.detect).toHaveBeenCalledTimes(2)
    expect(columnOf('ticket-1')).toBe('review')
    expect(verdictOf('ticket-1')?.complete).toBe(true)
  })
})

describe('Strict Verify — independent sub-gate toggles', () => {
  it('snapshot off: skips Gate 1 (no fingerprint) and goes straight to the Watcher', async () => {
    hoisted.settings.kanbanStrictVerifySnapshotEnabled = false
    // Output changed — would bounce under Gate 1 — but the frozen check is off.
    hoisted.fingerprint
      .mockResolvedValueOnce({ length: 10, hash: 'a' })
      .mockResolvedValueOnce({ length: 20, hash: 'b' })
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'done' }
    })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.fingerprint).not.toHaveBeenCalled()
    expect(hoisted.detect).toHaveBeenCalledTimes(1)
    expect(columnOf('ticket-1')).toBe('review')
  })

  it('reviewer off: a ticket that clears the snapshot is verified with no model call', async () => {
    hoisted.settings.kanbanStrictVerifyReviewerEnabled = false
    // STABLE_FP (default) → frozen → Gate 1 passes; Gate 2 is disabled.
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('review')
  })

  it('reviewer off but output still streaming: Gate 1 alone bounces it back', async () => {
    hoisted.settings.kanbanStrictVerifyReviewerEnabled = false
    hoisted.fingerprint
      .mockResolvedValueOnce({ length: 10, hash: 'a' })
      .mockResolvedValueOnce({ length: 20, hash: 'b' })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('both sub-gates off: verifies immediately with neither fingerprint nor model call', async () => {
    hoisted.settings.kanbanStrictVerifySnapshotEnabled = false
    hoisted.settings.kanbanStrictVerifyReviewerEnabled = false
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.fingerprint).not.toHaveBeenCalled()
    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('review')
  })
})

describe('Strict Verify gates Auto Review Bypass (Feature B)', () => {
  it('advances to Done after a verified-complete verdict (auto-approve on)', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'done' }
    })
    seed(makeTicket({ column: 'in_progress', auto_approve_review: true }))
    addDependent('ticket-1', 'ticket-2')

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('done')
  })

  it('does not advance when the verdict is incomplete (auto-approve on)', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: false, confidence: 0.9, reason: 'nope' }
    })
    seed(makeTicket({ column: 'in_progress', auto_approve_review: true }))
    addDependent('ticket-1', 'ticket-2')

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('in_progress')
  })
})

describe('Legacy path — Strict Verify off, Auto Review Bypass on', () => {
  it('advances an auto-approve ticket to Done with no model call', async () => {
    hoisted.settings.kanbanStrictVerifyEnabled = false
    seed(makeTicket({ column: 'in_progress', auto_approve_review: true }))
    addDependent('ticket-1', 'ticket-2')

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(hoisted.fingerprint).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('done')
  })

  it('leaves a non-opted-in ticket in Review with no timers', async () => {
    hoisted.settings.kanbanStrictVerifyEnabled = false
    seed(makeTicket({ column: 'in_progress', auto_approve_review: false }))
    addDependent('ticket-1', 'ticket-2')

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('review')
  })
})

describe('completion verdict actions', () => {
  it('clears the cached verdict and cancels timers when the session resumes working', async () => {
    seed(makeTicket({ column: 'in_progress' }))
    useKanbanStore.getState().setCompletionVerdict(ticketKey(PROJECT_ID, 'ticket-1'), {
      complete: false,
      needsInput: false,
      confidence: 0.5,
      reason: 'x',
      sessionId: SESSION_ID,
      checkedAt: 1,
      movedBack: true
    })
    expect(verdictOf('ticket-1')).toBeDefined()

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'session_working' })
    expect(verdictOf('ticket-1')).toBeUndefined()
  })

  it('recheckTicketCompletion stores a verdict and moves an incomplete ticket back', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: false, confidence: 0.85, reason: 'todos remain' }
    })
    seed(makeTicket({ column: 'review' }))

    const verdict = await useKanbanStore.getState().recheckTicketCompletion('ticket-1', PROJECT_ID)
    await vi.runAllTimersAsync()

    expect(verdict?.movedBack).toBe(true)
    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(verdictOf('ticket-1')?.reason).toBe('todos remain')
    // Manual recheck skips Gate 1 entirely — no fingerprint call.
    expect(hoisted.fingerprint).not.toHaveBeenCalled()
  })

  it('recheckTicketCompletion treats needsInput as moved-back', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: true, confidence: 0.9, reason: 'question?' }
    })
    seed(makeTicket({ column: 'review' }))

    const verdict = await useKanbanStore.getState().recheckTicketCompletion('ticket-1', PROJECT_ID)
    expect(verdict?.movedBack).toBe(true)
    expect(verdict?.needsInput).toBe(true)
  })

  it('recheckTicketCompletion returns null when the ticket has no session', async () => {
    seed(makeTicket({ column: 'review', current_session_id: null }))
    const verdict = await useKanbanStore.getState().recheckTicketCompletion('ticket-1', PROJECT_ID)
    expect(verdict).toBeNull()
    expect(hoisted.detect).not.toHaveBeenCalled()
  })
})

describe('In Progress rescue (frozen "Not done" watcher)', () => {
  beforeEach(() => {
    hoisted.settings.kanbanInProgressRescueEnabled = true
    // The per-session retry budget is module-level and intentionally survives the
    // bounce cycle (so it isn't cleared by the store reset between tests). Flush any
    // leaked budget for the shared ticket/session via the real resume path.
    seed(makeTicket({ column: 'in_progress' }))
    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'session_working' })
    useKanbanStore.setState({ tickets: new Map(), completionVerdicts: new Map() })
  })

  it('re-promotes a frozen "Not done" ticket to Review for a fresh judgment', async () => {
    // First judgment incomplete (bounce), second judgment complete (verified).
    hoisted.detect
      .mockResolvedValueOnce({
        success: true,
        verdict: { complete: false, needsInput: false, confidence: 0.9, reason: 'premature' }
      })
      .mockResolvedValueOnce({
        success: true,
        verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'actually done' }
      })
    // STABLE_FP everywhere → frozen at every gate.
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    // Bounced once, re-promoted, re-judged complete → ends verified in Review.
    expect(hoisted.detect).toHaveBeenCalledTimes(2)
    expect(columnOf('ticket-1')).toBe('review')
    expect(verdictOf('ticket-1')?.complete).toBe(true)
    expect(verdictOf('ticket-1')?.rescueExhausted).toBeFalsy()
  })

  it('leaves a still-emitting (not frozen) ticket in In Progress without re-promoting', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: false, confidence: 0.9, reason: 'not done' }
    })
    // Gate 1 frozen (so the Watcher runs + bounces), but the rescue re-check sees
    // fresh output (S0 ≠ S1) → still working → leave it.
    hoisted.fingerprint
      .mockResolvedValueOnce({ length: 10, hash: 'a' }) // Gate 1 arm (S0)
      .mockResolvedValueOnce({ length: 10, hash: 'a' }) // Gate 1 settle (S1) → frozen
      .mockResolvedValueOnce({ length: 10, hash: 'a' }) // rescue arm (S0)
      .mockResolvedValueOnce({ length: 25, hash: 'b' }) // rescue settle (S1) → changed
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    // Only the single Gate-2 judgment ran; no re-promote.
    expect(hoisted.detect).toHaveBeenCalledTimes(1)
    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(verdictOf('ticket-1')?.rescueExhausted).toBeFalsy()
  })

  it('gives up after one retry: labels the card "Re-checked" and leaves it in In Progress', async () => {
    // Always incomplete + always frozen → rescue re-promotes once, then exhausts.
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: false, confidence: 0.9, reason: 'still not done' }
    })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    // Judged twice (initial + after the one re-promote), then capped.
    expect(hoisted.detect).toHaveBeenCalledTimes(2)
    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(verdictOf('ticket-1')).toMatchObject({ movedBack: true, rescueExhausted: true })
  })

  it('does not rescue a ticket that is waiting on the user (needsInput)', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: true, confidence: 0.9, reason: 'which framework?' }
    })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    // needsInput bounce is NOT a frozen-rescue candidate — judged once, no re-promote.
    expect(hoisted.detect).toHaveBeenCalledTimes(1)
    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(verdictOf('ticket-1')?.needsInput).toBe(true)
    expect(verdictOf('ticket-1')?.rescueExhausted).toBeFalsy()
  })

  it('does nothing when the rescue setting is off', async () => {
    hoisted.settings.kanbanInProgressRescueEnabled = false
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: false, confidence: 0.9, reason: 'not done' }
    })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.detect).toHaveBeenCalledTimes(1)
    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(verdictOf('ticket-1')?.rescueExhausted).toBeFalsy()
  })

  it('resets the retry budget when the session resumes working', async () => {
    // Exhaust the retry first.
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: false, confidence: 0.9, reason: 'not done' }
    })
    seed(makeTicket({ column: 'in_progress' }))
    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()
    expect(verdictOf('ticket-1')?.rescueExhausted).toBe(true)

    // Session resumes → clears verdict + retry budget.
    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'session_working' })
    expect(verdictOf('ticket-1')).toBeUndefined()
    hoisted.detect.mockClear()

    // A new settle gets a fresh retry budget again (re-promote happens once more).
    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()
    expect(hoisted.detect).toHaveBeenCalledTimes(2)
  })
})
