import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'

// Integration test: real moveTicket → real worktree-concurrency launcher →
// mocked autoLaunchTicket. Proves chain-ticket + chain-ticket scenarios queue and
// run correctly under a per-project parallel-worktree cap, never exceeding it.

vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    ticket: {
      move: vi.fn().mockResolvedValue(undefined),
      reorder: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(null),
      archive: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined)
    },
    dependency: { removeAll: vi.fn().mockResolvedValue(undefined) }
  }
}))

vi.mock('./useSessionStore', () => ({
  useSessionStore: { getState: () => ({ setTicketActiveView: () => {} }) }
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))

// Trigger column = 'done': a blocker satisfies its dependents only once it reaches Done.
vi.mock('./useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ followUpTriggerColumn: 'done', defaultAgentSdk: 'opencode' }) }
}))

vi.mock('./useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: { getState: () => ({ clearCompletedReviewSession: () => {} }) }
}))

// The launcher (real) dynamically imports this mock. Implementation is wired in
// beforeEach to simulate a real launch: ticket → In Progress, pending config cleared.
const launchMocks = vi.hoisted(() => ({ autoLaunchTicket: vi.fn() }))
vi.mock('../lib/auto-launch', () => ({ autoLaunchTicket: launchMocks.autoLaunchTicket }))

import { useKanbanStore, ticketKey } from './useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'

const PROJECT_ID = 'proj-1'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket',
    project_id: PROJECT_ID,
    title: 'T',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
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
    created_from_session: false,
    auto_approve_review: false,
    ...overrides
  }
}

const QUEUED = JSON.stringify({
  worktree: { type: 'new', sourceBranch: 'main' },
  prompt: 'do work',
  mode: 'build',
  model: null,
  sdk: 'claude-code-cli',
  codexFastMode: false,
  goalMode: false,
  goalSuccessCriteria: null,
  autoApprovePlan: false
})

const ticketOf = (id: string) =>
  useKanbanStore.getState().tickets.get(PROJECT_ID)?.find((t) => t.id === id)

function runningCount(): number {
  return (useKanbanStore.getState().tickets.get(PROJECT_ID) ?? []).filter(
    (t) => t.column === 'in_progress' && !t.pending_launch_config && !t.archived_at
  ).length
}

let maxObservedRunning = 0

function setProjectCap(max: number): void {
  useProjectStore.setState({
    projects: [
      {
        id: PROJECT_ID,
        name: 'Hive',
        path: '/repo',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        detected_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        worktree_create_script: null,
        custom_commands: null,
        auto_assign_port: false,
        max_parallel_worktrees: max,
        sort_order: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        last_accessed_at: '2026-01-01T00:00:00.000Z'
      }
    ]
  })
}

const initialProjectState = useProjectStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  maxObservedRunning = 0
  // Simulate a launch: move the ticket into In Progress and clear its pending config
  // (mirrors auto-launch.ts step 5), then record peak concurrency for the cap assertion.
  launchMocks.autoLaunchTicket.mockImplementation(async (t: { id: string }) => {
    const map = new Map(useKanbanStore.getState().tickets)
    const arr = (map.get(PROJECT_ID) ?? []).map((x) =>
      x.id === t.id
        ? { ...x, column: 'in_progress' as const, pending_launch_config: null, current_session_id: `sess-${t.id}` }
        : x
    )
    map.set(PROJECT_ID, arr)
    useKanbanStore.setState({ tickets: map })
    maxObservedRunning = Math.max(maxObservedRunning, runningCount())
  })
})

afterEach(() => {
  useKanbanStore.setState({ tickets: new Map(), dependencyMap: new Map(), selectedTicketKeys: new Set() })
  useProjectStore.setState(initialProjectState, true)
})

