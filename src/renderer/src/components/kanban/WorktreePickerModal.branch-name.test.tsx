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
  title: 'Add user authentication',
  description: null,
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

function setupStores(): { createWorktreeFromBranch: ReturnType<typeof vi.fn> } {
  const createWorktreeFromBranch = vi.fn(async () => ({
    success: true,
    worktree: {
      id: 'new-worktree-1',
      project_id: 'project-1',
      name: 'wt',
      branch_name: 'wt',
      path: '/repo/wt',
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
        setup_script: null,
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

// The nameHint is the 5th positional arg of createWorktreeFromBranch.
const nameHintOf = (mock: ReturnType<typeof vi.fn>): unknown => mock.mock.calls[0]?.[4]

describe('WorktreePickerModal — branch-name candidate picker', () => {
  beforeEach(() => {
    _resetLastSourceBranch()
    vi.clearAllMocks()
    resetRendererRpcClientForTests()
    // Branch listing + opencode connect/prompt all resolve to null → the send
    // flow returns early after the worktree is created; we assert on the args.
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

  it('seeds the trigger with Hive default and defaults nameHint to it', async () => {
    const { createWorktreeFromBranch } = setupStores()
    renderModal()
    expect(screen.getByTestId('branch-name-trigger')).toHaveTextContent('add-user-authentication')
    await userEvent.click(screen.getByTestId('wt-picker-send-btn'))
    await waitFor(() => expect(createWorktreeFromBranch).toHaveBeenCalled())
    expect(nameHintOf(createWorktreeFromBranch)).toBe('add-user-authentication')
  })

  it('opens the picker and offers the speckit-style candidates', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    setupStores()
    renderModal()
    await user.click(screen.getByTestId('branch-name-trigger'))
    // Hive default (fallback) plus the three speckit-style candidates. "add" is a
    // stop word and only "main" exists, so the sequential prefix is 001.
    expect(screen.getByTestId('branch-name-candidate-hive-default')).toHaveTextContent(
      'add-user-authentication'
    )
    expect(screen.getByTestId('branch-name-candidate-sequential')).toHaveTextContent(
      '001-user-authentication'
    )
    expect(screen.getByTestId('branch-name-candidate-timestamp')).toBeInTheDocument()
    expect(screen.getByTestId('branch-name-candidate-short-name')).toHaveTextContent(
      'user-authentication'
    )
  })
})
