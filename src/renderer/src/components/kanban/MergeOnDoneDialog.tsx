import { useState, useEffect, useCallback } from 'react'
import { ticketKey, useKanbanStore } from '@/stores/useKanbanStore'
import { useGitStore } from '@/stores/useGitStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { Loader2, GitMerge, GitCommit, Archive } from 'lucide-react'
import { dbApi } from '@/api/db-api'
import { gitApi } from '@/api/git-api'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { isProtectedBranch } from './protectedBranch'

type Step = 'loading' | 'commit_base' | 'commit' | 'merge' | 'archive'

type MergeWorktree = {
  id: string
  project_id: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  is_default: boolean
  base_branch: string | null
}

type MergeProject = {
  path: string
}

interface BranchStats {
  filesChanged: number
  insertions: number
  deletions: number
  commitsAhead: number
}

interface ResolvedState {
  featureWorktreeId: string
  featureWorktreePath: string
  featureBranch: string
  baseWorktreeId: string
  baseWorktreePath: string
  baseBranch: string
  ticketTitle: string
  projectPath: string
  uncommittedStats: { filesChanged: number; insertions: number; deletions: number }
  baseUncommittedStats: { filesChanged: number; insertions: number; deletions: number }
  baseDirty: boolean
  branchStats: BranchStats
  protectMerge: boolean
}