describe('moveTicket concurrency cap + dependency chains', () => {
  it('cap=1: two chains interleave one-at-a-time, queue + run in order, never exceeding the cap', async () => {
    setProjectCap(1)
    // Chain A: A1 → A2.  Chain B: B1 → B2.  A1 already running (fills the only slot).
    useKanbanStore.setState({
      tickets: new Map([
        [
          PROJECT_ID,
          [
            makeTicket({ id: 'A1', column: 'in_progress', created_at: '2026-01-01T00:00:01.000Z' }),
            // dependency-queued tickets sit in In Progress with a pending config
            makeTicket({ id: 'A2', column: 'in_progress', pending_launch_config: QUEUED, created_at: '2026-01-01T00:00:02.000Z' }),
            // concurrency-queued chain head waits in Todo
            makeTicket({ id: 'B1', column: 'todo', pending_launch_config: QUEUED, created_at: '2026-01-01T00:00:03.000Z' }),
            makeTicket({ id: 'B2', column: 'in_progress', pending_launch_config: QUEUED, created_at: '2026-01-01T00:00:04.000Z' })
          ]
        ]
      ]),
      dependencyMap: new Map([
        [ticketKey(PROJECT_ID, 'A2'), new Set([ticketKey(PROJECT_ID, 'A1')])],
        [ticketKey(PROJECT_ID, 'B2'), new Set([ticketKey(PROJECT_ID, 'B1')])]
      ]),
      selectedTicketKeys: new Set()
    })

    expect(runningCount()).toBe(1) // only A1

    // A1 done → frees the slot. Ready: A2 (blocker A1 done) and B1 (no blocker).
    // Oldest-first → A2 launches; B1 stays queued (cap=1).
    await useKanbanStore.getState().moveTicket('A1', PROJECT_ID, 'done', 0)
    await vi.waitFor(() => {
      expect(ticketOf('A2')?.column).toBe('in_progress')
      expect(ticketOf('A2')?.pending_launch_config).toBeNull()
    })
    expect(ticketOf('B1')?.pending_launch_config).toBe(QUEUED) // still queued
    expect(ticketOf('B2')?.pending_launch_config).toBe(QUEUED) // blocked by B1
    expect(runningCount()).toBe(1)

    // A2 done → ready: B1 (no blocker). B2 still blocked by B1.
    await useKanbanStore.getState().moveTicket('A2', PROJECT_ID, 'done', 0)
    await vi.waitFor(() => {
      expect(ticketOf('B1')?.column).toBe('in_progress')
      expect(ticketOf('B1')?.pending_launch_config).toBeNull()
    })
    expect(ticketOf('B2')?.pending_launch_config).toBe(QUEUED) // still blocked
    expect(runningCount()).toBe(1)

    // B1 done → B2's blocker satisfied → B2 launches.
    await useKanbanStore.getState().moveTicket('B1', PROJECT_ID, 'done', 0)
    await vi.waitFor(() => {
      expect(ticketOf('B2')?.column).toBe('in_progress')
      expect(ticketOf('B2')?.pending_launch_config).toBeNull()
    })
    expect(runningCount()).toBe(1)

    // Across the whole run the cap was never breached.
    expect(maxObservedRunning).toBeLessThanOrEqual(1)
    // Launch order: A2, then B1, then B2.
    expect(launchMocks.autoLaunchTicket.mock.calls.map((c) => c[0].id)).toEqual(['A2', 'B1', 'B2'])
  })

  it('cap=2: two chains advance in parallel, one slot per chain, never exceeding the cap', async () => {
    setProjectCap(2)
    // Both chain heads running (cap full). A2 blocked by A1, B2 blocked by B1.
    useKanbanStore.setState({
      tickets: new Map([
        [
          PROJECT_ID,
          [
            makeTicket({ id: 'A1', column: 'in_progress', created_at: '2026-01-01T00:00:01.000Z' }),
            makeTicket({ id: 'B1', column: 'in_progress', created_at: '2026-01-01T00:00:02.000Z' }),
            makeTicket({ id: 'A2', column: 'in_progress', pending_launch_config: QUEUED, created_at: '2026-01-01T00:00:03.000Z' }),
            makeTicket({ id: 'B2', column: 'in_progress', pending_launch_config: QUEUED, created_at: '2026-01-01T00:00:04.000Z' })
          ]
        ]
      ]),
      dependencyMap: new Map([
        [ticketKey(PROJECT_ID, 'A2'), new Set([ticketKey(PROJECT_ID, 'A1')])],
        [ticketKey(PROJECT_ID, 'B2'), new Set([ticketKey(PROJECT_ID, 'B1')])]
      ]),
      selectedTicketKeys: new Set()
    })

    expect(runningCount()).toBe(2) // A1 + B1

    // A1 done → A2 launches into the freed slot (B2 still blocked by B1).
    await useKanbanStore.getState().moveTicket('A1', PROJECT_ID, 'done', 0)
    // A2 already sits in In Progress (dependency-queued) — wait on its pending
    // config clearing, which is the launch signal, not the column.
    await vi.waitFor(() => expect(ticketOf('A2')?.pending_launch_config).toBeNull())
    expect(ticketOf('A2')?.column).toBe('in_progress')
    expect(ticketOf('B2')?.pending_launch_config).toBe(QUEUED)
    expect(runningCount()).toBe(2) // A2 + B1

    // B1 done → B2 launches.
    await useKanbanStore.getState().moveTicket('B1', PROJECT_ID, 'done', 0)
    await vi.waitFor(() => expect(ticketOf('B2')?.pending_launch_config).toBeNull())
    expect(ticketOf('B2')?.column).toBe('in_progress')
    expect(runningCount()).toBe(2) // A2 + B2

    expect(maxObservedRunning).toBeLessThanOrEqual(2)
  })

  it('cap=1: does NOT launch a dependent while its blocker is still running', async () => {
    setProjectCap(1)
    useKanbanStore.setState({
      tickets: new Map([
        [
          PROJECT_ID,
          [
            makeTicket({ id: 'A1', column: 'in_progress', created_at: '2026-01-01T00:00:01.000Z' }),
            makeTicket({ id: 'A2', column: 'in_progress', pending_launch_config: QUEUED, created_at: '2026-01-01T00:00:02.000Z' })
          ]
        ]
      ]),
      dependencyMap: new Map([[ticketKey(PROJECT_ID, 'A2'), new Set([ticketKey(PROJECT_ID, 'A1')])]]),
      selectedTicketKeys: new Set()
    })

    // Move A1 only to Review (trigger is Done) → blocker not satisfied, slot not freed.
    await useKanbanStore.getState().moveTicket('A1', PROJECT_ID, 'review', 0)
    await new Promise((r) => setTimeout(r, 0))
    expect(launchMocks.autoLaunchTicket).not.toHaveBeenCalled()
    expect(ticketOf('A2')?.pending_launch_config).toBe(QUEUED)
  })

  // The user's core requirement: a chain already underway drains COMPLETELY before a
  // brand-new chain is allowed to start — even while a step sits in Review (the slot is
  // reserved for the in-flight chain, never grabbed by the waiting chain).
  it('cap=1: chain A drains fully (incl. Review gaps) before chain B starts', async () => {
    setProjectCap(1)
    // Chain A: A1 → A2 → A3 (A1 running). Chain B: single B1, queued, no blockers.
    useKanbanStore.setState({
      tickets: new Map([
        [
          PROJECT_ID,
          [
            makeTicket({ id: 'A1', column: 'in_progress', created_at: '2026-01-01T00:00:01.000Z' }),
            makeTicket({ id: 'A2', column: 'in_progress', pending_launch_config: QUEUED, created_at: '2026-01-01T00:00:02.000Z' }),
            makeTicket({ id: 'A3', column: 'in_progress', pending_launch_config: QUEUED, created_at: '2026-01-01T00:00:03.000Z' }),
            // B1 created EARLIER than A2/A3 would normally win FIFO — affinity must still
            // hold it back until chain A is fully done.
            makeTicket({ id: 'B1', column: 'todo', pending_launch_config: QUEUED, created_at: '2026-01-01T00:00:00.500Z' })
          ]
        ]
      ]),
      dependencyMap: new Map([
        [ticketKey(PROJECT_ID, 'A2'), new Set([ticketKey(PROJECT_ID, 'A1')])],
        [ticketKey(PROJECT_ID, 'A3'), new Set([ticketKey(PROJECT_ID, 'A2')])]
      ]),
      selectedTicketKeys: new Set()
    })

    // A1 → Review: slot is free (nothing running) but A is still in flight → B held back.
    await useKanbanStore.getState().moveTicket('A1', PROJECT_ID, 'review', 0)
    await new Promise((r) => setTimeout(r, 20))
    expect(ticketOf('B1')?.pending_launch_config).toBe(QUEUED) // NOT started
    expect(launchMocks.autoLaunchTicket).not.toHaveBeenCalled()

    // A1 → Done: A2 (continuation) launches; B still held.
    await useKanbanStore.getState().moveTicket('A1', PROJECT_ID, 'done', 0)
    await vi.waitFor(() => expect(ticketOf('A2')?.pending_launch_config).toBeNull())
    expect(ticketOf('B1')?.pending_launch_config).toBe(QUEUED)

    // A2 → Review (gap again): B still held.
    await useKanbanStore.getState().moveTicket('A2', PROJECT_ID, 'review', 0)
    await new Promise((r) => setTimeout(r, 20))
    expect(ticketOf('B1')?.pending_launch_config).toBe(QUEUED)

    // A2 → Done: A3 (last step) launches; B still held.
    await useKanbanStore.getState().moveTicket('A2', PROJECT_ID, 'done', 0)
    await vi.waitFor(() => expect(ticketOf('A3')?.pending_launch_config).toBeNull())
    expect(ticketOf('B1')?.pending_launch_config).toBe(QUEUED)

    // A3 → Done: chain A fully finished → only now B1 may start.
    await useKanbanStore.getState().moveTicket('A3', PROJECT_ID, 'done', 0)
    await vi.waitFor(() => expect(ticketOf('B1')?.pending_launch_config).toBeNull())
    expect(ticketOf('B1')?.column).toBe('in_progress')

    // B started strictly after A2, A3 — never interleaved.
    expect(launchMocks.autoLaunchTicket.mock.calls.map((c) => c[0].id)).toEqual(['A2', 'A3', 'B1'])
    expect(maxObservedRunning).toBeLessThanOrEqual(1)
  })

  it('cap=2, three chains: the third chain stays queued until a running chain fully finishes', async () => {
    setProjectCap(2)
    // Chains A(A1→A2), B(B1→B2), C(C1→C2). A & B running (cap full); C entirely queued.
    useKanbanStore.setState({
      tickets: new Map([
        [
          PROJECT_ID,
          [
            makeTicket({ id: 'A1', column: 'in_progress', created_at: '2026-01-01T00:00:01.000Z' }),
            makeTicket({ id: 'B1', column: 'in_progress', created_at: '2026-01-01T00:00:02.000Z' }),
            makeTicket({ id: 'A2', column: 'in_progress', pending_launch_config: QUEUED, created_at: '2026-01-01T00:00:03.000Z' }),
            makeTicket({ id: 'B2', column: 'in_progress', pending_launch_config: QUEUED, created_at: '2026-01-01T00:00:04.000Z' }),
            // C is the newest chain; both its steps queued, head has no blocker.
            makeTicket({ id: 'C1', column: 'todo', pending_launch_config: QUEUED, created_at: '2026-01-01T00:00:05.000Z' }),
            makeTicket({ id: 'C2', column: 'todo', pending_launch_config: QUEUED, created_at: '2026-01-01T00:00:06.000Z' })
          ]
        ]
      ]),
      dependencyMap: new Map([
        [ticketKey(PROJECT_ID, 'A2'), new Set([ticketKey(PROJECT_ID, 'A1')])],
        [ticketKey(PROJECT_ID, 'B2'), new Set([ticketKey(PROJECT_ID, 'B1')])],
        [ticketKey(PROJECT_ID, 'C2'), new Set([ticketKey(PROJECT_ID, 'C1')])]
      ]),
      selectedTicketKeys: new Set()
    })

    expect(runningCount()).toBe(2) // A1 + B1; C waits (2 chains already in flight)

    // A1 done → A2 continues chain A. C must NOT start (chains A & B still in flight).
    await useKanbanStore.getState().moveTicket('A1', PROJECT_ID, 'done', 0)
    await vi.waitFor(() => expect(ticketOf('A2')?.pending_launch_config).toBeNull())
    expect(ticketOf('C1')?.pending_launch_config).toBe(QUEUED)
    expect(runningCount()).toBe(2) // A2 + B1

    // A2 done → chain A fully finished → its slot opens for the next chain → C1 starts.
    await useKanbanStore.getState().moveTicket('A2', PROJECT_ID, 'done', 0)
    await vi.waitFor(() => expect(ticketOf('C1')?.pending_launch_config).toBeNull())
    expect(ticketOf('C1')?.column).toBe('in_progress')
    expect(runningCount()).toBe(2) // B1 + C1

    // C only ever started after chain A was completely done.
    const order = launchMocks.autoLaunchTicket.mock.calls.map((c) => c[0].id)
    expect(order).toEqual(['A2', 'C1'])
    expect(maxObservedRunning).toBeLessThanOrEqual(2)
  })

  // A running worktree can leave the running set WITHOUT a column move — archive,
  // delete, move-to-another-project. Each frees a slot, so each must re-drive the
  // queue, or a drain-first chain would sit stuck until some unrelated move.
  it('cap=1: archiving a running ticket frees the slot and starts the queued chain', async () => {
    setProjectCap(1)
    useKanbanStore.setState({
      tickets: new Map([
        [
          PROJECT_ID,
          [
            makeTicket({ id: 'A1', column: 'in_progress', created_at: '2026-01-01T00:00:01.000Z' }),
            makeTicket({ id: 'B1', column: 'todo', pending_launch_config: QUEUED, created_at: '2026-01-01T00:00:02.000Z' })
          ]
        ]
      ]),
      dependencyMap: new Map(),
      selectedTicketKeys: new Set()
    })

    expect(runningCount()).toBe(1) // A1 holds the only slot; B1 queued

    await useKanbanStore.getState().archiveTicket('A1', PROJECT_ID)
    await vi.waitFor(() => expect(ticketOf('B1')?.pending_launch_config).toBeNull())
    expect(ticketOf('B1')?.column).toBe('in_progress')
    expect(ticketOf('A1')?.archived_at).not.toBeNull()
    expect(runningCount()).toBe(1) // B1 now; A1 archived (no longer counts)
  })

  it('cap=1: deleting a running ticket frees the slot and starts the queued chain', async () => {
    setProjectCap(1)
    useKanbanStore.setState({
      tickets: new Map([
        [
          PROJECT_ID,
          [
            makeTicket({ id: 'A1', column: 'in_progress', created_at: '2026-01-01T00:00:01.000Z' }),
            makeTicket({ id: 'B1', column: 'todo', pending_launch_config: QUEUED, created_at: '2026-01-01T00:00:02.000Z' })
          ]
        ]
      ]),
      dependencyMap: new Map(),
      selectedTicketKeys: new Set()
    })

    await useKanbanStore.getState().deleteTicket('A1', PROJECT_ID)
    await vi.waitFor(() => expect(ticketOf('B1')?.pending_launch_config).toBeNull())
    expect(ticketOf('B1')?.column).toBe('in_progress')
    expect(ticketOf('A1')).toBeUndefined() // deleted from the board
  })
})
