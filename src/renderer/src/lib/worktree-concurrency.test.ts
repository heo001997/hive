import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useKanbanStore, ticketKey } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { KanbanTicket, KanbanTicketColumn } from '../../../main/db/types'
import type { Project } from '@shared/types/project'

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))

// launchNextQueuedTickets dynamically imports './auto-launch'; the mock resolves
// for that dynamic import. The implementation is wired per-test to simulate a
// real launch (ticket moves into In Progress, pending config cleared).
const autoLaunchMocks = vi.hoisted(() => ({ autoLaunchTicket: vi.fn() }))
vi.mock('./auto-launch', () => ({ autoLaunchTicket: autoLaunchMocks.autoLaunchTicket }))

import {
  getMaxParallelWorktrees,
  getRunningWorktreeCount,
  canLaunchWorktreeNow,
  launchNextQueuedTickets,
  launchReadyCreatedTickets
} from './worktree-concurrency'

const PROJECT_ID = 'project-1'

const initialProjectState = useProjectStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialSettingsState = useSettingsStore.getState()

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
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
    max_parallel_worktrees: 0,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    last_accessed_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: PROJECT_ID,
    title: 'Ticket',
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

function setProject(max: number): void {
  useProjectStore.setState({ projects: [makeProject({ max_parallel_worktrees: max })] })
}

function setTickets(tickets: KanbanTicket[]): void {
  useKanbanStore.setState({
    tickets: new Map([[PROJECT_ID, tickets]]),
    dependencyMap: new Map()
  })
}

const QUEUED_CONFIG = JSON.stringify({
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

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ followUpTriggerColumn: 'review' })
  // Default: simulate a successful launch — move ticket into In Progress and
  // clear its pending config so it occupies a running slot.
  autoLaunchMocks.autoLaunchTicket.mockImplementation(async (ticket: { id: string }) => {
    const map = new Map(useKanbanStore.getState().tickets)
    const arr = (map.get(PROJECT_ID) ?? []).map((t) =>
      t.id === ticket.id ? { ...t, column: 'in_progress' as KanbanTicketColumn, pending_launch_config: null } : t
    )
    map.set(PROJECT_ID, arr)
    useKanbanStore.setState({ tickets: map })
  })
})

afterEach(() => {
  useProjectStore.setState(initialProjectState, true)
  useKanbanStore.setState(initialKanbanState, true)
  useSettingsStore.setState(initialSettingsState, true)
})

describe('getMaxParallelWorktrees', () => {
  it('returns the configured positive cap', () => {
    setProject(3)
    expect(getMaxParallelWorktrees(PROJECT_ID)).toBe(3)
  })

  it('returns 0 (unlimited) when cap is 0', () => {
    setProject(0)
    expect(getMaxParallelWorktrees(PROJECT_ID)).toBe(0)
  })

  it('returns 0 for negative / unknown project', () => {
    setProject(-5)
    expect(getMaxParallelWorktrees(PROJECT_ID)).toBe(0)
    expect(getMaxParallelWorktrees('missing')).toBe(0)
  })

  it('floors fractional caps', () => {
    setProject(2.9)
    expect(getMaxParallelWorktrees(PROJECT_ID)).toBe(2)
  })
})

describe('getRunningWorktreeCount', () => {
  it('counts launched In Progress AND Human Require tickets (both hold a live worktree)', () => {
    setTickets([
      makeTicket({ id: 'a', column: 'in_progress' }),
      makeTicket({ id: 'b', column: 'in_progress' }),
      // Human Require holds a live session + worktree (agent blocked on the user) → counts.
      makeTicket({ id: 'h', column: 'human_required' }),
      // queued (still carries pending config) — not yet running, even in Human Require.
      makeTicket({ id: 'c', column: 'in_progress', pending_launch_config: QUEUED_CONFIG }),
      makeTicket({ id: 'i', column: 'human_required', pending_launch_config: QUEUED_CONFIG }),
      // other columns don't count
      makeTicket({ id: 'd', column: 'todo' }),
      makeTicket({ id: 'e', column: 'review' }),
      makeTicket({ id: 'f', column: 'done' }),
      // archived doesn't count
      makeTicket({ id: 'g', column: 'in_progress', archived_at: '2026-01-02T00:00:00.000Z' }),
      makeTicket({ id: 'j', column: 'human_required', archived_at: '2026-01-02T00:00:00.000Z' })
    ])
    expect(getRunningWorktreeCount(PROJECT_ID)).toBe(3)
  })
})

describe('canLaunchWorktreeNow', () => {
  it('always allows when unlimited', () => {
    setProject(0)
    setTickets([
      makeTicket({ id: 'a', column: 'in_progress' }),
      makeTicket({ id: 'b', column: 'in_progress' })
    ])
    expect(canLaunchWorktreeNow(PROJECT_ID)).toBe(true)
  })

  it('blocks at the cap and allows below it', () => {
    setProject(2)
    setTickets([makeTicket({ id: 'a', column: 'in_progress' })])
    expect(canLaunchWorktreeNow(PROJECT_ID)).toBe(true)
    setTickets([
      makeTicket({ id: 'a', column: 'in_progress' }),
      makeTicket({ id: 'b', column: 'in_progress' })
    ])
    expect(canLaunchWorktreeNow(PROJECT_ID)).toBe(false)
  })
})

