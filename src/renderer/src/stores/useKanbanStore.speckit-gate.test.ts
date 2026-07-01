import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket, KanbanTicketColumn } from '../../../main/db/types'
import type { CompletionCheckResult, SessionFingerprint } from '@shared/types/completion'
import type { GetTicketReviewGateResult } from '@/api/completion-api'
import { buildSpeckitGateConfig } from '../lib/ticket-lifecycle'

// Mock the kanban RPC API. `createBatch` (the auto-spawn path) is reached through a
// runtime `await import('@/lib/create-tickets-from-drafts')`, which vitest may load
// in a SECOND module-graph instance of this mock — so the inline `vi.fn()` the test
// captured wouldn't be the one the helper calls. Route every method through a single
// `vi.hoisted` spy (the same trick `detect`/`gate` use) so both instances delegate
// to one shared spy and assertions see the call no matter which graph ran it.
vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    ticket: {
      move: (...args: unknown[]) => hoisted.kbMove(...args),
      update: (...args: unknown[]) => hoisted.kbUpdate(...args),
      create: (...args: unknown[]) => hoisted.kbCreate(...args),
      createBatch: (...args: unknown[]) => hoisted.kbCreateBatch(...args),
      reorder: (...args: unknown[]) => hoisted.kbReorder(...args),
      addTokens: (...args: unknown[]) => hoisted.kbAddTokens(...args),
      getBySession: (...args: unknown[]) => hoisted.kbGetBySession(...args)
    }
  }
}))

vi.mock('../lib/auto-launch', () => ({
  autoLaunchTicket: vi.fn().mockResolvedValue(undefined)
}))

// Capture the gate's needs-Tu notification (fired via a dynamic import).
const notifyTicketEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../lib/ticket-telegram-notify', () => ({
  notifyTicketEvent: (...args: unknown[]) => notifyTicketEvent(...args)
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
    kanbanInProgressRescueEnabled: false,
    kanbanAutoSpawnDraftsEnabled: true,
    kanbanAutoSpawnMaxRounds: 20
  },
  sessionStatuses: {} as Record<string, { status: string; timestamp: number } | null>,
  followUpQueue: new Map<string, string[]>(),
  kbMove: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
  kbUpdate: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
  kbCreate: vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args) => ({
    id: 'seeded',
    ...(args[1] as object)
  })),
  kbCreateBatch: vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args) => {
    const data = args[1] as { drafts: unknown[] }
    return {
      tickets: data.drafts.map((d, i) => ({ id: `spawned-${i}`, ...(d as object) })),
      dependencies: data.drafts.slice(1).map((_, i) => ({ id: `dep-${i}` }))
    }
  }),
  kbReorder: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
  kbAddTokens: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
  kbGetBySession: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue([]),
  detect: vi.fn<(...args: unknown[]) => Promise<CompletionCheckResult>>(),
  gate: vi.fn<(...args: unknown[]) => Promise<GetTicketReviewGateResult>>(),
  fingerprint: vi.fn<(...args: unknown[]) => Promise<SessionFingerprint>>(),
  toastError: vi.fn()
}))

vi.mock('./useSettingsStore', () => ({
  useSettingsStore: { getState: () => hoisted.settings }
}))

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
  useSessionStore: { getState: () => ({ pendingFollowUpMessages: hoisted.followUpQueue }) }
}))

vi.mock('@/api/completion-api', () => ({
  completionApi: {
    detectTicketCompletion: (...args: unknown[]) => hoisted.detect(...args),
    getTicketReviewGate: (...args: unknown[]) => hoisted.gate(...args),
    getSessionFingerprint: (...args: unknown[]) => hoisted.fingerprint(...args)
  }
}))

import { useKanbanStore, ticketKey } from './useKanbanStore'
// Pre-load the modules the gate pulls in via `await import(...)` so they are cached
// in THIS test's module graph before the detached settle chain runs. Without this
// they would be first-loaded inside the fire-and-forget gate chain — landing in a
// second graph (a separate copy of the `@/api/kanban-api` mock the assertions can't
// see) and not resolving via microtask flushing under fake timers.
import '@/lib/create-tickets-from-drafts'
import '@/api/completion-api'

