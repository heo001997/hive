import { describe, it, expect } from 'vitest'
import type { KanbanTicket } from '../../../main/db/types'
import { isSessionOwnedByAnotherTicket } from './session-ownership'

function ticket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'A ticket',
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
    created_from_session: true,
    auto_approve_review: false,
    ...overrides
  }
}

function byProject(...tickets: KanbanTicket[]): Map<string, KanbanTicket[]> {
  const map = new Map<string, KanbanTicket[]>()
  for (const t of tickets) {
    const list = map.get(t.project_id) ?? []
    list.push(t)
    map.set(t.project_id, list)
  }
  return map
}

describe('isSessionOwnedByAnotherTicket', () => {
  it('returns false when no ticket references the session', () => {
    const map = byProject(ticket({ id: 'a', current_session_id: null }))
    expect(isSessionOwnedByAnotherTicket(map, 'sess-1', 'self')).toBe(false)
  })

  it('returns false when only the asking ticket itself owns the session', () => {
    const map = byProject(ticket({ id: 'self', current_session_id: 'sess-1' }))
    expect(isSessionOwnedByAnotherTicket(map, 'sess-1', 'self')).toBe(false)
  })

  it('returns true when another ticket already owns the session', () => {
    const map = byProject(
      ticket({ id: 'owner', current_session_id: 'sess-1' }),
      ticket({ id: 'self', current_session_id: null })
    )
    expect(isSessionOwnedByAnotherTicket(map, 'sess-1', 'self')).toBe(true)
  })

  it('finds the owner even in a different project bucket', () => {
    const map = byProject(
      ticket({ id: 'owner', project_id: 'proj-2', current_session_id: 'sess-1' }),
      ticket({ id: 'self', project_id: 'proj-1', current_session_id: null })
    )
    expect(isSessionOwnedByAnotherTicket(map, 'sess-1', 'self')).toBe(true)
  })

  it('ignores tickets bound to a different session', () => {
    const map = byProject(
      ticket({ id: 'other', current_session_id: 'sess-2' }),
      ticket({ id: 'self', current_session_id: null })
    )
    expect(isSessionOwnedByAnotherTicket(map, 'sess-1', 'self')).toBe(false)
  })
})