describe('launchNextQueuedTickets', () => {
  it('no-ops when project is unlimited', async () => {
    setProject(0)
    setTickets([makeTicket({ id: 'q', column: 'todo', pending_launch_config: QUEUED_CONFIG })])
    await launchNextQueuedTickets(PROJECT_ID)
    expect(autoLaunchMocks.autoLaunchTicket).not.toHaveBeenCalled()
  })

  it('fills free slots oldest-first up to the cap', async () => {
    setProject(2)
    setTickets([
      makeTicket({ id: 'running', column: 'in_progress' }),
      makeTicket({
        id: 'newer',
        column: 'todo',
        created_at: '2026-01-03T00:00:00.000Z',
        pending_launch_config: QUEUED_CONFIG
      }),
      makeTicket({
        id: 'older',
        column: 'todo',
        created_at: '2026-01-02T00:00:00.000Z',
        pending_launch_config: QUEUED_CONFIG
      })
    ])
    await launchNextQueuedTickets(PROJECT_ID)
    // 1 running + cap 2 → exactly one slot → launch the oldest queued only
    expect(autoLaunchMocks.autoLaunchTicket).toHaveBeenCalledTimes(1)
    expect(autoLaunchMocks.autoLaunchTicket.mock.calls[0][0].id).toBe('older')
  })

  it('launches multiple when several slots are free', async () => {
    setProject(3)
    setTickets([
      makeTicket({ id: 'q1', column: 'todo', created_at: '2026-01-01T00:00:00.000Z', pending_launch_config: QUEUED_CONFIG }),
      makeTicket({ id: 'q2', column: 'todo', created_at: '2026-01-02T00:00:00.000Z', pending_launch_config: QUEUED_CONFIG }),
      makeTicket({ id: 'q3', column: 'todo', created_at: '2026-01-03T00:00:00.000Z', pending_launch_config: QUEUED_CONFIG })
    ])
    await launchNextQueuedTickets(PROJECT_ID)
    expect(autoLaunchMocks.autoLaunchTicket).toHaveBeenCalledTimes(3)
  })

  it('skips queued tickets whose blockers are unsatisfied', async () => {
    setProject(2)
    const blocked = makeTicket({
      id: 'blocked',
      column: 'todo',
      pending_launch_config: QUEUED_CONFIG
    })
    const blocker = makeTicket({ id: 'blocker', column: 'todo' })
    useProjectStore.setState({ projects: [makeProject({ max_parallel_worktrees: 2 })] })
    useKanbanStore.setState({
      tickets: new Map([[PROJECT_ID, [blocked, blocker]]]),
      // blocked depends on blocker; blocker is in 'todo' → not satisfied (trigger 'review')
      dependencyMap: new Map([
        [ticketKey(PROJECT_ID, 'blocked'), new Set([ticketKey(PROJECT_ID, 'blocker')])]
      ])
    })
    await launchNextQueuedTickets(PROJECT_ID)
    expect(autoLaunchMocks.autoLaunchTicket).not.toHaveBeenCalled()
  })

  it('serializes concurrent invocations so the cap is never exceeded', async () => {
    setProject(1)
    setTickets([
      makeTicket({
        id: 'q1',
        column: 'todo',
        created_at: '2026-01-01T00:00:00.000Z',
        pending_launch_config: QUEUED_CONFIG
      }),
      makeTicket({
        id: 'q2',
        column: 'todo',
        created_at: '2026-01-02T00:00:00.000Z',
        pending_launch_config: QUEUED_CONFIG
      })
    ])

    // Hold the q1 launch open so a second launchNextQueuedTickets call overlaps the
    // first loop. With the per-project guard, the second call sets a rerun flag and
    // returns instead of racing a concurrent drain that would launch q2 too.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    autoLaunchMocks.autoLaunchTicket.mockImplementation(async (ticket: { id: string }) => {
      if (ticket.id === 'q1') await gate
      const map = new Map(useKanbanStore.getState().tickets)
      const arr = (map.get(PROJECT_ID) ?? []).map((t) =>
        t.id === ticket.id ? { ...t, column: 'in_progress' as KanbanTicketColumn, pending_launch_config: null } : t
      )
      map.set(PROJECT_ID, arr)
      useKanbanStore.setState({ tickets: map })
    })

    const p1 = launchNextQueuedTickets(PROJECT_ID)
    const p2 = launchNextQueuedTickets(PROJECT_ID)
    await p2
    release()
    await p1

    // Only the single free slot was filled, by the oldest ticket — the overlapping
    // second call did not double-launch or exceed the cap.
    expect(autoLaunchMocks.autoLaunchTicket).toHaveBeenCalledTimes(1)
    expect(autoLaunchMocks.autoLaunchTicket.mock.calls[0][0].id).toBe('q1')
  })

  it('launches a queued ticket once its blocker is satisfied', async () => {
    setProject(2)
    const blocked = makeTicket({
      id: 'blocked',
      column: 'todo',
      pending_launch_config: QUEUED_CONFIG
    })
    const blocker = makeTicket({ id: 'blocker', column: 'done' })
    useProjectStore.setState({ projects: [makeProject({ max_parallel_worktrees: 2 })] })
    useKanbanStore.setState({
      tickets: new Map([[PROJECT_ID, [blocked, blocker]]]),
      dependencyMap: new Map([
        [ticketKey(PROJECT_ID, 'blocked'), new Set([ticketKey(PROJECT_ID, 'blocker')])]
      ])
    })
    await launchNextQueuedTickets(PROJECT_ID)
    expect(autoLaunchMocks.autoLaunchTicket).toHaveBeenCalledTimes(1)
    expect(autoLaunchMocks.autoLaunchTicket.mock.calls[0][0].id).toBe('blocked')
  })
})