const PROJECT_ID = 'proj-1'
const SESSION_ID = 'sess-1'
// The shared hoisted spy — see the `@/api/kanban-api` mock note above for why this
// must be the hoisted singleton and not `kanbanApi.ticket.createBatch` directly.
const createBatch = hoisted.kbCreateBatch

function makeGateTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: PROJECT_ID,
    title: 'Speckit review (gate) — 2611',
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
    lifecycle_callbacks: buildSpeckitGateConfig(),
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

function verdictOf(ticketId: string) {
  return useKanbanStore.getState().completionVerdicts.get(ticketKey(PROJECT_ID, ticketId))
}

const STABLE_FP: SessionFingerprint = { length: 100, hash: 'stable' }

/**
 * The settle timer fires `void onStrictVerifySettled(...)` (fire-and-forget), so
 * `runAllTimersAsync` cannot await the gate's chain. The gate then spins up a deep
 * stack of dynamic `import()`s (completion-api → create-tickets-from-drafts → the
 * batch RPC + reloaders). Drain the microtask queue between timer passes so that
 * chain fully resolves WITHIN the test (else its `createBatch` leaks into the next).
 */
async function settleGate(): Promise<void> {
  for (let pass = 0; pass < 5; pass += 1) {
    await vi.runAllTimersAsync()
    for (let i = 0; i < 50; i += 1) await Promise.resolve()
  }
  await vi.runAllTimersAsync()
}

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
  hoisted.settings.kanbanAutoSpawnDraftsEnabled = true
  hoisted.settings.kanbanAutoSpawnMaxRounds = 20
  hoisted.sessionStatuses = { [SESSION_ID]: { status: 'completed', timestamp: -1_000_000 } }
  hoisted.followUpQueue = new Map()
  hoisted.detect.mockReset()
  hoisted.gate.mockReset()
  hoisted.fingerprint.mockReset()
  // Default: output is frozen (S0 === S1) so Gate 1 passes through to the gate.
  hoisted.fingerprint.mockResolvedValue(STABLE_FP)
  notifyTicketEvent.mockClear()
  useKanbanStore.setState({
    tickets: new Map(),
    dependencyMap: new Map(),
    completionVerdicts: new Map(),
    // Stub the post-create reloaders so createTicketsFromDrafts doesn't hit the
    // real (un-mocked) paginated fetch path.
    loadTickets: vi.fn().mockResolvedValue(undefined),
    loadDependencies: vi.fn().mockResolvedValue(undefined)
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

describe('Speckit review GATE — arming', () => {
  it('(a) arms and reads the gate file even when the global Strict Verify toggle is OFF', async () => {
    hoisted.settings.kanbanStrictVerifyEnabled = false
    // A `pass` verdict proves the gate ran (read the file) with Strict Verify off.
    hoisted.gate.mockResolvedValue({ success: true, found: true, verdict: 'pass', reason: 'clean' })
    seed(makeGateTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await settleGate()

    // The gate read `.hive/review-gate.json` → it armed + ran despite SV being off.
    expect(hoisted.gate).toHaveBeenCalledTimes(1)
    // No AI Watcher is ever consulted on the deterministic gate path.
    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('review')
  })
})

describe('Speckit review GATE — fix (auto-spawn)', () => {
  it('(b) builds the next loop round with the gate config on review-r{R} and moves itself to Done', async () => {
    hoisted.gate.mockResolvedValue({
      success: true,
      found: true,
      verdict: 'fix',
      reason: 'found issues',
      fixes: ['null-check the handler', 'add a regression test']
    })
    seed(makeGateTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await settleGate()

    // No AI Watcher on the fix path — the file verdict alone decides it.
    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(createBatch).toHaveBeenCalledTimes(1)

    const [projectArg, payload] = createBatch.mock.calls[0] as [
      string,
      { drafts: Array<Record<string, unknown>> }
    ]
    expect(projectArg).toBe(PROJECT_ID)
    // Hive BUILDS the batch itself (fix-r1 → review-plan-r1 → review-r1).
    expect(payload.drafts).toHaveLength(3)
    expect(payload.drafts.map((d) => d.draft_key)).toEqual([
      'fix-r1',
      'review-plan-r1',
      'review-r1'
    ])

    const byKey = (k: string) => payload.drafts.find((d) => d.draft_key === k)
    // Only the review-r1 draft carries the gate config (+ todo anchor); the rest don't.
    expect(byKey('review-r1')?.lifecycle_callbacks).toEqual(buildSpeckitGateConfig())
    expect(byKey('review-r1')?.lifecycle_state).toBe('todo')
    expect(byKey('fix-r1')?.lifecycle_callbacks).toBeUndefined()
    expect(byKey('review-plan-r1')?.lifecycle_callbacks).toBeUndefined()
    // Speckit chains must launch in build mode so their gates can arm.
    expect(payload.drafts.every((d) => d.mode === 'build')).toBe(true)
    // The review findings are folded into the fix ticket so the fix agent has them.
    expect(String(byKey('fix-r1')?.description)).toContain('null-check the handler')

    // This review ticket is the chain tail → it goes to Done unconditionally.
    expect(columnOf('ticket-1')).toBe('done')
  })

  it('(f) at the round cap, does NOT spawn — leaves the ticket blocked in Review for Tu', async () => {
    hoisted.settings.kanbanAutoSpawnMaxRounds = 20
    hoisted.gate.mockResolvedValue({ success: true, found: true, verdict: 'fix', reason: 'again' })
    // The current ticket is already at round 20 → cap reached.
    seed(makeGateTicket({ column: 'in_progress', title: 'Speckit review (gate, round 20) — 2611' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await settleGate()

    expect(createBatch).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('review')
    expect(verdictOf('ticket-1')).toMatchObject({ movedBack: false, lifecycleStuck: true })
    expect(notifyTicketEvent).toHaveBeenCalledWith(
      'question',
      expect.objectContaining({ ticketId: 'ticket-1' })
    )
  })
})

describe('Speckit review GATE — pass', () => {
  it('(c) verdict pass → stays verified in Review, no spawn, no watcher', async () => {
    hoisted.gate.mockResolvedValue({ success: true, found: true, verdict: 'pass', reason: 'done' })
    seed(makeGateTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await settleGate()

    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(createBatch).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('review')
    expect(verdictOf('ticket-1')).toMatchObject({ complete: true, movedBack: false })
    expect(verdictOf('ticket-1')?.lifecycleStuck).toBeFalsy()
    expect(notifyTicketEvent).not.toHaveBeenCalled()
  })
})

describe('Speckit review GATE — needs-human / fail-safe', () => {
  it('(d) verdict needs-human → blocked in Review (NEVER bounced to In Progress)', async () => {
    hoisted.gate.mockResolvedValue({
      success: true,
      found: true,
      verdict: 'needs-human',
      reason: 'scope is ambiguous'
    })
    seed(makeGateTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await settleGate()

    expect(createBatch).not.toHaveBeenCalled()
    // The gate has NO fail→in_progress branch — it must rest in Review, not bounce.
    expect(columnOf('ticket-1')).toBe('review')
    expect(verdictOf('ticket-1')).toMatchObject({ movedBack: false, lifecycleStuck: true })
    expect(notifyTicketEvent).toHaveBeenCalledWith(
      'question',
      expect.objectContaining({ ticketId: 'ticket-1' })
    )
  })

  it('(e) gate file missing (found:false) → blocked in Review, no watcher, no spawn', async () => {
    hoisted.gate.mockResolvedValue({
      success: true,
      found: false,
      error: 'no .hive/review-gate.json'
    })
    seed(makeGateTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await settleGate()

    expect(hoisted.detect).not.toHaveBeenCalled()
    expect(createBatch).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('review')
    expect(verdictOf('ticket-1')).toMatchObject({ movedBack: false, lifecycleStuck: true })
    expect(notifyTicketEvent).toHaveBeenCalledWith(
      'question',
      expect.objectContaining({ ticketId: 'ticket-1' })
    )
  })

  it('(g) RPC read failure (success:false) → blocked in Review, no spawn', async () => {
    hoisted.gate.mockResolvedValue({ success: false, found: false, error: 'session gone' })
    seed(makeGateTicket({ column: 'in_progress' }))

    await useKanbanStore.getState().moveTicket('ticket-1', PROJECT_ID, 'review', 0)
    await settleGate()

    expect(createBatch).not.toHaveBeenCalled()
    expect(columnOf('ticket-1')).toBe('review')
    expect(verdictOf('ticket-1')).toMatchObject({ movedBack: false, lifecycleStuck: true })
  })
})
