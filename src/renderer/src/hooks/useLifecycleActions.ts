import { useState, useEffect, useCallback } from 'react'
import { useGitStore } from '@/stores/useGitStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { toast } from '@/lib/toast'
import { copyTextToClipboard } from '@/lib/clipboard'
import { buildAutoResolveConflictPrompt } from '@/lib/autoResolveConflictPrompt'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { messageSendTimes, userExplicitSendTimes, lastSendMode } from '@/lib/message-send-times'
import { bumpWorktreeLastMessage } from '@/lib/last-message-utils'
import { snapshotTokenBaseline } from '@/lib/token-baselines'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { systemApi } from '@/api/system-api'
import { gitApi } from '@/api/git-api'
import { terminalApi } from '@/api/terminal-api'

interface AttachedPR {
  number: number
  url: string
}

interface PRListItem {
  number: number
  title: string
  author: string
  headRefName: string
}

interface LifecycleActions {
  // State
  attachedPR: AttachedPR | null
  hasAttachedPR: boolean
  prLiveState: { state?: string; title?: string } | null
  isGitHub: boolean
  isMergingPR: boolean
  isRebasingPR: boolean
  isArchiving: boolean
  branchInfo: { name?: string; tracking?: string | null } | null
  remoteBranches: { name: string }[]
  prTargetBranch: string | undefined
  isCleanTree: boolean
  isDefault: boolean
  // Set when the last mergePR() failed because the PR branch conflicts with its base.
  prMergeConflict: { prNumber: number; baseBranch?: string } | null

  // Actions
  mergePR: () => Promise<boolean>
  rebasePR: () => Promise<boolean>
  // Inject the auto-resolve prompt into the ticket's Claude CLI terminal and run it.
  autoResolvePrMergeConflict: (sessionId?: string) => Promise<boolean>
  archiveWorktree: () => Promise<boolean>
  attachPR: (prNumber: number) => void
  detachPR: () => void
  openPRInBrowser: () => void
  copyPRUrl: () => void
  loadPRList: () => Promise<PRListItem[]>
  loadPRState: () => Promise<void>
  setPrTargetBranch: (branch: string) => void
}

// Resolve projectId from worktreeId by searching worktreesByProject
function resolveProjectId(worktreeId: string): string | null {
  const worktreeStore = useWorktreeStore.getState()
  for (const [projId, wts] of worktreeStore.worktreesByProject) {
    if (wts.some((w) => w.id === worktreeId)) {
      return projId
    }
  }
  return null
}

// Resolve worktree object from worktreeId
function resolveWorktree(worktreeId: string) {
  const worktreeStore = useWorktreeStore.getState()
  for (const worktrees of worktreeStore.worktreesByProject.values()) {
    const match = worktrees.find((w) => w.id === worktreeId)
    if (match) return match
  }
  return null
}

// Resolve project path for a worktreeId
function resolveProjectPath(worktreeId: string): string | null {
  const projectId = resolveProjectId(worktreeId)
  if (!projectId) return null
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
  return project?.path ?? null
}

// Resolve the Claude CLI session whose terminal we should inject the prompt into.
// Prefers an explicit override (the ticket's current_session_id), then the active
// session if it belongs to this worktree, then the most recent CLI session.
function resolveClaudeCliSessionId(worktreeId: string, override?: string): string | null {
  if (override) return override
  const sessionStore = useSessionStore.getState()
  const sessions = sessionStore.sessionsByWorktree.get(worktreeId) ?? []
  const cli = sessions.filter((s) => s.agent_sdk === 'claude-code-cli')
  if (cli.length === 0) return null
  const active = sessionStore.activeSessionId
  if (active && cli.some((s) => s.id === active)) return active
  return cli[cli.length - 1].id
}

const noopBool = async () => false
const noopVoid = () => {}
const noopPRList = async (): Promise<PRListItem[]> => []
const noopLoadState = async () => {}

