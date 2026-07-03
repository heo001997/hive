import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'

// Integration test for the app-lifetime auto-launch owner (Core 1 + Core 2):
// initializeAutoLaunch() subscribes to KANBAN_TICKETS_CREATED and fires the
// cold-start replay once; a fired create event runs the full handleCreated chain
// (full snapshot → deps → launch) via the real store + real worktree-concurrency
// launcher, with only the RPC layer and autoLaunchTicket mocked.

const apiMocks = vi.hoisted(() => ({
  onTicketsCreated: vi.fn<(cb: (e: { projectId: string; ticketIds: string[] }) => void) => () => void>(),
  unsub: vi.fn(),
  replayPending: vi.fn().mockResolvedValue(undefined),
  getByProject: vi.fn().mockResolvedValue([]),
  diagnosticsGet: vi.fn().mockResolvedValue([]),
  getForProject: vi.fn().mockResolvedValue([])
}))

vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    ticket: { getByProject: apiMocks.getByProject },
    diagnostics: { get: apiMocks.diagnosticsGet },
    dependency: { getForProject: apiMocks.getForProject },
    watch: { onTicketsCreated: apiMocks.onTicketsCreated },
    autoLaunch: { replayPending: apiMocks.replayPending }
  }
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))

vi.mock('./useSettingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ followUpTriggerColumn: 'review', defaultAgentSdk: 'claude-code-cli' })
  }
}))

// launchReadyCreatedTickets (real, uncapped path) dynamically imports this.
const launchMocks = vi.hoisted(() => ({ autoLaunchTicket: vi.fn() }))
vi.mock('../lib/auto-launch', () => ({ autoLaunchTicket: launchMocks.autoLaunchTicket }))

import { useKanbanStore } from './useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'

const PROJECT_ID = 'project-1'

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

const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()

// Track the live cleanup so a failed test can't leave the module-level holder set
// (which would make the next test's init a no-op).
let liveCleanup: (() => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  apiMocks.onTicketsCreated.mockReturnValue(apiMocks.unsub)
  apiMocks.replayPending.mockResolvedValue(undefined)
  apiMocks.getByProject.mockResolvedValue([])
  apiMocks.diagnosticsGet.mockResolvedValue([])
  apiMocks.getForProject.mockResolvedValue([])
  // Uncapped launch path awaits autoLaunchTicket(t).catch(...), so the mock must
  // resolve a promise.
  launchMocks.autoLaunchTicket.mockResolvedValue(undefined)
  // No project row → cap 0 → uncapped launch path.
  useProjectStore.setState({ projects: [] })
})

afterEach(() => {
  liveCleanup?.()
  liveCleanup = null
  useKanbanStore.setState(initialKanbanState, true)
  useProjectStore.setState(initialProjectState, true)
})

describe('initializeAutoLaunch', () => {
  it('a fired KANBAN_TICKETS_CREATED event runs the full chain and launches the ready ticket', async () => {
    apiMocks.getByProject.mockResolvedValue([
      makeTicket({ id: 'ready', column: 'todo', pending_launch_config: QUEUED_CONFIG })
    ])

    liveCleanup = useKanbanStore.getState().initializeAutoLaunch()
    const created = apiMocks.onTicketsCreated.mock.calls[0][0]

    created({ projectId: PROJECT_ID, ticketIds: ['ready'] })

    await vi.waitFor(() => {
      expect(launchMocks.autoLaunchTicket).toHaveBeenCalledTimes(1)
    })
    // Full snapshot loader + deps were used before launching.
    expect(apiMocks.getByProject).toHaveBeenCalledWith(PROJECT_ID, false)
    expect(apiMocks.getForProject).toHaveBeenCalledWith(PROJECT_ID)
    expect(launchMocks.autoLaunchTicket.mock.calls[0][0].id).toBe('ready')
  })

  it('fires the cold-start replay exactly once on init', () => {
    liveCleanup = useKanbanStore.getState().initializeAutoLaunch()
    expect(apiMocks.replayPending).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: a second init while live subscribes only once; cleanup resets the holder', () => {
    const c1 = useKanbanStore.getState().initializeAutoLaunch()
    expect(apiMocks.onTicketsCreated).toHaveBeenCalledTimes(1)

    // Second call while the first is live is a no-op (no duplicate subscription).
    const c2 = useKanbanStore.getState().initializeAutoLaunch()
    expect(apiMocks.onTicketsCreated).toHaveBeenCalledTimes(1)
    expect(apiMocks.replayPending).toHaveBeenCalledTimes(1)
    c2()
    expect(apiMocks.unsub).not.toHaveBeenCalled()

    // Real cleanup unsubscribes and resets the holder…
    c1()
    expect(apiMocks.unsub).toHaveBeenCalledTimes(1)

    // …so a subsequent init (StrictMode setup→cleanup→setup) opens a fresh live sub.
    liveCleanup = useKanbanStore.getState().initializeAutoLaunch()
    expect(apiMocks.onTicketsCreated).toHaveBeenCalledTimes(2)
    expect(apiMocks.replayPending).toHaveBeenCalledTimes(2)
  })
})
