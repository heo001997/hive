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
  // Pending user-interaction state read by the auto-bypass guard (C3). Mutable so a
  // test can inject a blocking question/permission/approval/plan and assert the hold.
  pendingQuestions: [] as unknown[],
  pendingPermissions: [] as unknown[],
  pendingApprovals: [] as unknown[],
  pendingPlan: null as unknown,
  detect: vi.fn<(...args: unknown[]) => Promise<CompletionCheckResult>>(),
  fingerprint: vi.fn<(...args: unknown[]) => Promise<SessionFingerprint>>(),
  toastError: vi.fn(),
  notifyNeedsInput: vi.fn()
}))

// Stub the Telegram notify fan-out so the needsInput → "question" ping can be
// asserted without a real bot. All symbols the store dynamic-imports must be exported.
vi.mock('../lib/ticket-telegram-notify', () => ({
  notifyTicketNeedsInput: (...args: unknown[]) => hoisted.notifyNeedsInput(...args),
  notifyTicketEvent: vi.fn().mockResolvedValue(undefined),
  notifyTicketQuestion: vi.fn().mockResolvedValue(undefined),
  notifyTicketColumnChange: vi.fn(),
  clearReviewNotifyOnResume: vi.fn(),
  autoForwardTicketForUserAction: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./useSettingsStore', () => ({
  useSettingsStore: { getState: () => hoisted.settings }
}))

// Capture user-facing error toasts (the no-fail-open path surfaces detector failures here).
vi.mock('@/lib/toast', () => {
  const noop = (): undefined => undefined
  const toast = {
    error: (...args: unknown[]) => hoisted.toastError(...args),
    success: noop,
    warning: noop,
    info: noop,
    loading: noop,
    dismiss: noop,
    custom: noop,
    promise: noop
  }
  return {
    toast,
    default: toast,
    showResultToast: noop,
    gitToast: {},
    projectToast: {},
    clipboardToast: {},
    sessionToast: {}
  }
})

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
      // Read by the auto-bypass blocking-interaction guard (C3).
      getPendingPlan: () => hoisted.pendingPlan
    })
  }
}))

