import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanBoard } from './KanbanBoard'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useBoardSearchStore } from '@/stores/useBoardSearchStore'
import type { KanbanTicket, KanbanTicketColumn } from '../../../../main/db/types'

// The board pulls in heavy DnD/modal children and a markdown watcher that hit
// the API layer. Stub them so the test exercises only the search filtering.
vi.mock('@/hooks/useMarkdownKanbanWatcher', () => ({
  useMarkdownKanbanWatcher: () => {}
}))

vi.mock('@/components/kanban/KanbanColumn', () => ({
  KanbanColumn: ({
    column,
    tickets
  }: {
    column: KanbanTicketColumn
    tickets: KanbanTicket[]
  }) => (
    <div data-testid={`col-${column}`}>
      {tickets.map((t) => (
        <span key={t.id} data-testid={`card-${t.id}`}>
          {t.title}
        </span>
      ))}
    </div>
  )
}))

vi.mock('@/components/kanban/KanbanTicketModal', () => ({ KanbanTicketModal: () => null }))
vi.mock('./MergeOnDoneDialog', () => ({ MergeOnDoneDialog: () => null }))
vi.mock('@/components/kanban/BoardChatLauncher', () => ({ BoardChatLauncher: () => null }))

const PROJECT_ID = 'proj-1'

const makeTicket = (overrides: Partial<KanbanTicket>): KanbanTicket => ({
  id: 'ticket',
  project_id: PROJECT_ID,
  title: 'Untitled',
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
})

const TICKETS: KanbanTicket[] = [
  makeTicket({ id: 't1', title: 'Fix login bug', column: 'todo', sort_order: 0 }),
  makeTicket({ id: 't2', title: 'Add dark mode', description: 'login screen tweaks', column: 'in_progress', sort_order: 1 }),
  makeTicket({ id: 't3', title: 'Refactor parser', column: 'review', sort_order: 2 })
]

const initialKanbanState = useKanbanStore.getState()
const initialSearchState = useBoardSearchStore.getState()

describe('KanbanBoard search filtering', () => {
  beforeEach(() => {
    useBoardSearchStore.setState(initialSearchState, true)
    useKanbanStore.setState({
      tickets: new Map([[PROJECT_ID, TICKETS]]),
      // No-op the loader so the mount effect doesn't overwrite seeded tickets.
      loadTickets: vi.fn(async () => {})
    })
  })

  afterEach(() => {
    cleanup()
    useKanbanStore.setState(initialKanbanState, true)
    useBoardSearchStore.setState(initialSearchState, true)
  })

  const seedSearch = (query: string) =>
    useBoardSearchStore.setState({ isOpen: true, query })

  it('shows every ticket when search is closed', () => {
    render(<KanbanBoard projectId={PROJECT_ID} />)
    expect(screen.getByTestId('card-t1')).toBeTruthy()
    expect(screen.getByTestId('card-t2')).toBeTruthy()
    expect(screen.getByTestId('card-t3')).toBeTruthy()
  })

  it('marks the board mounted so the top bar can show the control', () => {
    expect(useBoardSearchStore.getState().mounted).toBe(false)
    const { unmount } = render(<KanbanBoard projectId={PROJECT_ID} />)
    expect(useBoardSearchStore.getState().mounted).toBe(true)
    unmount()
    expect(useBoardSearchStore.getState().mounted).toBe(false)
  })

  it('filters by title and publishes the match count', () => {
    seedSearch('parser')
    render(<KanbanBoard projectId={PROJECT_ID} />)

    expect(screen.queryByTestId('card-t1')).toBeNull()
    expect(screen.queryByTestId('card-t2')).toBeNull()
    expect(screen.getByTestId('card-t3')).toBeTruthy()
    expect(useBoardSearchStore.getState().matchCount).toBe(1)
  })

  it('matches the description field, case-insensitively', () => {
    seedSearch('LOGIN')
    render(<KanbanBoard projectId={PROJECT_ID} />)

    // t1 (title) and t2 (description) both contain "login".
    expect(screen.getByTestId('card-t1')).toBeTruthy()
    expect(screen.getByTestId('card-t2')).toBeTruthy()
    expect(screen.queryByTestId('card-t3')).toBeNull()
    expect(useBoardSearchStore.getState().matchCount).toBe(2)
  })

  it('hides every ticket and reports zero when nothing matches', () => {
    seedSearch('zzz-nothing')
    render(<KanbanBoard projectId={PROJECT_ID} />)

    expect(screen.queryByTestId('card-t1')).toBeNull()
    expect(screen.queryByTestId('card-t2')).toBeNull()
    expect(screen.queryByTestId('card-t3')).toBeNull()
    expect(useBoardSearchStore.getState().matchCount).toBe(0)
  })

  it('does not filter when the bar is open but the query is empty', () => {
    useBoardSearchStore.setState({ isOpen: true, query: '   ' })
    render(<KanbanBoard projectId={PROJECT_ID} />)

    expect(screen.getByTestId('card-t1')).toBeTruthy()
    expect(screen.getByTestId('card-t2')).toBeTruthy()
    expect(screen.getByTestId('card-t3')).toBeTruthy()
  })
})
