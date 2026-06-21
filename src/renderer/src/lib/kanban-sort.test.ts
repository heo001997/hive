import { describe, it, expect } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'
import { sortTicketsBy, SORT_STEP } from './kanban-sort'

function ticket(overrides: Partial<KanbanTicket> & { id: string }): KanbanTicket {
  return {
    project_id: 'p1',
    title: overrides.title ?? overrides.id,
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
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

const ids = (tickets: KanbanTicket[]): string[] => tickets.map((t) => t.id)

describe('sortTicketsBy', () => {
  it('SORT_STEP is the expected spacing', () => {
    expect(SORT_STEP).toBe(1000)
  })

  describe('created', () => {
    const items = [
      ticket({ id: 'b', created_at: '2024-03-01T00:00:00.000Z' }),
      ticket({ id: 'a', created_at: '2024-01-01T00:00:00.000Z' }),
      ticket({ id: 'c', created_at: '2024-02-01T00:00:00.000Z' })
    ]

    it('asc = oldest first (ISO lexicographic = chronological)', () => {
      expect(ids(sortTicketsBy(items, 'created', 'asc'))).toEqual(['a', 'c', 'b'])
    })

    it('desc = newest first', () => {
      expect(ids(sortTicketsBy(items, 'created', 'desc'))).toEqual(['b', 'c', 'a'])
    })
  })

  describe('updated', () => {
    const items = [
      ticket({ id: 'x', updated_at: '2025-06-01T12:00:00.000Z' }),
      ticket({ id: 'y', updated_at: '2025-06-01T08:00:00.000Z' }),
      ticket({ id: 'z', updated_at: '2025-06-02T00:00:00.000Z' })
    ]

    it('asc = oldest first', () => {
      expect(ids(sortTicketsBy(items, 'updated', 'asc'))).toEqual(['y', 'x', 'z'])
    })

    it('desc = newest first', () => {
      expect(ids(sortTicketsBy(items, 'updated', 'desc'))).toEqual(['z', 'x', 'y'])
    })
  })

  describe('title', () => {
    const items = [
      ticket({ id: '1', title: 'banana' }),
      ticket({ id: '2', title: 'Apple' }),
      ticket({ id: '3', title: 'cherry' })
    ]

    it('asc = A → Z, case-insensitive', () => {
      expect(ids(sortTicketsBy(items, 'title', 'asc'))).toEqual(['2', '1', '3'])
    })

    it('desc = Z → A', () => {
      expect(ids(sortTicketsBy(items, 'title', 'desc'))).toEqual(['3', '1', '2'])
    })
  })

  describe('stable tiebreak on id', () => {
    const sameTime = '2024-01-01T00:00:00.000Z'
    const items = [
      ticket({ id: 'gamma', created_at: sameTime }),
      ticket({ id: 'alpha', created_at: sameTime }),
      ticket({ id: 'beta', created_at: sameTime })
    ]

    it('asc breaks ties by ascending id', () => {
      expect(ids(sortTicketsBy(items, 'created', 'asc'))).toEqual(['alpha', 'beta', 'gamma'])
    })

    it('desc breaks ties by descending id (deterministic)', () => {
      expect(ids(sortTicketsBy(items, 'created', 'desc'))).toEqual(['gamma', 'beta', 'alpha'])
    })
  })

  it('does not mutate the input array', () => {
    const items = [
      ticket({ id: 'b', created_at: '2024-03-01T00:00:00.000Z' }),
      ticket({ id: 'a', created_at: '2024-01-01T00:00:00.000Z' })
    ]
    const before = ids(items)
    sortTicketsBy(items, 'created', 'asc')
    expect(ids(items)).toEqual(before)
  })
})