// The auto-bypass guard (`hasBlockingInteraction`) dynamic-imports these three
// interaction stores; mock them so they resolve instantly (dynamic-importing the
// real, unmocked modules stalls under fake timers). They read mutable hoisted
// arrays so a test can inject a pending interaction and assert the bypass is held.
vi.mock('./useQuestionStore', () => ({
  useQuestionStore: { getState: () => ({ getQuestions: () => hoisted.pendingQuestions }) }
}))
vi.mock('./usePermissionStore', () => ({
  usePermissionStore: { getState: () => ({ getPermissions: () => hoisted.pendingPermissions }) }
}))
vi.mock('./useCommandApprovalStore', () => ({
  useCommandApprovalStore: { getState: () => ({ getApprovals: () => hoisted.pendingApprovals }) }
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

// Default: a live-PTY fingerprint whose last emit is ancient (lastOutputAt: 0 ≪
// Date.now() - FROZEN_IDLE_MS) → the terminal has been still → 'frozen', so Gate 1
// passes through to the Watcher. Fingerprints lacking `source: 'pty'` fall to the
// two-sample (db) path instead — that's what the streaming/re-sample tests use.
const STABLE_FP: SessionFingerprint = { length: 100, hash: 'stable', source: 'pty', lastOutputAt: 0 }

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
  hoisted.pendingQuestions = []
  hoisted.pendingPermissions = []
  hoisted.pendingApprovals = []
  hoisted.pendingPlan = null
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

  it('leaves the ticket in Review (no Watcher) when the frozen check is inconclusive', async () => {
    // S0 captured at arm, but the settle-time S1 round-trip fails → frozen state
    // unknown → the Watcher must NOT run and the ticket stays in Review (no fail-open).
    hoisted.fingerprint
      .mockResolvedValueOnce({ length: 10, hash: 'a' }) // S0 at arm
      .mockRejectedValueOnce(new Error('pty gone')) // S1 at settle
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('review')
    expect(verdictOf('ticket-1')).toBeUndefined()
  })

  it('bounces back on a live-PTY fingerprint whose terminal emitted within the idle window', async () => {
    // The user's rule: ANY recent terminal byte (spinner/clock/token counter) = alive.
    // A pty fingerprint stamped ~now → still moving → 'active' → bounce, no model call.
    hoisted.fingerprint.mockResolvedValue({
      length: 100,
      hash: 'x',
      source: 'pty',
      lastOutputAt: Date.now()
    })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('runs the Watcher on a live-PTY fingerprint whose terminal has been silent past the idle window', async () => {
    // lastOutputAt long before now → terminal fully still → 'frozen' → Watcher runs.
    hoisted.fingerprint.mockResolvedValue({
      length: 100,
      hash: 'x',
      source: 'pty',
      lastOutputAt: Date.now() - 10_000
    })
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

  it('parks a needsInput verdict in Review (waiting on the user, not moved back)', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: true, confidence: 0.9, reason: 'Which DB?' }
    })
    seed(makeTicket({ column: 'in_progress', worktree_id: 'wt-x' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    // Waiting-on-user is a Review state (paused, awaiting Tu) — NOT a bounce back to
    // In Progress. The ticket stays in Review with the Question badge; movedBack=false.
    expect(columnOf('ticket-1')).toBe('review')
    expect(verdictOf('ticket-1')).toMatchObject({ movedBack: false, needsInput: true })
    // The waiting-on-user verdict is the ONLY signal for plain-text question flows
    // (e.g. speckit clarify-all) — it must fire the Telegram "question" fan-out.
    expect(hoisted.notifyNeedsInput).toHaveBeenCalledTimes(1)
    expect(hoisted.notifyNeedsInput).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 'ticket-1', sessionId: SESSION_ID, worktreeId: 'wt-x' })
    )
  })

  it('does NOT fire the question notify for a plain incomplete verdict (not needsInput)', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: false, confidence: 0.9, reason: 'tests failing' }
    })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(hoisted.notifyNeedsInput).not.toHaveBeenCalled()
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

  it('no fail-open: a provider error leaves the ticket in Review with NO verdict, surfaced as a toast', async () => {
    hoisted.detect.mockResolvedValue({ success: false, error: 'provider down' })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('review')
    // No fake "complete" verdict is fabricated — the error is real and visible.
    expect(verdictOf('ticket-1')).toBeUndefined()
    expect(hoisted.toastError).toHaveBeenCalledTimes(1)
    expect(hoisted.toastError.mock.calls[0][0]).toContain('provider down')
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
  it('snapshot off: still runs the frozen check via a fresh re-sample (streaming → bounce)', async () => {
    hoisted.settings.kanbanStrictVerifySnapshotEnabled = false
    // No S0 is armed, so the frozen check samples a fresh pair at fire time; the
    // output changed between them → still emitting → bounce, the Watcher never runs.
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

    expect(hoisted.fingerprint).toHaveBeenCalledTimes(2)
    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('snapshot off: a stable fresh re-sample is frozen → the Watcher runs', async () => {
    hoisted.settings.kanbanStrictVerifySnapshotEnabled = false
    // A non-PTY (db) source has no last-emit timestamp, so the frozen check samples a
    // fresh pair; identical fingerprints → stable → frozen. (The re-sample path is the
    // db fallback — a live-PTY session instead uses the single-read timestamp branch.)
    hoisted.fingerprint.mockResolvedValue({ length: 100, hash: 'stable', source: 'db', lastOutputAt: 0 })
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'done' }
    })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.fingerprint).toHaveBeenCalledTimes(2)
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

  it('both sub-gates off: the frozen check still runs, then verifies with no model call', async () => {
    hoisted.settings.kanbanStrictVerifySnapshotEnabled = false
    hoisted.settings.kanbanStrictVerifyReviewerEnabled = false
    // db source → the fresh re-sample pair matches → frozen; Reviewer off → verified.
    hoisted.fingerprint.mockResolvedValue({ length: 100, hash: 'stable', source: 'db', lastOutputAt: 0 })
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(hoisted.fingerprint).toHaveBeenCalledTimes(2)
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

  // NO FAIL-OPEN. A Reviewer that THROWS (e.g. the judge returned non-JSON the
  // detector couldn't parse) must NOT fabricate a "complete" verdict and must NOT
  // advance the ticket. We trust the agent, but a detector failure is a real error:
  // the ticket rests in Review with NO verdict, and the error is surfaced (toast)
  // + logged so it can be traced — never silently swallowed into Done.
  it('does NOT advance when the Reviewer throws — stays in Review, error surfaced (auto-approve on)', async () => {
    hoisted.detect.mockRejectedValue(new Error('Could not extract JSON from AI response'))
    seed(makeTicket({ column: 'in_progress', auto_approve_review: true }))
    addDependent('ticket-1', 'ticket-2')

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('review')
    // No verdict fabricated — Feature B has nothing to act on, so nothing advances.
    expect(verdictOf('ticket-1')).toBeUndefined()
    expect(hoisted.toastError).toHaveBeenCalledTimes(1)
    expect(hoisted.toastError.mock.calls[0][0]).toContain('Could not extract JSON from AI response')
  })

  it('does NOT advance when the Reviewer returns no verdict — stays in Review, error surfaced (auto-approve on)', async () => {
    hoisted.detect.mockResolvedValue({ success: false, error: 'provider down' })
    seed(makeTicket({ column: 'in_progress', auto_approve_review: true }))
    addDependent('ticket-1', 'ticket-2')

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('review')
    expect(verdictOf('ticket-1')).toBeUndefined()
    expect(hoisted.toastError).toHaveBeenCalledTimes(1)
    expect(hoisted.toastError.mock.calls[0][0]).toContain('provider down')
  })

  it('a Reviewer error on a NON-opted-in ticket just rests in Review with NO verdict', async () => {
    hoisted.detect.mockRejectedValue(new Error('boom'))
    seed(makeTicket({ column: 'in_progress', auto_approve_review: false }))
    addDependent('ticket-1', 'ticket-2')

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('review')
    expect(verdictOf('ticket-1')).toBeUndefined()
    expect(hoisted.toastError).toHaveBeenCalledTimes(1)
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
    // Manual recheck now confirms frozen by reading the terminal's last-emit
    // timestamp (default STABLE_FP is a stale-PTY fingerprint → frozen) — a single
    // fingerprint round-trip, not the old hook-status-only shortcut.
    expect(hoisted.fingerprint).toHaveBeenCalledTimes(1)
  })

  it('recheckTicketCompletion bounces a still-working ticket to In Progress without judging', async () => {
    // Strict Review rule: a session still actively working is not frozen → it's In
    // Progress, so the manual recheck must bounce it there WITHOUT calling the Watcher.
    hoisted.sessionStatuses = { [SESSION_ID]: { status: 'working', timestamp: 0 } }
    seed(makeTicket({ column: 'review' }))

    const verdict = await useKanbanStore.getState().recheckTicketCompletion('ticket-1', PROJECT_ID)

    expect(verdict).toBeNull()
    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('recheckTicketCompletion bounces to In Progress when the terminal emitted recently, even with a stale completed status', async () => {
    // The reported misfire: the hook status is a stale 'completed' (default in
    // beforeEach) while the terminal is still moving (spinner/clock/token counter).
    // Reading the last-emit timestamp catches it — the manual recheck must bounce,
    // NOT be declared frozen from the hook status alone and handed to the Watcher.
    hoisted.fingerprint.mockResolvedValue({
      length: 100,
      hash: 'x',
      source: 'pty',
      lastOutputAt: Date.now()
    })
    seed(makeTicket({ column: 'review' }))

    const verdict = await useKanbanStore.getState().recheckTicketCompletion('ticket-1', PROJECT_ID)

    expect(verdict).toBeNull()
    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('in_progress')
  })

  it('recheckTicketCompletion keeps a needsInput verdict in Review (not moved-back)', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: true, confidence: 0.9, reason: 'question?' }
    })
    seed(makeTicket({ column: 'review' }))

    const verdict = await useKanbanStore.getState().recheckTicketCompletion('ticket-1', PROJECT_ID)
    // Waiting-on-user parks in Review (paused, awaiting Tu) — it is not a bounce.
    expect(verdict?.movedBack).toBe(false)
    expect(verdict?.needsInput).toBe(true)
    expect(columnOf('ticket-1')).toBe('review')
  })

  it('recheckTicketCompletion returns null when the ticket has no session', async () => {
    seed(makeTicket({ column: 'review', current_session_id: null }))
    const verdict = await useKanbanStore.getState().recheckTicketCompletion('ticket-1', PROJECT_ID)
    expect(verdict).toBeNull()
    expect(hoisted.detect).not.toHaveBeenCalled()
  })

  it('recheckTicketCompletion surfaces a toast and returns null when the detector throws (no fail-open)', async () => {
    hoisted.detect.mockRejectedValue(new Error('judge unreachable'))
    seed(makeTicket({ column: 'review', auto_approve_review: true }))
    addDependent('ticket-1', 'ticket-2')

    const verdict = await useKanbanStore.getState().recheckTicketCompletion('ticket-1', PROJECT_ID)
    await vi.runAllTimersAsync()

    expect(verdict).toBeNull()
    expect(columnOf('ticket-1')).toBe('review')
    expect(verdictOf('ticket-1')).toBeUndefined()
    expect(hoisted.toastError).toHaveBeenCalledTimes(1)
    expect(hoisted.toastError.mock.calls[0][0]).toContain('judge unreachable')
  })

  it('recheckTicketCompletion surfaces a toast and returns null when the detector returns no verdict', async () => {
    hoisted.detect.mockResolvedValue({ success: false, error: 'provider down' })
    seed(makeTicket({ column: 'review', auto_approve_review: true }))

    const verdict = await useKanbanStore.getState().recheckTicketCompletion('ticket-1', PROJECT_ID)
    await vi.runAllTimersAsync()

    expect(verdict).toBeNull()
    expect(columnOf('ticket-1')).toBe('review')
    expect(hoisted.toastError).toHaveBeenCalledTimes(1)
    expect(hoisted.toastError.mock.calls[0][0]).toContain('provider down')
  })

  // Regression: a manual "Verify with AI" that PASSED used to store the verdict
  // but never hand off to Feature B, so an auto-approve chain ticket just sat in
  // Review (no commit, no advance). It must now finalize like the automatic pass.
  it('recheckTicketCompletion advances an auto-approve chain ticket to Done when verified', async () => {
    hoisted.settings.kanbanAutoCommitOnReview = true
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'all done' }
    })
    seed(makeTicket({ column: 'review', worktree_id: 'wt-1', auto_approve_review: true }))
    addDependent('ticket-1', 'ticket-2')

    const verdict = await useKanbanStore.getState().recheckTicketCompletion('ticket-1', PROJECT_ID)
    await vi.runAllTimersAsync()

    expect(verdict).toMatchObject({ complete: true, movedBack: false })
    expect(columnOf('ticket-1')).toBe('done')
  })

  it('recheckTicketCompletion leaves a verified terminal ticket in Review (no dependent)', async () => {
    hoisted.settings.kanbanAutoCommitOnReview = true
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'done' }
    })
    seed(makeTicket({ column: 'review', worktree_id: 'wt-1', auto_approve_review: true }))

    await useKanbanStore.getState().recheckTicketCompletion('ticket-1', PROJECT_ID)
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('review')
  })

  it('recheckTicketCompletion does NOT advance a verified ticket that opted out of auto-approve', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'done' }
    })
    seed(makeTicket({ column: 'review', auto_approve_review: false }))
    addDependent('ticket-1', 'ticket-2')

    await useKanbanStore.getState().recheckTicketCompletion('ticket-1', PROJECT_ID)
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('review')
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

  it('does NOT re-promote when the session resumed working, even if the byte-fingerprint looks frozen', async () => {
    // Regression: the rescue frozen-check used a raw S0/S1 fingerprint compare that
    // ignored SessionStatus. A session mid-turn (status `working`) whose emitted-byte
    // stream is momentarily stable read as "frozen" → rescue re-promoted a genuinely
    // running ticket to Review, where the edge-triggered puller could not recover it.
    // Now it routes through `confirmSessionFrozen`, which returns `active` for any
    // `working` session → the ticket stays In Progress.
    hoisted.settings.kanbanInProgressRescueEnabled = true
    // Non-zero delay so we can flip the status between Gate 1 (bounce) and the rescue.
    hoisted.settings.kanbanStrictVerifyDelaySeconds = 1
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: false, needsInput: false, confidence: 0.9, reason: 'not done' }
    })
    // STABLE_FP (pty, ancient lastOutputAt) → the byte-fingerprint reads "frozen" the
    // whole time; only the status flip below should change the rescue's mind.
    seed(makeTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    // Gate 1: status still `completed` → frozen → Watcher bounces → arms the rescue.
    await vi.advanceTimersByTimeAsync(1_100)
    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(hoisted.detect).toHaveBeenCalledTimes(1)

    // Agent resumes mid-turn: status flips to `working` (bytes still momentarily stable).
    hoisted.sessionStatuses[SESSION_ID] = { status: 'working', timestamp: 0 }

    // Rescue settle: confirmSessionFrozen sees `working` → `active` → leave In Progress.
    await vi.advanceTimersByTimeAsync(1_100)
    await vi.runAllTimersAsync()
    expect(columnOf('ticket-1')).toBe('in_progress')
    expect(hoisted.detect).toHaveBeenCalledTimes(1)
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

    // needsInput parks in Review (waiting on Tu) — it never bounces, so it is not a
    // frozen-rescue candidate: judged once, no re-promote, stays in Review.
    expect(hoisted.detect).toHaveBeenCalledTimes(1)
    expect(columnOf('ticket-1')).toBe('review')
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

// The In Progress ⟺ Review boundary is governed by actual terminal liveness, not by
// the main agent's idle/Stop event. `session_completed` no longer moves the ticket
// straight to Review: it defers to `promoteToReviewWhenQuiescent`, which holds the
// ticket In Progress while the tty is still emitting (a subagent on the same tty, the
// next turn, the parent spinner) and promotes only once the process goes quiet.
describe('Liveness gate on session_completed (In Progress ⟺ Review authority)', () => {
  it('holds the ticket In Progress while the session is still emitting, then promotes once it goes quiet', async () => {
    // Isolate the liveness gate from the Strict Verify machinery that arms on the
    // eventual move to Review.
    hoisted.settings.kanbanStrictVerifyEnabled = false
    // `working` = the terminal is actively emitting (a subagent belongs to the main
    // agent, so while ANY of them emits the WHOLE process is running).
    hoisted.sessionStatuses = { [SESSION_ID]: { status: 'working', timestamp: 0 } }
    seed(makeTicket({ column: 'in_progress' }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
      type: 'session_completed',
      sessionMode: 'build'
    })
    // Well under one idle window — the poll has not fired, and it must not promote
    // early: still running → stays In Progress.
    await vi.advanceTimersByTimeAsync(500)
    expect(columnOf('ticket-1')).toBe('in_progress')

    // Terminal goes quiet (the default STABLE_FP fingerprint reads frozen). The next
    // poll sees no liveness and promotes — self-driving, no further event needed.
    hoisted.sessionStatuses[SESSION_ID] = { status: 'completed', timestamp: 0 }
    await vi.runAllTimersAsync()
    expect(columnOf('ticket-1')).toBe('review')
  })

  it('promotes to Review when the session is already gone (fingerprint unavailable → unknown)', async () => {
    hoisted.settings.kanbanStrictVerifyEnabled = false
    // Not `working`, and the fingerprint round-trip fails → confirmSessionFrozen is
    // 'unknown' (PTY/session likely gone) → treat as no-longer-running → promote.
    hoisted.fingerprint.mockRejectedValue(new Error('session gone'))
    seed(makeTicket({ column: 'in_progress' }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, {
      type: 'session_completed',
      sessionMode: 'build'
    })
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('review')
  })
})

// A pending question is a Review state (paused, waiting on Tu, with the "Question"
// badge). Unlike completion, a pending question is definitively quiescent — nothing
// emits until it is answered — so it moves to Review with NO liveness gate, even while
// the status still reads `working`. `session_working` (the answer resumes the agent)
// returns it to In Progress.
describe('session_question → Review (waiting on the user)', () => {
  it('moves an active build ticket straight to Review even while the status still reads working', async () => {
    hoisted.settings.kanbanStrictVerifyEnabled = false
    // `working` would HOLD a session_completed in place (see the liveness-gate suite),
    // but a pending question supersedes it: the ticket is paused on the user.
    hoisted.sessionStatuses = { [SESSION_ID]: { status: 'working', timestamp: 0 } }
    seed(makeTicket({ column: 'in_progress' }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'session_question' })
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('review')
  })

  it('ignores a non-build (plan) ticket — the gate is build-only', async () => {
    hoisted.settings.kanbanStrictVerifyEnabled = false
    seed(makeTicket({ column: 'in_progress', mode: 'plan' }))

    useKanbanStore.getState().syncTicketWithSession(SESSION_ID, { type: 'session_question' })
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('in_progress')
  })
})

// Review means "no agent is running — everything is paused waiting on the user, OR all
// is complete and awaiting a final look". Auto Review Bypass must therefore NOT fast-
// forward a ticket to Done while the user still owes an answer: a pending question,
// permission, command approval, or plan approval holds the ticket in Review.
describe('Auto Review Bypass holds on a pending user interaction', () => {
  it('does not advance to Done while a structured question is still open', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'done' }
    })
    // A verified-complete verdict would normally auto-advance (see the Feature B suite),
    // but an open question means the agent is not actually free — hold it in Review.
    hoisted.pendingQuestions = [{ id: 'q1', sessionId: SESSION_ID }]
    seed(makeTicket({ column: 'in_progress', auto_approve_review: true }))
    addDependent('ticket-1', 'ticket-2')

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('review')
  })

  it('does not advance to Done while a plan is awaiting approval', async () => {
    hoisted.detect.mockResolvedValue({
      success: true,
      verdict: { complete: true, needsInput: false, confidence: 0.95, reason: 'done' }
    })
    hoisted.pendingPlan = { sessionId: SESSION_ID, plan: 'do the thing' }
    seed(makeTicket({ column: 'in_progress', auto_approve_review: true }))
    addDependent('ticket-1', 'ticket-2')

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await vi.runAllTimersAsync()

    expect(columnOf('ticket-1')).toBe('review')
  })
})
