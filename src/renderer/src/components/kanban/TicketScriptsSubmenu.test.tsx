import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TicketScriptsSubmenu } from './TicketScriptsSubmenu'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useScriptStore } from '@/stores/useScriptStore'
import type { KanbanTicket, Project, Worktree } from '../../../../main/db/types'

// Render the Radix context-menu primitives as plain passthrough elements so the
// submenu contents mount synchronously (jsdom can't drive Radix open/hover state).
vi.mock('@/components/ui/context-menu', async () => {
  const React = await import('react')
  const Item = ({ children, ...props }: Record<string, unknown>): React.JSX.Element =>
    React.createElement('button', props as Record<string, unknown>, children as React.ReactNode)
  const Passthrough = ({ children }: { children?: React.ReactNode }): React.JSX.Element =>
    React.createElement(React.Fragment, null, children)
  return {
    ContextMenuSub: Passthrough,
    ContextMenuSubTrigger: Item,
    ContextMenuSubContent: Passthrough,
    ContextMenuItem: Item
  }
})

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: { worktree: { get: vi.fn(async () => null) } }
}))

const now = '2026-06-21T00:00:00.000Z'

const baseProject: Project = {
  id: 'project-1',
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
  sort_order: 0,
  created_at: now,
  last_accessed_at: now
}

const worktree: Worktree = {
  id: 'worktree-1',
  project_id: 'project-1',
  name: 'Feature',
  branch_name: 'feature',
  path: '/repo/feature',
  status: 'active',
  is_default: false,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  attachments: '[]',
  pinned: 0,
  context: null,
  github_pr_number: null,
  github_pr_url: null,
  base_branch: null,
  created_at: now,
  last_accessed_at: now
}

const ticket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'A ticket',
  description: null,
  attachments: [],
  column: 'in_progress',
  sort_order: 0,
  current_session_id: null,
  worktree_id: 'worktree-1',
  mode: 'build',
  plan_ready: false,
  created_at: now,
  updated_at: now,
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
  created_from_session: false
}

const initialProjectState = useProjectStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialScriptState = useScriptStore.getState()

function setProject(overrides: Partial<Project>): void {
  useProjectStore.setState({ projects: [{ ...baseProject, ...overrides }] })
  useWorktreeStore.setState({ worktreesByProject: new Map([['project-1', [worktree]]]) })
}

describe('TicketScriptsSubmenu', () => {
  beforeEach(() => {
    useScriptStore.setState(initialScriptState, true)
  })

  afterEach(() => {
    cleanup()
    useProjectStore.setState(initialProjectState, true)
    useWorktreeStore.setState(initialWorktreeState, true)
    useScriptStore.setState(initialScriptState, true)
  })

  it('renders nothing when no scripts are configured', () => {
    setProject({})
    render(<TicketScriptsSubmenu ticket={ticket} />)
    expect(screen.queryByTestId('ctx-scripts-submenu')).toBeNull()
  })

  it('shows one item per configured script', () => {
    setProject({
      run_script: 'npm run dev',
      setup_script: 'npm install',
      archive_script: 'rm -rf dist'
    })
    render(<TicketScriptsSubmenu ticket={ticket} />)

    expect(screen.getByTestId('ctx-scripts-submenu')).toBeInTheDocument()
    expect(screen.getByTestId('ctx-run-script')).toHaveTextContent('Run Script')
    expect(screen.getByTestId('ctx-setup-script')).toHaveTextContent('Run Setup Script')
    expect(screen.getByTestId('ctx-archive-script')).toHaveTextContent('Run Archive Script')
  })

  it('only lists scripts that are configured (comments/blank lines ignored)', () => {
    setProject({ run_script: '# just a comment\n   ' })
    render(<TicketScriptsSubmenu ticket={ticket} />)
    expect(screen.queryByTestId('ctx-scripts-submenu')).toBeNull()
  })

  it('flips the Run item to "Stop Run Script" when the run script is running', () => {
    setProject({ run_script: 'npm run dev' })
    useScriptStore.getState().setRunRunning('worktree-1', true)
    render(<TicketScriptsSubmenu ticket={ticket} />)

    const runItem = screen.getByTestId('ctx-run-script')
    expect(runItem).toHaveTextContent(/^Stop Run Script$/)
  })
})
