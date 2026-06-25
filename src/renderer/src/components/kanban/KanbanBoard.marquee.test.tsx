import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanBoard } from './KanbanBoard'
import { ticketKey, useKanbanStore } from '@/stores/useKanbanStore'
import type { KanbanTicket, KanbanTicketColumn } from '../../../../main/db/types'

// Stub the heavy children — we exercise only the marquee gesture wiring.
vi.mock('@/hooks/useMarkdownKanbanWatcher', () => ({ useMarkdownKanbanWatcher: () => {} }))
vi.mock('@/components/kanban/KanbanTicketModal', () => ({ KanbanTicketModal: () => null }))
vi.mock('./MergeOnDoneDialog', () => ({ MergeOnDoneDialog: () => null }))
vi.mock('@/components/kanban/BoardChatLauncher', () => ({ BoardChatLauncher: () => null }))

// Mock column renders real card markup: each card carries data-ticket-key so the
// marquee's intersection query (`[data-ticket-key]`) finds it.
vi.mock('@/components/kanban/KanbanColumn', () => ({
  KanbanColumn: ({ tickets }: { column: KanbanTicketColumn; tickets: KanbanTicket[] }) => (
    <>
      {tickets.map((t) => (
        <div
          key={t.id}
          data-testid={`card-${t.id}`}
          data-ticket-id={t.id}
          data-ticket-key={ticketKey(t.project_id, t.id)}
        >
          {t.title}
        </div>
      ))}
    </>
  )
}))

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
  makeTicket({ id: 't1', title: 'One', column: 'todo', sort_order: 0 }),
  makeTicket({ id: 't2', title: 'Two', column: 'todo', sort_order: 1 }),
  makeTicket({ id: 't3', title: 'Three', column: 'in_progress', sort_order: 2 })
]

// Fixed viewport boxes per card key. jsdom returns zeros otherwise.
const CARD_BOXES: Record<string, { left: number; top: number; right: number; bottom: number }> = {
  [ticketKey(PROJECT_ID, 't1')]: { left: 10, top: 10, right: 110, bottom: 60 },
  [ticketKey(PROJECT_ID, 't2')]: { left: 10, top: 80, right: 110, bottom: 130 },
  [ticketKey(PROJECT_ID, 't3')]: { left: 400, top: 10, right: 500, bottom: 60 }
}

function stubCardRects() {
  for (const [key, box] of Object.entries(CARD_BOXES)) {
    const el = document.querySelector(`[data-ticket-key="${key}"]`) as HTMLElement | null
    if (!el) continue
    el.getBoundingClientRect = () =>
      ({
        ...box,
        width: box.right - box.left,
        height: box.bottom - box.top,
        x: box.left,
        y: box.top,
        toJSON: () => ({})
      }) as DOMRect
  }
}

const initialKanbanState = useKanbanStore.getState()

describe('KanbanBoard marquee selection', () => {
  beforeEach(() => {
    useKanbanStore.setState({
      tickets: new Map([[PROJECT_ID, TICKETS]]),
      selectedTicketKeys: new Set(),
      loadTickets: vi.fn(async () => {})
    })
  })

  afterEach(() => {
    cleanup()
    useKanbanStore.setState(initialKanbanState, true)
  })

  const dragMarquee = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const board = screen.getByTestId('kanban-board')
    stubCardRects()
    fireEvent.mouseDown(board, { button: 0, clientX: from.x, clientY: from.y })
    fireEvent.mouseMove(board, { clientX: to.x, clientY: to.y })
    fireEvent.mouseUp(board, { clientX: to.x, clientY: to.y })
  }

  it('selects only the cards intersecting the dragged rectangle', async () => {
    render(<KanbanBoard projectId={PROJECT_ID} />)

    // Rect (5,5)→(200,200) covers t1 + t2 (left column) but not t3 (x≥400).
    dragMarquee({ x: 5, y: 5 }, { x: 200, y: 200 })

    await waitFor(() => {
      const selected = useKanbanStore.getState().selectedTicketKeys
      expect(selected.has(ticketKey(PROJECT_ID, 't1'))).toBe(true)
      expect(selected.has(ticketKey(PROJECT_ID, 't2'))).toBe(true)
      expect(selected.has(ticketKey(PROJECT_ID, 't3'))).toBe(false)
    })
  })

  it('shows the selection bar with the selected count', async () => {
    render(<KanbanBoard projectId={PROJECT_ID} />)
    dragMarquee({ x: 5, y: 5 }, { x: 200, y: 200 })

    await waitFor(() => {
      expect(screen.getByTestId('kanban-selection-bar').textContent).toContain('2 selected')
    })
  })

  it('treats a click without movement as a clear, not a selection', async () => {
    useKanbanStore.setState({ selectedTicketKeys: new Set([ticketKey(PROJECT_ID, 't1')]) })
    render(<KanbanBoard projectId={PROJECT_ID} />)

    const board = screen.getByTestId('kanban-board')
    fireEvent.mouseDown(board, { button: 0, clientX: 20, clientY: 20 })
    fireEvent.mouseUp(board, { clientX: 21, clientY: 21 }) // <4px = click

    await waitFor(() => {
      expect(useKanbanStore.getState().selectedTicketKeys.size).toBe(0)
    })
  })

  it('does not start a marquee when the mousedown lands on a card', () => {
    render(<KanbanBoard projectId={PROJECT_ID} />)
    stubCardRects()
    const card = screen.getByTestId('card-t1')
    fireEvent.mouseDown(card, { button: 0, clientX: 20, clientY: 20 })
    fireEvent.mouseMove(card, { clientX: 200, clientY: 200 })
    fireEvent.mouseUp(card, { clientX: 200, clientY: 200 })

    expect(screen.queryByTestId('kanban-marquee')).toBeNull()
    expect(useKanbanStore.getState().selectedTicketKeys.size).toBe(0)
  })
})
