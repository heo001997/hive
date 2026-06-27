import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MergeOnDoneDialog } from './MergeOnDoneDialog'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useGitStore } from '@/stores/useGitStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { KanbanTicket } from '../../../../main/db/types'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  }
}))

const dbApiMocks = vi.hoisted(() => ({
  worktree: {
    get: vi.fn(),
    getActiveByProject: vi.fn()
  },
  project: {
    get: vi.fn()
  },
  setting: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: dbApiMocks
}))

const gitApiMocks = vi.hoisted(() => ({
  hasUncommittedChanges: vi.fn(),
  branchDiffShortStat: vi.fn(),
  getDiffStat: vi.fn(),
  getRemoteUrl: vi.fn(),
  prMerge: vi.fn(),
  findPullRequestForBranch: vi.fn(),
  merge: vi.fn(),
  syncLocalBaseToRemote: vi.fn()
}))

vi.mock('@/api/git-api', () => ({
  gitApi: gitApiMocks
}))

const initialKanbanState = useKanbanStore.getState()
const initialGitState = useGitStore.getState()
const initialSettingsState = useSettingsStore.getState()
const initialWorktreeStatusState = useWorktreeStatusStore.getState()
const initialWorktreeState = useWorktreeStore.getState()

const PROJECT_ID = 'proj-1'
const TICKET_ID = 'ticket-1'
const FEATURE_WT_ID = 'wt-feature'
const BASE_WT_ID = 'wt-base'
const FEATURE_PATH = '/tmp/hive-feature'
const BASE_PATH = '/tmp/hive-main'

const featureWorktree = {
  id: FEATURE_WT_ID,
  project_id: PROJECT_ID,
  branch_name: 'feature/x',
  path: FEATURE_PATH,
  status: 'active' as const,
  is_default: false,
  base_branch: 'main'
}

const baseWorktree = {
  id: BASE_WT_ID,
  project_id: PROJECT_ID,
  branch_name: 'main',
  path: BASE_PATH,
  status: 'active' as const,
  is_default: true,
  base_branch: null
}

const ticket: KanbanTicket = {
  id: TICKET_ID,
  project_id: PROJECT_ID,
  title: 'Add the thing',
  description: null,
  attachments: [],
  column: 'review',
  sort_order: 0,
  current_session_id: null,
  worktree_id: FEATURE_WT_ID,
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

const seedStores = (attachedPR: Map<string, { number: number; url: string }>): void => {
  useSettingsStore.setState({ protectedBranches: '' })
  useGitStore.setState({ attachedPR, conflictsByWorktree: {} })
  useKanbanStore.setState({
    tickets: new Map([[PROJECT_ID, [ticket]]]),
    pendingDoneMove: { ticketId: TICKET_ID, projectId: PROJECT_ID, sortOrder: 0 },
    // Stub the move/clear actions so the dialog's success path never touches the DB layer.
    completeDoneMove: vi.fn(async () => {}),
    clearPendingDoneMove: vi.fn(() => {})
  })
}

describe('MergeOnDoneDialog merge routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    dbApiMocks.worktree.get.mockResolvedValue(featureWorktree)
    dbApiMocks.worktree.getActiveByProject.mockResolvedValue([featureWorktree, baseWorktree])
    dbApiMocks.project.get.mockResolvedValue({ path: BASE_PATH })

    // Clean trees + one commit ahead → the dialog lands directly on the "merge" step.
    gitApiMocks.hasUncommittedChanges.mockResolvedValue(false)
    gitApiMocks.branchDiffShortStat.mockResolvedValue({
      success: true,
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
      commitsAhead: 1
    })
    gitApiMocks.getDiffStat.mockResolvedValue({ success: true, files: [] })
    gitApiMocks.getRemoteUrl.mockResolvedValue({
      success: true,
      url: 'git@github.com:acme/hive.git',
      remote: 'origin'
    })
    gitApiMocks.prMerge.mockResolvedValue({ success: true })
    // Default: the feature branch has no PR on the remote. Individual tests override this.
    gitApiMocks.findPullRequestForBranch.mockResolvedValue({ found: false })
    gitApiMocks.merge.mockResolvedValue({ success: true })
    gitApiMocks.syncLocalBaseToRemote.mockResolvedValue({ baseBranch: 'main', pulled: true })
  })

  afterEach(() => {
    cleanup()
    useKanbanStore.setState(initialKanbanState, true)
    useGitStore.setState(initialGitState, true)
    useSettingsStore.setState(initialSettingsState, true)
    useWorktreeStatusStore.setState(initialWorktreeStatusState, true)
    useWorktreeStore.setState(initialWorktreeState, true)
  })

  it('routes through the remote (prMerge) when the base has a remote and the feature has an attached PR', async () => {
    seedStores(new Map([[FEATURE_WT_ID, { number: 25, url: 'https://github.com/acme/hive/pull/25' }]]))

    render(<MergeOnDoneDialog />)

    const mergeBtn = await screen.findByRole('button', { name: 'Merge' })
    await userEvent.click(mergeBtn)

    await waitFor(() => {
      expect(gitApiMocks.prMerge).toHaveBeenCalledWith(FEATURE_PATH, 25)
    })
    // The remote owns the merge commit — no local `git merge` is replayed.
    expect(gitApiMocks.merge).not.toHaveBeenCalled()
    // On success the dialog advances to the archive step (findByText throws if absent).
    expect(await screen.findByText('Archive worktree')).toBeTruthy()
  })

  it('routes through the remote (prMerge) when the PR is detected on the remote but never attached', async () => {
    // The real-world bug: a GitHub PR exists for the feature branch but the user never
    // attached it in Hive. The dialog must still route through the remote so local <base>
    // mirrors origin instead of building a competing local merge commit.
    seedStores(new Map())
    gitApiMocks.findPullRequestForBranch.mockResolvedValue({
      found: true,
      number: 26,
      state: 'OPEN',
      baseRefName: 'main'
    })

    render(<MergeOnDoneDialog />)

    const mergeBtn = await screen.findByRole('button', { name: 'Merge' })
    await userEvent.click(mergeBtn)

    await waitFor(() => {
      expect(gitApiMocks.findPullRequestForBranch).toHaveBeenCalledWith(FEATURE_PATH)
    })
    expect(gitApiMocks.prMerge).toHaveBeenCalledWith(FEATURE_PATH, 26)
    // The remote owns the merge commit — no local `git merge` is replayed.
    expect(gitApiMocks.merge).not.toHaveBeenCalled()
    expect(await screen.findByText('Archive worktree')).toBeTruthy()
  })

  it('falls back to a local merge (no prMerge) when no PR is attached or found, syncing base to origin first', async () => {
    seedStores(new Map())
    // No attached PR and none on the remote → genuinely-local merge.
    gitApiMocks.findPullRequestForBranch.mockResolvedValue({ found: false })

    render(<MergeOnDoneDialog />)

    const mergeBtn = await screen.findByRole('button', { name: 'Merge' })
    await userEvent.click(mergeBtn)

    await waitFor(() => {
      expect(gitApiMocks.merge).toHaveBeenCalledWith(BASE_PATH, 'feature/x')
    })
    // No PR ⇒ never route through the remote.
    expect(gitApiMocks.prMerge).not.toHaveBeenCalled()
    // The pre-merge convenience sync is fast-forward-only, not a plain pull.
    expect(gitApiMocks.syncLocalBaseToRemote).toHaveBeenCalledWith(BASE_PATH, 'main')
  })
})