export function useLifecycleActions(worktreeId: string | null): LifecycleActions {
  // --- Store subscriptions ---
  const worktree = useWorktreeStore((s) => {
    if (!worktreeId) return null
    for (const worktrees of s.worktreesByProject.values()) {
      const match = worktrees.find((w) => w.id === worktreeId)
      if (match) return match
    }
    return null
  })

  const remoteInfo = useGitStore((s) => (worktreeId ? s.remoteInfo.get(worktreeId) : undefined))

  const storeAttachedPR = useGitStore((s) =>
    worktreeId ? s.attachedPR.get(worktreeId) : undefined
  )

  const storePrTargetBranch = useGitStore((s) =>
    worktreeId ? s.prTargetBranch.get(worktreeId) : undefined
  )

  const branchInfo = useGitStore((s) =>
    worktree?.path ? (s.branchInfoByWorktree.get(worktree.path) ?? null) : null
  )

  const fileStatuses = useGitStore((s) =>
    worktree?.path ? s.fileStatusesByWorktree.get(worktree.path) : undefined
  )

  // --- Derived state ---
  const isGitHub = remoteInfo?.isGitHub ?? false
  const attachedPR = storeAttachedPR ?? null
  const hasAttachedPR = !!storeAttachedPR
  const isCleanTree = !fileStatuses || fileStatuses.length === 0
  const isDefault = worktree?.is_default ?? false

  // --- Local state ---
  const [isMergingPR, setIsMergingPR] = useState(false)
  const [isRebasingPR, setIsRebasingPR] = useState(false)
  const [isArchiving, setIsArchiving] = useState(false)
  const [prLiveState, setPrLiveState] = useState<{ state?: string; title?: string } | null>(null)
  const [remoteBranches, setRemoteBranches] = useState<{ name: string }[]>([])
  const [prMergeConflict, setPrMergeConflict] = useState<{
    prNumber: number
    baseBranch?: string
  } | null>(null)

  // --- Ensure remote info is loaded for this worktree (needed for isGitHub check) ---
  useEffect(() => {
    if (!worktreeId || !worktree?.path || remoteInfo) return
    useGitStore.getState().checkRemoteInfo(worktreeId, worktree.path)
  }, [worktreeId, worktree?.path, remoteInfo])

  // --- Load remote branches when worktree path changes ---
  useEffect(() => {
    if (!worktree?.path) {
      setRemoteBranches([])
      return
    }
    gitApi.listBranchesWithStatus(worktree.path).then((result) => {
      if (result.success) {
        const filtered = result.branches.filter((b: { isRemote: boolean }) => b.isRemote)

        // Pin the default branch (e.g. origin/main) to the top
        if (worktreeId) {
          const projectId = resolveProjectId(worktreeId)
          if (projectId) {
            const defaultWt = useWorktreeStore.getState().getDefaultWorktree(projectId)
            if (defaultWt?.branch_name) {
              const defaultRemoteName = `origin/${defaultWt.branch_name}`
              filtered.sort((a, b) => {
                if (a.name === defaultRemoteName) return -1
                if (b.name === defaultRemoteName) return 1
                return 0
              })
            }
          }
        }

        setRemoteBranches(filtered)
      }
    })
  }, [worktree?.path, worktreeId])

  // --- Clear live state when attached PR changes ---
  useEffect(() => {
    setPrLiveState(null)
    setPrMergeConflict(null)
  }, [storeAttachedPR?.number])

  // --- Auto-detect a PR opened outside the app (e.g. by the Claude Code CLI) ---
  // The Create-PR handoff runs `gh pr create` in its own terminal, so the app
  // never receives the PR number directly. Whenever this worktree comes into view
  // without a PR attached, ask `gh` whether one exists for the current branch and
  // attach it if so — this is what flips the "Create PR" button to the "PR #N"
  // badge after a CLI-driven creation (and recovers PRs opened manually too).
  useEffect(() => {
    if (!worktreeId || !worktree?.path || !isGitHub || hasAttachedPR) return
    void useGitStore.getState().detectAndAttachPR(worktreeId, worktree.path)
  }, [worktreeId, worktree?.path, isGitHub, hasAttachedPR])

  // --- Actions ---

  const mergePR = useCallback(async (): Promise<boolean> => {
    if (!worktreeId || !worktree?.path) return false
    const pr = useGitStore.getState().attachedPR.get(worktreeId)
    if (!pr?.number) return false

    setIsMergingPR(true)
    setPrMergeConflict(null)
    try {
      const result = await gitApi.prMerge(worktree.path, pr.number)
      if (result.success) {
        const pull = result.localBasePull
        toast.success(
          pull?.pulled
            ? `PR merged successfully · Pulled latest ${pull.baseBranch} locally`
            : 'PR merged successfully'
        )
        if (result.warning) {
          toast.warning(result.warning)
        }
        if (pull?.warning) {
          toast.warning(pull.warning)
        }
        setPrLiveState((prev) => ({ state: 'MERGED', title: prev?.title }))
        return true
      } else if (result.conflicted) {
        setPrMergeConflict({ prNumber: pr.number, baseBranch: result.baseBranch })
        toast.error(result.error ?? 'PR has conflicts with its base branch')
        return false
      } else {
        toast.error(`Merge failed: ${result.error}`)
        return false
      }
    } catch {
      toast.error('Failed to merge PR')
      return false
    } finally {
      setIsMergingPR(false)
    }
  }, [worktreeId, worktree?.path])

  const rebasePR = useCallback(async (): Promise<boolean> => {
    if (!worktreeId || !worktree?.path) return false
    const pr = useGitStore.getState().attachedPR.get(worktreeId)
    if (!pr?.number) return false

    setIsRebasingPR(true)
    try {
      const result = await gitApi.rebasePR(worktree.path, pr.number)
      if (result.success) {
        toast.success('Rebased and force-pushed')
        return true
      } else {
        toast.error(result.error || 'Rebase failed')
        return false
      }
    } catch {
      toast.error('Failed to rebase PR')
      return false
    } finally {
      setIsRebasingPR(false)
    }
  }, [worktreeId, worktree?.path])

  const autoResolvePrMergeConflict = useCallback(
    async (sessionIdOverride?: string): Promise<boolean> => {
      if (!worktreeId || !worktree?.path) return false

      const conflict = prMergeConflict
      const prNumber = conflict?.prNumber ?? useGitStore.getState().attachedPR.get(worktreeId)?.number
      if (!prNumber) {
        toast.error('No PR to resolve')
        return false
      }

      const sessionId = resolveClaudeCliSessionId(worktreeId, sessionIdOverride)
      if (!sessionId) {
        toast.error("Open the ticket's Claude Code terminal first, then try again")
        return false
      }

      const branch = useGitStore.getState().branchInfoByWorktree.get(worktree.path)
      const featureBranch = branch?.name || 'this branch'
      // The base comes from the PR (server-supplied). Never fall back to the
      // branch's own upstream — that's `origin/<featureBranch>`, never the merge
      // base. Default to `main`, and guard against a stale server result that
      // omitted baseBranch: a branch can't be merged into itself.
      let baseBranch = conflict?.baseBranch?.trim() || 'main'
      if (baseBranch === featureBranch) baseBranch = 'main'

      const template = useSettingsStore.getState().autoResolveConflictPrompt
      const prompt = buildAutoResolveConflictPrompt(template, {
        prNumber,
        baseBranch,
        featureBranch
      })

      // Surface the session so Tu can watch it run.
      useSessionStore.getState().setActiveWorktree(worktreeId)
      useSessionStore.getState().setActiveSession(sessionId)

      // Deliver to the live PTY; if the terminal hasn't spawned yet, spawn it with
      // the prompt queued as the first message (mirrors sendFollowupToSession).
      const delivery = unwrapEnvelope(await terminalApi.sendClaudeCliPrompt(sessionId, prompt))
      if (!delivery.delivered) {
        const created = unwrapEnvelope(
          await terminalApi.createClaudeCli(sessionId, { pendingPrompt: prompt })
        )
        if (!created.success) {
          toast.error(created.error ?? 'Could not reach the Claude Code terminal')
          return false
        }
      }

      messageSendTimes.set(sessionId, Date.now())
      userExplicitSendTimes.set(sessionId, Date.now())
      snapshotTokenBaseline(sessionId)
      lastSendMode.set(sessionId, 'build')
      useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
      bumpWorktreeLastMessage({ worktreeId })

      setPrMergeConflict(null)
      toast.success('Sent conflict-resolution prompt to the Claude Code terminal')
      return true
    },
    [worktreeId, worktree?.path, prMergeConflict]
  )

  const archiveWorktreeAction = useCallback(async (): Promise<boolean> => {
    if (!worktreeId) return false
    const wt = resolveWorktree(worktreeId)
    if (!wt) return false
    const projectPath = resolveProjectPath(worktreeId)
    if (!projectPath) return false

    setIsArchiving(true)
    try {
      const result = await useWorktreeStore
        .getState()
        .archiveWorktree(worktreeId, wt.path, wt.branch_name, projectPath)

      if (!result.success && result.error) {
        toast.error(result.error)
      }
      return result.success
    } finally {
      setIsArchiving(false)
    }
  }, [worktreeId])

  const attachPRAction = useCallback(
    (prNumber: number) => {
      if (!worktreeId || !remoteInfo?.url) return
      const cleanUrl = remoteInfo.url.replace(/\.git$/, '')
      const prUrl = `${cleanUrl}/pull/${prNumber}`
      useGitStore.getState().attachPR(worktreeId, prNumber, prUrl)
    },
    [worktreeId, remoteInfo?.url]
  )

  const detachPRAction = useCallback(() => {
    if (!worktreeId) return
    useGitStore.getState().detachPR(worktreeId)
    setPrLiveState(null)
  }, [worktreeId])

  const openPRInBrowser = useCallback(() => {
    if (!storeAttachedPR?.url) return
    void systemApi.openInChrome(storeAttachedPR.url)
  }, [storeAttachedPR?.url])

  const copyPRUrl = useCallback(() => {
    if (!storeAttachedPR?.url) return
    void copyTextToClipboard(storeAttachedPR.url).then((ok) => {
      if (ok) toast.success('PR URL copied')
      else toast.error('Failed to copy')
    })
  }, [storeAttachedPR?.url])

  const loadPRList = useCallback(async (): Promise<PRListItem[]> => {
    if (!worktreeId) return []
    const projectPath = resolveProjectPath(worktreeId)
    if (!projectPath) return []

    const currentBranchInfo = useGitStore
      .getState()
      .branchInfoByWorktree.get(resolveWorktree(worktreeId)?.path ?? '')
    const currentBranch = currentBranchInfo?.name ?? ''

    try {
      const res = await gitApi.listPRs(projectPath)
      if (res.success) {
        const sorted = [...res.prs].sort((a, b) => {
          const aMatch = a.headRefName === currentBranch ? 1 : 0
          const bMatch = b.headRefName === currentBranch ? 1 : 0
          if (aMatch !== bMatch) return bMatch - aMatch
          return b.number - a.number
        })
        return sorted
      } else {
        toast.error(res.error || 'Failed to load PRs')
        return []
      }
    } catch {
      toast.error('Failed to load PRs')
      return []
    }
  }, [worktreeId])

  const loadPRState = useCallback(async (): Promise<void> => {
    if (!worktreeId) return
    const pr = useGitStore.getState().attachedPR.get(worktreeId)
    if (!pr) return
    const projectPath = resolveProjectPath(worktreeId)
    if (!projectPath) return

    try {
      const res = await gitApi.getPRState(projectPath, pr.number)
      if (res.success) {
        setPrLiveState({ state: res.state, title: res.title })
      }
    } catch {
      // non-critical
    }
  }, [worktreeId])

  const setPrTargetBranchAction = useCallback(
    (branch: string) => {
      if (!worktreeId) return
      useGitStore.getState().setPrTargetBranch(worktreeId, branch)
    },
    [worktreeId]
  )

  // When worktreeId is null, return safe defaults with no-op actions
  if (!worktreeId) {
    return {
      attachedPR: null,
      hasAttachedPR: false,
      prLiveState: null,
      isGitHub: false,
      isMergingPR: false,
      isRebasingPR: false,
      isArchiving: false,
      branchInfo: null,
      remoteBranches: [],
      prTargetBranch: undefined,
      isCleanTree: true,
      isDefault: false,
      prMergeConflict: null,
      mergePR: noopBool,
      rebasePR: noopBool,
      autoResolvePrMergeConflict: noopBool,
      archiveWorktree: noopBool,
      attachPR: noopVoid,
      detachPR: noopVoid,
      openPRInBrowser: noopVoid,
      copyPRUrl: noopVoid,
      loadPRList: noopPRList,
      loadPRState: noopLoadState,
      setPrTargetBranch: noopVoid
    }
  }

  return {
    // State
    attachedPR,
    hasAttachedPR,
    prLiveState,
    isGitHub,
    isMergingPR,
    isRebasingPR,
    isArchiving,
    branchInfo,
    remoteBranches,
    prTargetBranch: storePrTargetBranch,
    isCleanTree,
    isDefault,
    prMergeConflict,

    // Actions
    mergePR,
    rebasePR,
    autoResolvePrMergeConflict,
    archiveWorktree: archiveWorktreeAction,
    attachPR: attachPRAction,
    detachPR: detachPRAction,
    openPRInBrowser,
    copyPRUrl,
    loadPRList,
    loadPRState,
    setPrTargetBranch: setPrTargetBranchAction
  }
}
