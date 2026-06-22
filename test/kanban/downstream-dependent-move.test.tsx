import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PropsWithChildren } from 'react'
import { screen } from '@testing-library/react'
import { fireEvent, render, waitFor } from '../utils/render'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setKanbanDragData, ticketKey, useKanbanStore } from '@/stores/useKanbanStore'
import type { KanbanTicket } from '../../src/main/db/types'

const kanbanApiMock = vi.hoisted(() => ({
  ticket: { getByProject: vi.fn() },
  diagnostics: { get: vi.fn() },
  dependency: { getForProject: vi.fn() }
}))

vi.mock('@/api/kanban-api', () => ({ kanbanApi: kanbanApiMock }))
vi.mock('@/components/kanban/WorktreePickerModal', () => ({ WorktreePickerModal: () => null }))
vi.mock('@/components/kanban/KanbanTicketModal', () => ({ KanbanTicketModal: () => null }))
vi.mock('@/components/kanban/BoardChatLauncher', () => ({ BoardChatLauncher: () => null }))
vi.mock('@/components/kanban/MergeOnDoneDialog', () => ({ MergeOnDoneDialog: () => null }))
vi.mock('@/components/kanban/TicketCreateModal', () => ({ TicketCreateModal: () => null }))
vi.mock('@/components/kanban/KanbanTicketCard', () => ({
  KanbanTicketCard: ({ ticket }: { ticket: KanbanTicket }) => (
    <div data-testid="kanban-ticket-card" data-ticket-id={ticket.id}>
      {ticket.title}
    </div>
  )
}))
vi.mock('@/components/kanban/AttachPRPopover', () => ({ AttachPRPopover: () => null }))
vi.mock('@/components/kanban/UpdateStatusModal', () => ({ UpdateStatusModal: () => null }))
vi.mock('@/components/worktrees/PulseAnimation', () => ({ PulseAnimation: () => null }))
vi.mock('@/components/sessions/IndeterminateProgressBar', () => ({
  IndeterminateProgressBar: () => null
}))
vi.mock('@/hooks/useMarkdownKanbanWatcher', () => ({ useMarkdownKanbanWatcher: vi.fn() }))
vi.mock('@/hooks/useSessionTimer', () => ({ useSessionTimer: () => null }))
vi.mock('@/hooks/useSessionTokenDelta', () => ({ useSessionTokenDelta: () => null }))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('motion/react', () => ({
  LayoutGroup: ({ children }: PropsWithChildren) => <>{children}</>,
  motion: {
    div: ({
      children,
      layoutId,
      layout: _layout,
      layoutScroll: _layoutScroll,
      transition: _transition,
      ...props
    }: PropsWithChildren<{
      layoutId?: string
      layout?: boolean
      layoutScroll?: boolean
      transition?: unknown
      [key: string]: unknown
    }>) => (
      <div data-layout-id={layoutId} {...props}>
        {children}
      </div>
    )
  }
}))

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'proj-1',
    title: 'Root',
    description: null,
    attachments: [],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
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
    auto_approve_review: false,
    ...overrides
  }
}

