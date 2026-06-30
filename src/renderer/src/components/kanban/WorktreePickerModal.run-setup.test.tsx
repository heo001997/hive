import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreePickerModal, _resetLastSourceBranch } from './WorktreePickerModal'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useUsageStore } from '@/stores/useUsageStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { KanbanTicket, Session } from '../../../../main/db/types'

vi.mock('@/api/hive-enterprise/client', () => ({
  isHiveTelemetryEnabled: vi.fn(() => false),
  recordHivePromptStart: vi.fn(),
  recordHivePromptIdle: vi.fn(),
  recordHiveQuestionsAnswered: vi.fn()
}))

vi.mock('@/components/sessions/ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector" />
}))

vi.mock('@/components/sessions/CodexFastToggle', () => ({
  CodexFastToggle: () => <div data-testid="codex-fast-toggle" />
}))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))

vi.mock('@/lib/worktree-context', () => ({
  prepareWorktreeContextLaunch: vi.fn()
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    loadCustomCommandsFile: vi.fn().mockResolvedValue({ commands: [] }),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))

vi.mock('@/api/pet-api', () => ({
  petApi: { updateSettings: vi.fn().mockResolvedValue({ success: true, value: {} }) }
}))

const initialSettingsState = useSettingsStore.getState()
const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialConnectionState = useConnectionStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialUsageState = useUsageStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()

const baseTicket: KanbanTicket = {
  id: 'ticket-1',
  project_id: 'project-1',
  title: 'Add setup toggle',
  description: 'Body',
  column: 'todo',
  sort_order: 0,
  worktree_id: null,
  current_session_id: null,
  mode: 'build',
  plan_ready: false,
  goal_mode: false,
  goal_success_criteria: null,
  auto_approve_plan: false,
  pending_launch_config: null,
  created_from_session: false,
  auto_approve_review: false,
  attachments: [],
  archived_at: null,
  external_provider: null,
  external_id: null,
  external_url: null,
  github_pr_number: null,
  github_pr_url: null,
  mark: null,
  note: null,
  total_tokens: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z'
}

function makeSession(): Session {
  return {
    id: 'session-1',
    worktree_id: 'new-worktree-1',
    project_id: 'project-1',
    connection_id: null,
    name: 'Session 1',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: 'opencode',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: 'opus',
    model_variant: 'high',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false
  }
}

/** @param setupScript the project's setup_script; null = no setup script configured */
function setupStores(setupScript: string | null): {
  createWorktreeFromBranch: ReturnType<typeof vi.fn>
} {
  const createWorktreeFromBranch = vi.fn(async () => ({
    success: true,
    worktree: {
      id: 'new-worktree-1',
      project_id: 'project-1',
      name: 'add-setup-toggle',
      branch_name: 'add-setup-toggle',
      path: '/repo/add-setup-toggle',
      status: 'active' as const,
      is_default: false,
      branch_renamed: 0,
      last_message_at: null,
      session_titles: '[]',
      last_model_provider_id: null,
      last_model_id: null,
      last_model_variant: null,
      attachments: '[]',
      created_at: '2026-01-01T00:00:00.000Z',
      last_accessed_at: '2026-01-01T00:00:00.000Z',
      github_pr_number: null,
      github_pr_url: null
    }
  }))

  useSettingsStore.setState({
    availableAgentSdks: { opencode: true, claude: false, codex: false },
    defaultAgentSdk: 'opencode',
    selectedModel: null,
    selectedModelByProvider: {},
    defaultModels: null,
    boardMode: 'toggle'
  })
  useProjectStore.setState({
    projects: [
      {
        id: 'project-1',
        name: 'Hive',
        path: '/repo',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        detected_icon: null,
        setup_script: setupScript,
        run_script: null,
        archive_script: null,
        worktree_create_script: null,
        custom_commands: null,
        auto_assign_port: false,
        max_parallel_worktrees: 0,
        sort_order: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        last_accessed_at: '2026-01-01T00:00:00.000Z'
      }
    ]
  })
  useWorktreeStore.setState({
    worktreesByProject: new Map([
      [
        'project-1',
        [
          {
            id: 'default-wt',
            project_id: 'project-1',
            name: 'main',
            branch_name: 'main',
            path: '/repo',
            status: 'active',
            is_default: true,
            branch_renamed: 0,
            last_message_at: null,
            session_titles: '[]',
            last_model_provider_id: null,
            last_model_id: null,
            last_model_variant: null,
            attachments: '[]',
            created_at: '2026-01-01T00:00:00.000Z',
            last_accessed_at: '2026-01-01T00:00:00.000Z',
            github_pr_number: null,
            github_pr_url: null
          }
        ]
      ]
    ]),
    worktreeOrderByProject: new Map(),
    syncWorktrees: vi.fn(),
    createWorktreeFromBranch
  })
  useKanbanStore.setState({
    tickets: new Map([['project-1', [baseTicket]]]),
    dependencyMap: new Map(),
    updateTicket: vi.fn(async () => undefined),
    computeSortOrder: vi.fn(() => 1),
    getTicketsByColumn: vi.fn(() => [])
  })
  useSessionStore.setState({
    sessionsByWorktree: new Map(),
    modeBySession: new Map(),
    createSession: vi.fn(async () => ({ success: true, session: makeSession() })),
    setSessionModel: vi.fn(async () => undefined),
    setSessionMode: vi.fn(async () => undefined),
    setOpenCodeSessionId: vi.fn(),
    setActiveSession: vi.fn(),
    setAutoApprovePlan: vi.fn()
  })
  useWorktreeStatusStore.setState({
    setSessionStatus: vi.fn(),
    setLastMessageTime: vi.fn()
  })
  useUsageStore.setState({ fetchUsageForProvider: vi.fn() })

  return { createWorktreeFromBranch }
}

function renderModal(): void {
  render(
    <WorktreePickerModal
      ticket={baseTicket}
      projectId="project-1"
      open
      onOpenChange={vi.fn()}
      onSendComplete={vi.fn()}
    />
  )
}

describe('WorktreePickerModal — run setup command toggle', () => {
  beforeEach(() => {
    _resetLastSourceBranch()
    vi.clearAllMocks()
    resetRendererRpcClientForTests()
    // opencode connect/prompt return null → the send flow returns early after the
    // worktree is created; we only assert on createWorktreeFromBranch's args.
    setRendererRpcClient({ request: vi.fn(async () => null), subscribe: vi.fn() })
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(initialSettingsState, true)
    useSessionStore.setState(initialSessionState, true)
    useWorktreeStore.setState(initialWorktreeState, true)
    useConnectionStore.setState(initialConnectionState, true)
    useKanbanStore.setState(initialKanbanState, true)
    useProjectStore.setState(initialProjectState, true)
    useUsageStore.setState(initialUsageState, true)
    useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
    resetRendererRpcClientForTests()
  })

  it('shows the toggle (checked) for a new worktree when a setup script is configured', () => {
    setupStores('pnpm install')
    renderModal()
    const checkbox = screen.getByTestId('run-setup-checkbox')
    expect(checkbox).toBeInTheDocument()
    expect(checkbox).toHaveAttribute('data-state', 'checked')
  })

  it('hides the toggle when the project has no setup script', () => {
    setupStores(null)
    renderModal()
    expect(screen.queryByTestId('run-setup-checkbox')).not.toBeInTheDocument()
  })

  it('runs setup by default (runSetup: true)', async () => {
    const { createWorktreeFromBranch } = setupStores('pnpm install')
    renderModal()
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))
    await waitFor(() => expect(createWorktreeFromBranch).toHaveBeenCalled())
    expect(createWorktreeFromBranch).toHaveBeenCalledWith(
      'project-1',
      '/repo',
      'Hive',
      'main',
      expect.any(String),
      { runSetup: true }
    )
  })

  it('skips setup when unchecked (runSetup: false)', async () => {
    const { createWorktreeFromBranch } = setupStores('pnpm install')
    renderModal()
    await userEvent.click(screen.getByTestId('run-setup-checkbox'))
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))
    await waitFor(() => expect(createWorktreeFromBranch).toHaveBeenCalled())
    expect(createWorktreeFromBranch).toHaveBeenCalledWith(
      'project-1',
      '/repo',
      'Hive',
      'main',
      expect.any(String),
      { runSetup: false }
    )
  })
})
