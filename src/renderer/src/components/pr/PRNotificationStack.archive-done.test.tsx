import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRNotificationStack } from './PRNotificationStack'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type { KanbanTicket } from '../../../../main/db/types'

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn()
  }
}))

const gitApiMocks = vi.hoisted(() => ({
  prMerge: vi.fn()
}))

vi.mock('@/api/git-api', () => ({
  gitApi: gitApiMocks
}))

const PROJECT_ID = 'proj-1'
const TICKET_ID = 'ticket-1'
const WT_ID = 'wt-feature'
const WT_PATH = '/tmp/hive-feature'
const PR_NUMBER = 42

const initialPrState = usePRNotificationStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialProjectState = useProjectStore.getState()
const initialKanbanState = useKanbanStore.getState()

const ticket: KanbanTicket = {
  id: TICKET_ID,
  project_id: PROJECT_ID,
  title: 'Add the thing',
  description: null,
  attachments: [],
  column: 'review',
  sort_order: 0,
  current_session_id: null,
  worktree_id: WT_ID,
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
  auto_approve_review: false,
  auto_approve_plan: false
}

const moveTicketMock = vi.fn(async () => {})
const archiveWorktreeMock = vi.fn(async () => ({ success: true as const }))

const seedStores = (ticketColumn: KanbanTicket['column']): void => {
  usePRNotificationStore.setState({
    notifications: [
      {
        id: 'notif-1',
        status: 'success',
        message: 'PR #42 merged',
        prNumber: PR_NUMBER,
        worktreeId: WT_ID
      }
    ]
  })
  useWorktreeStore.setState({
    worktreesByProject: new Map([
      [PROJECT_ID, [{ id: WT_ID, path: WT_PATH, branch_name: 'feature/x' }]]
    ]),
    archiveWorktree: archiveWorktreeMock
  })
  useProjectStore.setState({
    projects: [{ id: PROJECT_ID, path: '/tmp/hive' }]
  })
  useKanbanStore.setState({
    tickets: new Map([[PROJECT_ID, [{ ...ticket, column: ticketColumn }]]]),
    moveTicket: moveTicketMock
  })
}

describe('PRNotificationStack — archive moves linked ticket to Done', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gitApiMocks.prMerge.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    cleanup()
    usePRNotificationStore.setState(initialPrState, true)
    useWorktreeStore.setState(initialWorktreeState, true)
    useProjectStore.setState(initialProjectState, true)
    useKanbanStore.setState(initialKanbanState, true)
  })

  it('gates Archive behind a two-step Move to Done flow', async () => {
    seedStores('review')

    render(<PRNotificationStack />)

    // After merge, the card shows "Move to Done" — Archive is NOT yet offered.
    await userEvent.click(await screen.findByRole('button', { name: 'Merge PR' }))
    expect(await screen.findByRole('button', { name: 'Move to Done' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
    expect(archiveWorktreeMock).not.toHaveBeenCalled()

    // Clicking "Move to Done" moves the ticket and reveals "Archive".
    await userEvent.click(screen.getByRole('button', { name: 'Move to Done' }))
    await waitFor(() => {
      expect(moveTicketMock).toHaveBeenCalledWith(
        TICKET_ID,
        PROJECT_ID,
        'done',
        expect.any(Number)
      )
    })
    expect(archiveWorktreeMock).not.toHaveBeenCalled()

    // Only the second click archives.
    await userEvent.click(await screen.findByRole('button', { name: 'Archive' }))
    await waitFor(() => {
      expect(archiveWorktreeMock).toHaveBeenCalledWith(WT_ID, WT_PATH, 'feature/x', '/tmp/hive')
    })
  })

  it('still reveals Archive when the ticket is already Done (no re-move)', async () => {
    seedStores('done')

    render(<PRNotificationStack />)

    await userEvent.click(await screen.findByRole('button', { name: 'Merge PR' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Move to Done' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Archive' }))

    await waitFor(() => {
      expect(archiveWorktreeMock).toHaveBeenCalled()
    })
    expect(moveTicketMock).not.toHaveBeenCalled()
  })
})