describe('downstream dependent cascade — move back to To Do', () => {
  const moveTicket = vi.fn()
  const updateTicket = vi.fn()
  const reorderTicket = vi.fn()

  // ticket-1 → chain-2 → chain-3 (chain-2 depends on ticket-1, chain-3 depends on chain-2)
  function setupChain(overrides: Partial<Record<'chain2col' | 'chain3col', KanbanTicket['column']>> = {}) {
    moveTicket.mockReset()
    updateTicket.mockReset()
    reorderTicket.mockReset()
    useKanbanStore.setState({
      tickets: new Map([
        [
          'proj-1',
          [
            makeTicket({ id: 'ticket-1', title: 'Root', column: 'review' }),
            makeTicket({
              id: 'chain-2',
              title: 'Second step',
              column: overrides.chain2col ?? 'in_progress'
            }),
            makeTicket({
              id: 'chain-3',
              title: 'Third step',
              column: overrides.chain3col ?? 'review'
            })
          ]
        ]
      ]),
      dependencyMap: new Map([
        [ticketKey('proj-1', 'chain-2'), new Set([ticketKey('proj-1', 'ticket-1')])],
        [ticketKey('proj-1', 'chain-3'), new Set([ticketKey('proj-1', 'chain-2')])]
      ]),
      draggingTicketKey: null,
      moveTicket,
      updateTicket,
      reorderTicket
    })
    setKanbanDragData(null)
  }

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    kanbanApiMock.dependency.getForProject.mockResolvedValue([])
  })

  function renderTodoColumn() {
    return render(
      <TooltipProvider>
        <KanbanColumn column="todo" projectId="proj-1" tickets={[]} />
      </TooltipProvider>
    )
  }

  function dragToTodo(ticketId: string, sourceColumn: KanbanTicket['column']) {
    setKanbanDragData({ projectId: 'proj-1', ticketId, sourceColumn, sourceIndex: 0 })
    fireEvent.drop(document.querySelector('[data-testid="kanban-drop-area-todo"]')!)
  }

  test('dragging a ticket back to To Do offers to cascade its downstream dependents', async () => {
    setupChain()
    renderTodoColumn()

    dragToTodo('ticket-1', 'review')

    // The dragged ticket itself moves immediately.
    await waitFor(() => expect(moveTicket).toHaveBeenCalledWith('ticket-1', 'proj-1', 'todo', 0))

    const dialog = await screen.findByTestId('downstream-move-confirm-dialog')
    // chain-2 and chain-3 are both downstream and outside To Do.
    expect(dialog).toHaveTextContent('2 tickets depend on this')
  })

  test('confirming cascades every downstream dependent back to To Do', async () => {
    setupChain()
    renderTodoColumn()

    dragToTodo('ticket-1', 'review')
    await screen.findByTestId('downstream-move-confirm-dialog')

    fireEvent.click(screen.getByTestId('downstream-move-confirm-btn'))

    await waitFor(() => {
      expect(moveTicket).toHaveBeenCalledWith('chain-2', 'proj-1', 'todo', expect.any(Number))
    })
    expect(moveTicket).toHaveBeenCalledWith('chain-3', 'proj-1', 'todo', expect.any(Number))
    // Each cascaded dependent has its launch/session state cleared.
    expect(updateTicket).toHaveBeenCalledWith(
      'chain-2',
      'proj-1',
      expect.objectContaining({
        current_session_id: null,
        worktree_id: null,
        pending_launch_config: null
      })
    )
    expect(updateTicket).toHaveBeenCalledWith('chain-3', 'proj-1', expect.anything())
  })

  test('canceling moves only the dragged ticket, not the dependents', async () => {
    setupChain()
    renderTodoColumn()

    dragToTodo('ticket-1', 'review')
    await screen.findByTestId('downstream-move-confirm-dialog')

    fireEvent.click(screen.getByTestId('downstream-move-cancel-btn'))

    await waitFor(() =>
      expect(screen.queryByTestId('downstream-move-confirm-dialog')).not.toBeInTheDocument()
    )
    expect(moveTicket).not.toHaveBeenCalledWith('chain-2', 'proj-1', 'todo', expect.any(Number))
    expect(moveTicket).not.toHaveBeenCalledWith('chain-3', 'proj-1', 'todo', expect.any(Number))
  })

  test('no dialog when the dragged ticket has no downstream dependents', async () => {
    setupChain()
    renderTodoColumn()

    // chain-3 is the leaf — nothing depends on it.
    dragToTodo('chain-3', 'review')

    await waitFor(() => expect(moveTicket).toHaveBeenCalledWith('chain-3', 'proj-1', 'todo', 0))
    expect(screen.queryByTestId('downstream-move-confirm-dialog')).not.toBeInTheDocument()
  })

  test('dependents already in To Do are not offered', async () => {
    // chain-2 already sits in To Do; only chain-3 remains to cascade.
    setupChain({ chain2col: 'todo' })
    renderTodoColumn()

    dragToTodo('ticket-1', 'review')

    const dialog = await screen.findByTestId('downstream-move-confirm-dialog')
    expect(dialog).toHaveTextContent('1 ticket depend')
  })
})