describe('launchReadyCreatedTickets', () => {
  it('capped: delegates to the serialized drainer (cap respected, oldest-first)', async () => {
    setProject(2)
    setTickets([
      makeTicket({ id: 'running', column: 'in_progress' }),
      makeTicket({
        id: 'newer',
        column: 'todo',
        created_at: '2026-01-03T00:00:00.000Z',
        pending_launch_config: QUEUED_CONFIG
      }),
      makeTicket({
        id: 'older',
        column: 'todo',
        created_at: '2026-01-02T00:00:00.000Z',
        pending_launch_config: QUEUED_CONFIG
      })
    ])
    await launchReadyCreatedTickets(PROJECT_ID)
    // 1 running + cap 2 → exactly one free slot → oldest queued only.
    expect(autoLaunchMocks.autoLaunchTicket).toHaveBeenCalledTimes(1)
    expect(autoLaunchMocks.autoLaunchTicket.mock.calls[0][0].id).toBe('older')
  })

  it('uncapped: launches ready no-blocker heads; skips unsatisfied-blocker / archived / done / null-config', async () => {
    setProject(0)
    const ready = makeTicket({ id: 'ready', column: 'todo', pending_launch_config: QUEUED_CONFIG })
    const blocked = makeTicket({
      id: 'blocked',
      column: 'todo',
      pending_launch_config: QUEUED_CONFIG
    })
    const blocker = makeTicket({ id: 'blocker', column: 'todo' })
    const archived = makeTicket({
      id: 'archived',
      column: 'todo',
      pending_launch_config: QUEUED_CONFIG,
      archived_at: '2026-01-02T00:00:00.000Z'
    })
    const done = makeTicket({ id: 'done', column: 'done', pending_launch_config: QUEUED_CONFIG })
    const noConfig = makeTicket({ id: 'noConfig', column: 'todo', pending_launch_config: null })
    useKanbanStore.setState({
      tickets: new Map([[PROJECT_ID, [ready, blocked, blocker, archived, done, noConfig]]]),
      // blocked → blocker (in 'todo' → unsatisfied against trigger 'review').
      dependencyMap: new Map([
        [ticketKey(PROJECT_ID, 'blocked'), new Set([ticketKey(PROJECT_ID, 'blocker')])]
      ])
    })
    await launchReadyCreatedTickets(PROJECT_ID)
    expect(autoLaunchMocks.autoLaunchTicket).toHaveBeenCalledTimes(1)
    expect(autoLaunchMocks.autoLaunchTicket.mock.calls[0][0].id).toBe('ready')
  })

  it('concurrent double-invoke on one ready ticket launches it exactly once', async () => {
    // Capped so both calls route through the per-project serialized drainer; the
    // second call sets a rerun flag instead of racing a concurrent launch.
    setProject(1)
    setTickets([
      makeTicket({ id: 'q1', column: 'todo', pending_launch_config: QUEUED_CONFIG })
    ])

    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    autoLaunchMocks.autoLaunchTicket.mockImplementation(async (ticket: { id: string }) => {
      await gate
      const map = new Map(useKanbanStore.getState().tickets)
      const arr = (map.get(PROJECT_ID) ?? []).map((t) =>
        t.id === ticket.id
          ? { ...t, column: 'in_progress' as KanbanTicketColumn, pending_launch_config: null }
          : t
      )
      map.set(PROJECT_ID, arr)
      useKanbanStore.setState({ tickets: map })
    })

    const p1 = launchReadyCreatedTickets(PROJECT_ID)
    const p2 = launchReadyCreatedTickets(PROJECT_ID)
    await p2
    release()
    await p1

    expect(autoLaunchMocks.autoLaunchTicket).toHaveBeenCalledTimes(1)
    expect(autoLaunchMocks.autoLaunchTicket.mock.calls[0][0].id).toBe('q1')
  })
})