export function MergeOnDoneDialog() {
  const pendingDoneMove = useKanbanStore((s) => s.pendingDoneMove)
  const completeDoneMove = useKanbanStore((s) => s.completeDoneMove)
  const clearPendingDoneMove = useKanbanStore((s) => s.clearPendingDoneMove)

  const [step, setStep] = useState<Step>('loading')
  const [resolved, setResolved] = useState<ResolvedState | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [baseCommitMessage, setBaseCommitMessage] = useState('')
  const [committingBase, setCommittingBase] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [merging, setMerging] = useState(false)
  const [archiving, setArchiving] = useState(false)

  // Initialize when pendingDoneMove changes
  useEffect(() => {
    if (!pendingDoneMove) return

    let cancelled = false
    const pending = pendingDoneMove

    const init = async () => {
      setStep('loading')
      setResolved(null)
      setCommittingBase(false)
      setCommitting(false)
      setMerging(false)
      setArchiving(false)

      try {
        // Look up ticket from store
        const tickets = useKanbanStore.getState().getTicketsForProject(pending.projectId)
        const ticket = tickets.find((t) => t.id === pending.ticketId)

        if (!ticket || !ticket.worktree_id) {
          clearPendingDoneMove()
          return
        }

        // Fetch feature worktree
        const featureWorktree = await dbApi.worktree.get<MergeWorktree>(ticket.worktree_id)
        if (!featureWorktree || featureWorktree.status !== 'active') {
          toast.warning('Cannot merge — feature worktree is not active')
          clearPendingDoneMove()
          return
        }

        // Resolve base branch
        const activeWorktrees = await dbApi.worktree.getActiveByProject<MergeWorktree>(
          pending.projectId
        )
        const defaultWt = activeWorktrees.find((w) => w.is_default)
        const resolvedBaseBranch = featureWorktree.base_branch ?? defaultWt?.branch_name

        if (!resolvedBaseBranch) {
          toast.warning('Cannot merge — no base branch resolved')
          clearPendingDoneMove()
          return
        }

        // Find base worktree
        const baseWorktree = activeWorktrees.find(
          (w) => w.branch_name === resolvedBaseBranch && w.status === 'active'
        )

        if (!baseWorktree) {
          toast.warning(`Cannot merge — no worktree for ${resolvedBaseBranch}`)
          clearPendingDoneMove()
          return
        }

        // Check both worktrees for dirty state in parallel
        const [baseDirty, hasUncommitted, branchStatResult] = await Promise.all([
          gitApi.hasUncommittedChanges(baseWorktree.path),
          gitApi.hasUncommittedChanges(featureWorktree.path),
          gitApi.branchDiffShortStat(featureWorktree.path, resolvedBaseBranch)
        ])

        if (cancelled) return

        // Get uncommitted diff stats for both worktrees if needed
        const [featureDiffResult, baseDiffResult] = await Promise.all([
          hasUncommitted ? gitApi.getDiffStat(featureWorktree.path) : Promise.resolve(null),
          baseDirty ? gitApi.getDiffStat(baseWorktree.path) : Promise.resolve(null)
        ])

        let uncommittedStats = { filesChanged: 0, insertions: 0, deletions: 0 }
        if (featureDiffResult?.success && featureDiffResult.files) {
          uncommittedStats = {
            filesChanged: featureDiffResult.files.length,
            insertions: featureDiffResult.files.reduce((sum, f) => sum + f.additions, 0),
            deletions: featureDiffResult.files.reduce((sum, f) => sum + f.deletions, 0)
          }
        }

        let baseUncommittedStats = { filesChanged: 0, insertions: 0, deletions: 0 }
        if (baseDiffResult?.success && baseDiffResult.files) {
          baseUncommittedStats = {
            filesChanged: baseDiffResult.files.length,
            insertions: baseDiffResult.files.reduce((sum, f) => sum + f.additions, 0),
            deletions: baseDiffResult.files.reduce((sum, f) => sum + f.deletions, 0)
          }
        }

        if (cancelled) return

        if (!branchStatResult.success) {
          toast.warning(`Cannot verify merge status: ${branchStatResult.error ?? 'unknown error'}`)
          clearPendingDoneMove()
          return
        }

        const branchStats: BranchStats = {
          filesChanged: branchStatResult.filesChanged,
          insertions: branchStatResult.insertions,
          deletions: branchStatResult.deletions,
          commitsAhead: branchStatResult.commitsAhead
        }

        // Protected base branch ⇒ never suggest a local merge into it.
        // Read via getState() so the effect doesn't re-run when the setting changes.
        const protectMerge = isProtectedBranch(
          resolvedBaseBranch,
          useSettingsStore.getState().protectedBranches
        )

        // If nothing to commit, and either no commits to merge or the target is protected → done
        if (!hasUncommitted && (branchStats.commitsAhead === 0 || protectMerge)) {
          await completeDoneMove()
          return
        }

        // Get project path for archive step
        const project = await dbApi.project.get<MergeProject>(featureWorktree.project_id)
        if (cancelled) return

        setResolved({
          featureWorktreeId: featureWorktree.id,
          featureWorktreePath: featureWorktree.path,
          featureBranch: featureWorktree.branch_name,
          baseWorktreeId: baseWorktree.id,
          baseWorktreePath: baseWorktree.path,
          baseBranch: resolvedBaseBranch,
          ticketTitle: ticket.title,
          projectPath: project?.path ?? baseWorktree.path,
          uncommittedStats,
          baseUncommittedStats,
          baseDirty,
          branchStats,
          protectMerge
        })
        setCommitMessage(ticket.title)
        setBaseCommitMessage('')
        // When protected, the feature branch must be dirty here (else we returned above),
        // so go straight to the commit step and never touch the base worktree.
        setStep(
          protectMerge
            ? 'commit'
            : baseDirty
              ? 'commit_base'
              : hasUncommitted
                ? 'commit'
                : 'merge'
        )
      } catch (err) {
        if (!cancelled) {
          toast.error(`Failed to check branch: ${err instanceof Error ? err.message : String(err)}`)
          clearPendingDoneMove()
        }
      }
    }

    init()
    return () => {
      cancelled = true
    }
  }, [pendingDoneMove, completeDoneMove, clearPendingDoneMove])

  const handleCommit = useCallback(async () => {
    if (!resolved || !commitMessage.trim()) return
    setCommitting(true)
    try {
      const stageResult = await gitApi.stageAll(resolved.featureWorktreePath)
      if (!stageResult.success) {
        toast.error(`Failed to stage: ${stageResult.error}`)
        return
      }

      const commitResult = await gitApi.commit(resolved.featureWorktreePath, commitMessage.trim())
      if (!commitResult.success) {
        toast.error(`Failed to commit: ${commitResult.error}`)
        return
      }

      toast.success('Changes committed')

      // Re-check branch divergence after commit
      const statResult = await gitApi.branchDiffShortStat(
        resolved.featureWorktreePath,
        resolved.baseBranch
      )

      if (!statResult.success) {
        toast.warning(`Cannot verify merge status: ${statResult.error ?? 'unknown error'}`)
        clearPendingDoneMove()
        return
      }

      if (statResult.commitsAhead > 0 && !resolved.protectMerge) {
        setResolved((prev) =>
          prev
            ? {
                ...prev,
                branchStats: {
                  filesChanged: statResult.filesChanged,
                  insertions: statResult.insertions,
                  deletions: statResult.deletions,
                  commitsAhead: statResult.commitsAhead
                }
              }
            : prev
        )
        setStep('merge')
      } else {
        // No divergence after commit (or base is protected) — move straight to Done
        await completeDoneMove()
      }
    } catch (err) {
      toast.error(`Commit failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCommitting(false)
    }
  }, [resolved, commitMessage, completeDoneMove, clearPendingDoneMove])

  const handleCommitBase = useCallback(async () => {
    if (!resolved || !baseCommitMessage.trim()) return
    setCommittingBase(true)
    try {
      const stageResult = await gitApi.stageAll(resolved.baseWorktreePath)
      if (!stageResult.success) {
        toast.error(`Failed to stage on ${resolved.baseBranch}: ${stageResult.error}`)
        return
      }

      const commitResult = await gitApi.commit(resolved.baseWorktreePath, baseCommitMessage.trim())
      if (!commitResult.success) {
        toast.error(`Failed to commit on ${resolved.baseBranch}: ${commitResult.error}`)
        return
      }

      toast.success(`Changes committed on ${resolved.baseBranch}`)

      // Check if feature branch still has uncommitted changes
      const featureHasUncommitted = await gitApi.hasUncommittedChanges(resolved.featureWorktreePath)

      if (featureHasUncommitted) {
        setStep('commit')
      } else {
        // Re-check branch divergence
        const statResult = await gitApi.branchDiffShortStat(
          resolved.featureWorktreePath,
          resolved.baseBranch
        )
        if (!statResult.success) {
          toast.warning(`Cannot verify merge status: ${statResult.error ?? 'unknown error'}`)
          clearPendingDoneMove()
          return
        }

        if (statResult.commitsAhead > 0 && !resolved.protectMerge) {
          setResolved((prev) =>
            prev
              ? {
                  ...prev,
                  branchStats: {
                    filesChanged: statResult.filesChanged,
                    insertions: statResult.insertions,
                    deletions: statResult.deletions,
                    commitsAhead: statResult.commitsAhead
                  }
                }
              : prev
          )
          setStep('merge')
        } else {
          await completeDoneMove()
        }
      }
    } catch (err) {
      toast.error(`Commit failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCommittingBase(false)
    }
  }, [resolved, baseCommitMessage, completeDoneMove, clearPendingDoneMove])

  const handleMerge = useCallback(async () => {
    if (!resolved || !pendingDoneMove) return
    setMerging(true)

    // Keep merge conflicts on disk so the ticket-level fix flow can act on them.
    const flagConflicts = () => {
      useGitStore.getState().setHasConflicts(resolved.baseWorktreePath, true)
      useWorktreeStatusStore
        .getState()
        .setMergeConflictWorktreeForTicket(
          ticketKey(pendingDoneMove.projectId, pendingDoneMove.ticketId),
          resolved.baseWorktreeId
        )
      void useGitStore.getState().refreshStatuses(resolved.baseWorktreePath)
    }

    try {
      const remoteResult = await gitApi.getRemoteUrl(resolved.baseWorktreePath)
      const attachedPR = useGitStore.getState().attachedPR.get(resolved.featureWorktreeId)

      // Resolve the PR for this feature branch even when the user never manually
      // attached it. The real-world flow has GitHub PRs that Hive doesn't track, and a
      // local `git merge` here would build a commit that competes with GitHub's merge
      // commit — leaving local <base> ahead of origin (the divergence this fixes).
      let prNumber = attachedPR?.number
      if (remoteResult.url && prNumber === undefined) {
        const detected = await gitApi.findPullRequestForBranch(resolved.featureWorktreePath)
        if (detected.found && detected.number !== undefined) {
          prNumber = detected.number
        }
      }

      // Remote owns the merge commit: when the base has a remote AND a PR exists for the
      // feature branch, let GitHub create the merge commit and fast-forward the local base
      // onto origin/<base>. prMerge is idempotent — if the PR is already merged on GitHub
      // it skips the merge and just mirrors origin locally, so the user never has to pull.
      if (remoteResult.url && prNumber !== undefined) {
        const result = await gitApi.prMerge(resolved.featureWorktreePath, prNumber)

        if (result.success) {
          if (result.localBasePull?.warning) {
            toast.warning(result.localBasePull.warning)
          }
          toast.success(`PR #${prNumber} merged successfully`)
          setStep('archive')
          return
        }

        // Conflicted/failed — same UX as the local-merge conflict path.
        if (result.conflicted) {
          flagConflicts()
          toast.error(
            result.error ?? `PR #${prNumber} has conflicts with ${resolved.baseBranch}`
          )
        } else {
          toast.error(`Merge failed: ${result.error}`)
        }
        clearPendingDoneMove()
        return
      }

      // No remote, or no attached PR → genuinely-local merge (nothing on a remote to
      // diverge from). If a remote exists, fast-forward the local base to origin/<base>
      // first (ff-only, never a merge commit) so the convenience sync can't pollute base.
      if (remoteResult.url) {
        const sync = await gitApi.syncLocalBaseToRemote(
          resolved.baseWorktreePath,
          resolved.baseBranch
        )
        if (!sync.pulled && sync.warning) {
          toast.warning(sync.warning)
        }
      }

      // Merge feature into base
      const mergeResult = await gitApi.merge(resolved.baseWorktreePath, resolved.featureBranch)

      if (!mergeResult.success) {
        if (mergeResult.conflicts && mergeResult.conflicts.length > 0) {
          flagConflicts()
          toast.error(
            `Merge conflicts in ${mergeResult.conflicts.length} file${mergeResult.conflicts.length !== 1 ? 's' : ''} — merge manually`
          )
        } else {
          toast.error(`Merge failed: ${mergeResult.error}`)
        }
        clearPendingDoneMove()
        return
      }

      toast.success('Branch merged successfully')
      setStep('archive')
    } catch (err) {
      toast.error(`Merge failed: ${err instanceof Error ? err.message : String(err)}`)
      clearPendingDoneMove()
    } finally {
      setMerging(false)
    }
  }, [resolved, pendingDoneMove, clearPendingDoneMove])

  const handleArchive = useCallback(async () => {
    if (!resolved) return

    const archiveTarget = {
      featureWorktreeId: resolved.featureWorktreeId,
      featureWorktreePath: resolved.featureWorktreePath,
      featureBranch: resolved.featureBranch,
      projectPath: resolved.projectPath
    }

    try {
      setArchiving(true)
      await completeDoneMove()
    } catch (err) {
      setArchiving(false)
      toast.error(
        `Failed to move ticket to done: ${err instanceof Error ? err.message : String(err)}`
      )
      return
    }

    useWorktreeStore
      .getState()
      .archiveWorktree(
        archiveTarget.featureWorktreeId,
        archiveTarget.featureWorktreePath,
        archiveTarget.featureBranch,
        archiveTarget.projectPath
      )
      .then((result) => {
        if (result.success) {
          toast.success('Worktree archived')
        } else {
          toast.error(`Failed to archive: ${result.error}`)
        }
      })
      .catch((err) => {
        toast.error(`Archive failed: ${err instanceof Error ? err.message : String(err)}`)
      })
  }, [resolved, completeDoneMove])

  const stepTitle: Record<Step, string> = {
    loading: 'Moving to Done...',
    commit_base: 'Uncommitted changes on base',
    commit: 'Uncommitted changes',
    merge: 'Merge branch',
    archive: 'Archive worktree'
  }

  const stepIcon: Record<Step, React.ReactNode> = {
    loading: <Loader2 className="h-4 w-4 animate-spin" />,
    commit_base: <GitCommit className="h-4 w-4" />,
    commit: <GitCommit className="h-4 w-4" />,
    merge: <GitMerge className="h-4 w-4" />,
    archive: <Archive className="h-4 w-4" />
  }

  return (
    <Dialog
      open={!!pendingDoneMove}
      onOpenChange={(open) => {
        if (!open) clearPendingDoneMove()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            {stepIcon[step]}
            {stepTitle[step]}
          </DialogTitle>
        </DialogHeader>

        {step === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking branch status...
          </div>
        )}

        {step === 'commit_base' && resolved && (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-xs text-muted-foreground">
              <code className="bg-muted px-1 rounded">{resolved.baseBranch}</code> has uncommitted
              changes: {resolved.baseUncommittedStats.filesChanged} files changed,{' '}
              <span className="text-green-500">+{resolved.baseUncommittedStats.insertions}</span>{' '}
              <span className="text-red-500">-{resolved.baseUncommittedStats.deletions}</span>
            </p>
            <Input
              value={baseCommitMessage}
              onChange={(e) => setBaseCommitMessage(e.target.value)}
              placeholder="Commit message for base branch"
            />
            <div className="flex items-center justify-between">
              <button
                onClick={() => clearPendingDoneMove()}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Keep in Review
              </button>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => completeDoneMove()}
                  disabled={committingBase}
                >
                  Move to Done anyway
                </Button>
                <Button
                  size="sm"
                  onClick={handleCommitBase}
                  disabled={!baseCommitMessage.trim() || committingBase}
                >
                  {committingBase ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <GitCommit className="h-3 w-3 mr-1" />
                  )}
                  Commit
                </Button>
              </div>
            </div>
          </div>
        )}

        {step === 'commit' && resolved && (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-xs text-muted-foreground">
              {resolved.uncommittedStats.filesChanged} files changed,{' '}
              <span className="text-green-500">+{resolved.uncommittedStats.insertions}</span>{' '}
              <span className="text-red-500">-{resolved.uncommittedStats.deletions}</span>
            </p>
            <Input
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Commit message"
            />
            <div className="flex items-center justify-between">
              <button
                onClick={() => clearPendingDoneMove()}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Keep in Review
              </button>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => completeDoneMove()}
                  disabled={committing}
                >
                  Move to Done anyway
                </Button>
                <Button
                  size="sm"
                  onClick={handleCommit}
                  disabled={!commitMessage.trim() || committing}
                >
                  {committing ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <GitCommit className="h-3 w-3 mr-1" />
                  )}
                  Commit
                </Button>
              </div>
            </div>
          </div>
        )}

        {step === 'merge' && resolved && (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-xs text-muted-foreground">
              Merge <code className="bg-muted px-1 rounded">{resolved.featureBranch}</code> into{' '}
              <code className="bg-muted px-1 rounded">{resolved.baseBranch}</code>
            </p>
            <p className="text-xs text-muted-foreground">
              {resolved.branchStats.filesChanged} files changed,
              <span className="text-green-500"> +{resolved.branchStats.insertions}</span>
              <span className="text-red-500"> -{resolved.branchStats.deletions}</span>,{' '}
              {resolved.branchStats.commitsAhead} commit
              {resolved.branchStats.commitsAhead !== 1 ? 's' : ''} ahead
            </p>
            <div className="flex items-center justify-between">
              <button
                onClick={() => clearPendingDoneMove()}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Keep in Review
              </button>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => completeDoneMove()}
                  disabled={merging}
                >
                  Move to Done anyway
                </Button>
                <Button size="sm" onClick={handleMerge} disabled={merging}>
                  {merging ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <GitMerge className="h-3 w-3 mr-1" />
                  )}
                  Merge
                </Button>
              </div>
            </div>
          </div>
        )}

        {step === 'archive' && resolved && (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-xs text-muted-foreground">
              Merge successful! Archive the{' '}
              <code className="bg-muted px-1 rounded">{resolved.featureBranch}</code> worktree?
            </p>
            <div className="flex items-center justify-between">
              <Button variant="outline" size="sm" onClick={() => completeDoneMove()}>
                Keep
              </Button>
              <Button size="sm" onClick={handleArchive} disabled={archiving}>
                {archiving ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Archive className="h-3 w-3 mr-1" />
                )}
                Archive
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
