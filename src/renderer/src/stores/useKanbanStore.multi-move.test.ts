import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'

// Keep moveTicket off the real RPC client and isolate its side effects.
vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    ticket: {
      move: vi.fn().mockResolvedValue(undefined),
      reorder: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(null)
    },
    dependency: { removeAll: vi.fn().mockResolvedValue(undefined) }
  }
}))
vi.mock('../lib/auto-launch', () => ({ autoLaunchTicket: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ followUpTriggerColumn: 'done', defaultAgentSdk: 'opencode' }) }
}))
vi.mock('./useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: { getState: () => ({ clearCompletedReviewSession: () => {} }) }
}))

import { useKanbanStore, type TicketRef } from './useKanbanStore'
import { kanbanApi } from '@/api/kanban-api'

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
    note: null,
    created_from_session: false,
    ...overrides
  }
}

const ref = (id: string): TicketRef => ({ projectId: PROJECT_ID, ticketId: id })
const ticketOf = (id: string) =>
  useKanbanStore.getState().tickets.get(PROJECT_ID)?.find((t) => t.id === id)

beforeEach(() => {
  vi.clearAllMocks()
  useKanbanStore.setState({
    tickets: new Map([
      [
        PROJECT_ID,
        [
          makeTicket({ id: 't1', column: 'todo', sort_order: 1000 }),
          makeTicket({ id: 't2', column: 'todo', sort_order: 2000 }),
          makeTicket({ id: 't3', column: 'in_progress', sort_order: 1000 })
        ]
      ]
    ]),
    dependencyMap: new Map(),
    selectedTicketKeys: new Set()
  })
})

afterEach(() => {
  useKanbanStore.setState({ tickets: new Map(), dependencyMap: new Map(), selectedTicketKeys: new Set() })
})

describe('moveTicketsToColumn (multi-select drag)', () => {
  it('moves every ref to the target column, one move call each', async () => {
    await useKanbanStore.getState().moveTicketsToColumn([ref('t1'), ref('t3')], 'done')

    expect(ticketOf('t1')?.column).toBe('done')
    expect(ticketOf('t3')?.column).toBe('done')
    expect(ticketOf('t2')?.column).toBe('todo') // untouched
    expect(kanbanApi.ticket.move).toHaveBeenCalledTimes(2)
  })

  it('appends contiguously, preserving column/sort order regardless of ref order', async () => {
    // Pass refs reversed; result order should still be t1 (todo) before t3 (in_progress).
    await useKanbanStore.getState().moveTicketsToColumn([ref('t3'), ref('t1')], 'done')

    const t1 = ticketOf('t1')!
    const t3 = ticketOf('t3')!
    expect(t1.column).toBe('done')
    expect(t3.column).toBe('done')
    expect(t1.sort_order).toBeLessThan(t3.sort_order)
  })

  it('ignores refs that no longer resolve to a ticket', async () => {
    await useKanbanStore.getState().moveTicketsToColumn([ref('t1'), ref('ghost')], 'review')

    expect(ticketOf('t1')?.column).toBe('review')
    expect(kanbanApi.ticket.move).toHaveBeenCalledTimes(1)
  })
})

describe('toggleSelectedTicketKey (Cmd/Ctrl-click)', () => {
  it('adds a key when absent and removes it when present', () => {
    const { toggleSelectedTicketKey } = useKanbanStore.getState()

    toggleSelectedTicketKey('a')
    expect([...useKanbanStore.getState().selectedTicketKeys]).toEqual(['a'])

    toggleSelectedTicketKey('b')
    expect(useKanbanStore.getState().selectedTicketKeys.has('b')).toBe(true)
    expect(useKanbanStore.getState().selectedTicketKeys.size).toBe(2)

    toggleSelectedTicketKey('a')
    expect(useKanbanStore.getState().selectedTicketKeys.has('a')).toBe(false)
    expect([...useKanbanStore.getState().selectedTicketKeys]).toEqual(['b'])
  })

  it('produces a new Set reference each toggle (so card selectors re-run)', () => {
    const before = useKanbanStore.getState().selectedTicketKeys
    useKanbanStore.getState().toggleSelectedTicketKey('x')
    expect(useKanbanStore.getState().selectedTicketKeys).not.toBe(before)
  })
})
