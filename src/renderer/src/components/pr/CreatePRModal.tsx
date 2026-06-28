import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  GitPullRequest,
  GitBranch,
  GitFork,
  Check,
  Loader2,
  AlertCircle,
  ChevronDown,
  Plus
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/lib/toast'
import { buildCreatePrPrompt, dispatchCreatePrViaClaudeCli } from '@/lib/create-pr-via-cli'
import { useGitStore, type GitFileStatus } from '@/stores/useGitStore'
import type { GitRemote } from '@/api/git-api'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { gitApi } from '@/api/git-api'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ModalPhase = 'commit' | 'form'

interface CreatePRModalProps {
  worktreeId: string
  worktreePath: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CreatePRModal({ worktreeId, worktreePath }: CreatePRModalProps): React.JSX.Element {
  const open = useGitStore((s) => s.createPRModalOpen)
  const setOpen = useGitStore((s) => s.setCreatePRModalOpen)
  const branchInfo = useGitStore((s) =>
    worktreePath ? (s.branchInfoByWorktree.get(worktreePath) ?? null) : null
  )
  const prTargetBranch = useGitStore((s) =>
    worktreeId ? s.prTargetBranch.get(worktreeId) : undefined
  )
  // Ticket that opened the modal (if any) — drives an inline terminal in the
  // ticket detail instead of redirecting to the worktree view.
  const createPRTicketId = useGitStore((s) => s.createPRTicketId)
  const fileStatusesByWorktree = useGitStore((s) => s.fileStatusesByWorktree)
  const isCommitting = useGitStore((s) => s.isCommitting)
  const loadFileStatuses = useGitStore((s) => s.loadFileStatuses)
  const stageAll = useGitStore((s) => s.stageAll)
  const gitCommit = useGitStore((s) => s.commit)
  const defaultBranchName = useWorktreeStore((s) => {
    for (const [, worktrees] of s.worktreesByProject) {
      if (worktrees.some((w) => w.id === worktreeId)) {
        return worktrees.find((w) => w.is_default)?.branch_name ?? null
      }
    }
    return null
  })

  // ── Session titles for commit message pre-fill ──────────────────
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const sessionTitles: string[] = useMemo(() => {
    if (!worktreePath) return []
    for (const worktrees of worktreesByProject.values()) {
      const wt = worktrees.find((w) => w.path === worktreePath)
      if (wt?.session_titles) {
        try {
          return JSON.parse(wt.session_titles)
        } catch {
          return []
        }
      }
    }
    return []
  }, [worktreePath, worktreesByProject])

  // ── Form state ──────────────────────────────────────────────────
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [baseRemote, setBaseRemote] = useState('origin')
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false)
  const [remoteDropdownOpen, setRemoteDropdownOpen] = useState(false)
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [remoteBranches, setRemoteBranches] = useState<{ name: string; isRemote: boolean }[]>([])
  const [commitCount, setCommitCount] = useState<number | null>(null)
  const [loadingBranches, setLoadingBranches] = useState(false)

  // ── Phase state ─────────────────────────────────────────────────
  const [phase, setPhase] = useState<ModalPhase>('form')

  // ── Commit phase state ───────────────────────────────────────
  const [commitSummary, setCommitSummary] = useState('')
  const [commitDescription, setCommitDescription] = useState('')
  const [commitError, setCommitError] = useState('')
  const [isStaging, setIsStaging] = useState(false)

  // ── Derived: file status for commit phase ───────────────────
  const { uncommittedFiles, stagedCount } = useMemo(() => {
    const files = worktreePath ? fileStatusesByWorktree.get(worktreePath) || [] : []
    return {
      uncommittedFiles: files,
      stagedCount: files.filter((f) => f.staged).length
    }
  }, [worktreePath, fileStatusesByWorktree])

  // ── Reset on open ───────────────────────────────────────────────
  // Guarded so it runs ONCE per open transition. Without this guard the effect
  // re-fires whenever a dependency changes by reference while the modal is open
  // (e.g. `sessionTitles` is a fresh array from JSON.parse on every worktree-
  // store update), which would synchronously reset `phase` back to 'form' and
  // clobber the async `setPhase('commit')` below — so the commit step would
  // never appear first.
  const openedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open) {
      openedKeyRef.current = null
      return
    }
    const openKey = `${worktreeId}:${worktreePath}`
    if (openedKeyRef.current === openKey) return
    openedKeyRef.current = openKey

    // Reset all state
    setTitle('')
    setBody('')
    setPhase('form')
    setCommitCount(null)
    // Pre-fill commit message from session titles (same as GitCommitForm)
    setCommitSummary(sessionTitles[0] ?? '')
    setCommitDescription(
      sessionTitles.length > 1 ? sessionTitles.map((t) => `- ${t}`).join('\n') : ''
    )
    setCommitError('')
    setIsStaging(false)

    // Fetch remotes + remote branches together so we can scope the base-branch
    // list to the chosen repository (origin vs. upstream).
    setLoadingBranches(true)
    Promise.all([
      gitApi.listRemotes(worktreePath),
      gitApi.listBranchesWithStatus(worktreePath)
    ])
      .then(([remotesResult, branchesResult]) => {
        const remoteList: GitRemote[] =
          remotesResult.success && remotesResult.remotes.length > 0
            ? remotesResult.remotes
            : [{ name: 'origin', url: null }]
        setRemotes(remoteList)

        if (branchesResult.success) {
          setRemoteBranches(branchesResult.branches.filter((b) => b.isRemote))
        }

        // Restore the previously selected "<remote>/<branch>" target if any.
        const names = remoteList.map((r) => r.name)
        const stored = prTargetBranch ?? ''
        const slashIndex = stored.indexOf('/')
        const maybeRemote = slashIndex > 0 ? stored.slice(0, slashIndex) : ''
        if (maybeRemote && names.includes(maybeRemote)) {
          setBaseRemote(maybeRemote)
          setBaseBranch(stored.slice(slashIndex + 1) || 'main')
        } else {
          setBaseRemote(names.includes('origin') ? 'origin' : (names[0] ?? 'origin'))
          setBaseBranch(stored.replace(/^[^/]+\//, '') || 'main')
        }
      })
      .catch(() => {
        // Non-critical — keep defaults
        setBaseRemote('origin')
        setBaseBranch(prTargetBranch?.replace(/^[^/]+\//, '') ?? 'main')
      })
      .finally(() => setLoadingBranches(false))

    // Check for uncommitted changes — show commit phase if any
    Promise.all([gitApi.hasUncommittedChanges(worktreePath), loadFileStatuses(worktreePath)])
      .then(([hasUncommitted]) => {
        if (hasUncommitted) setPhase('commit')
      })
      .catch(() => {
        // Non-critical — fall through to form phase
      })
  }, [open, worktreeId, worktreePath, prTargetBranch, loadFileStatuses, sessionTitles])

  // ── Comparison ref: the remote-qualified base, e.g. "upstream/main" ──
  const comparisonRef = useMemo(
    () => (baseRemote && baseBranch ? `${baseRemote}/${baseBranch}` : baseBranch),
    [baseRemote, baseBranch]
  )

  // ── Refresh commit count when base branch/remote changes ────────
  useEffect(() => {
    if (!open || !comparisonRef) return
    setCommitCount(null)
    gitApi
      .getRangeDiff(worktreePath, comparisonRef)
      .then((rd) => setCommitCount(rd.commitCount))
      .catch(() => {
        // Non-critical
      })
  }, [open, worktreePath, comparisonRef])

  // ── Derived: branch names for the selected remote ───────────────
  const branchOptionsFor = useCallback(
    (remote: string): string[] => {
      const prefix = `${remote}/`
      const seen = new Set<string>()
      const result: string[] = []
      for (const b of remoteBranches) {
        if (!b.name.startsWith(prefix)) continue
        const name = b.name.slice(prefix.length)
        // Skip the symbolic "origin/HEAD" pointer
        if (name === 'HEAD' || seen.has(name)) continue
        seen.add(name)
        result.push(name)
      }
      return result.sort((a, b) => {
        if (a === defaultBranchName) return -1
        if (b === defaultBranchName) return 1
        return a.localeCompare(b)
      })
    },
    [remoteBranches, defaultBranchName]
  )

  const branchOptions = useMemo(() => {
    const result = branchOptionsFor(baseRemote)
    // Ensure the current baseBranch is always selectable
    if (baseBranch && !result.includes(baseBranch)) {
      return [baseBranch, ...result]
    }
    return result
  }, [branchOptionsFor, baseRemote, baseBranch])

  // ── Switch target repository, picking a sensible default branch ──
  const handleSelectRemote = useCallback(
    (remote: string) => {
      setBaseRemote(remote)
      setRemoteDropdownOpen(false)
      const opts = branchOptionsFor(remote)
      const next =
        defaultBranchName && opts.includes(defaultBranchName)
          ? defaultBranchName
          : opts.includes('main')
            ? 'main'
            : opts.includes('master')
              ? 'master'
              : (opts[0] ?? baseBranch)
      if (next) setBaseBranch(next)
    },
    [branchOptionsFor, defaultBranchName, baseBranch]
  )

  // ── Commit phase handlers ────────────────────────────────────
  const handleStageAll = useCallback(async () => {
    setIsStaging(true)
    try {
      const success = await stageAll(worktreePath)
      if (success) {
        await loadFileStatuses(worktreePath)
      } else {
        toast.error('Failed to stage files')
      }
    } finally {
      setIsStaging(false)
    }
  }, [worktreePath, stageAll, loadFileStatuses])

  const handleToggleFile = useCallback(
    async (file: GitFileStatus) => {
      if (file.staged) {
        await useGitStore.getState().unstageFile(worktreePath, file.relativePath)
      } else {
        await useGitStore.getState().stageFile(worktreePath, file.relativePath)
      }
      await loadFileStatuses(worktreePath)
    },
    [worktreePath, loadFileStatuses]
  )

  const handleCommitAndContinue = useCallback(async () => {
    if (!commitSummary.trim()) return
    setCommitError('')

    const message = commitDescription.trim()
      ? `${commitSummary.trim()}\n\n${commitDescription.trim()}`
      : commitSummary.trim()

    const result = await gitCommit(worktreePath, message)

    if (result.success) {
      toast.success('Changes committed', {
        description: result.commitHash ? `Commit: ${result.commitHash.slice(0, 7)}` : undefined
      })
      // Refresh commit count and branch info after committing
      if (comparisonRef) {
        gitApi
          .getRangeDiff(worktreePath, comparisonRef)
          .then((rd) => setCommitCount(rd.commitCount))
          .catch(() => {})
      }
      useGitStore.getState().loadBranchInfo(worktreePath)
      setPhase('form')
    } else {
      setCommitError(result.error ?? 'Commit failed')
    }
  }, [worktreePath, commitSummary, commitDescription, gitCommit, comparisonRef])

  const handleSkipCommit = useCallback(() => {
    setPhase('form')
  }, [])

  // ── Create PR flow — hand off to a new Claude Code CLI terminal ─────
  // Instead of generating the PR content with the Claude SDK and creating the PR
  // ourselves, open a fresh Claude Code CLI terminal for this worktree and let it
  // push the branch and run `gh pr create` (generating title/body when the user
  // left them blank). The modal closes immediately; the CLI does the rest.
  const handleCreate = useCallback(async () => {
    if (!baseBranch) return

    // Capture form values before closing
    const targetBase = baseBranch
    const targetRemote = baseRemote || 'origin'
    const prTitle = title.trim()
    const prBody = body.trim()
    const headBranch = branchInfo?.name ?? ''
    const ticketId = createPRTicketId

    // Remote-qualified base ref (e.g. "upstream/main") used for the diff range.
    const targetRef = `${targetRemote}/${targetBase}`

    // Persist the selected target branch so the Header dropdowns keep showing it
    // after the push changes branchInfo.tracking
    const normalizedTarget = targetRef
    useGitStore.getState().setPrTargetBranch(worktreeId, normalizedTarget)

    // Close modal — PR creation continues in the new CLI terminal.
    setOpen(false)

    const prompt = buildCreatePrPrompt({
      headBranch: headBranch || 'the current branch',
      baseBranch: targetBase,
      baseRemote: targetRemote,
      baseRef: targetRef,
      title: prTitle,
      body: prBody
    })

    const result = await dispatchCreatePrViaClaudeCli({ worktreeId, worktreePath, prompt, ticketId })
    if (result.success) {
      toast.success('Creating pull request', {
        description: 'Opened a Claude Code CLI terminal to push the branch and open the PR.'
      })
    } else {
      toast.error('Could not start PR creation', { description: result.error })
    }
  }, [worktreeId, worktreePath, baseBranch, baseRemote, title, body, branchInfo, createPRTicketId, setOpen])

  // ── Cancel handler ──────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    setOpen(false)
  }, [setOpen])

  // ── Render: Commit ──────────────────────────────────────────────
  const renderCommit = (): React.JSX.Element => (
    <>
      {/* Info text */}
      <p className="text-sm text-muted-foreground">
        You have uncommitted changes. Commit them before creating a pull request, or skip to create
        a PR with what&apos;s already committed.
      </p>

      {/* File list */}
      <div className="border rounded-md overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b">
          <span className="text-xs font-medium text-muted-foreground">
            Changed files ({uncommittedFiles.length})
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={handleStageAll}
            disabled={isStaging || isCommitting}
          >
            {isStaging ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <Plus className="h-3 w-3 mr-1" />
            )}
            Stage All
          </Button>
        </div>
        <div className="max-h-[160px] overflow-y-auto">
          {uncommittedFiles.map((file) => (
            <div
              key={file.relativePath}
              className="flex items-center gap-2 px-3 py-1 text-xs hover:bg-accent/30"
            >
              <Checkbox
                checked={file.staged}
                onCheckedChange={() => handleToggleFile(file)}
                className="h-3.5 w-3.5"
              />
              <span
                className={cn(
                  'font-mono w-3 text-center shrink-0',
                  file.status === 'M' && 'text-yellow-500',
                  file.status === 'A' && 'text-green-500',
                  file.status === 'D' && 'text-red-500',
                  file.status === '?' && 'text-muted-foreground'
                )}
              >
                {file.status}
              </span>
              <span className="truncate">{file.relativePath}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Commit message */}
      <div className="space-y-2">
        <div className="relative">
          <Input
            value={commitSummary}
            onChange={(e) => setCommitSummary(e.target.value)}
            placeholder="Commit summary"
            className={cn(
              'pr-12',
              commitSummary.length > 72 && 'border-red-500 focus-visible:ring-red-500',
              commitSummary.length > 50 &&
                commitSummary.length <= 72 &&
                'border-yellow-500 focus-visible:ring-yellow-500'
            )}
            disabled={isCommitting}
          />
          <span
            className={cn(
              'absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono',
              commitSummary.length > 72 && 'text-red-500',
              commitSummary.length > 50 && commitSummary.length <= 72 && 'text-yellow-500',
              commitSummary.length <= 50 && 'text-muted-foreground'
            )}
          >
            {commitSummary.length}/72
          </span>
        </div>
        <Textarea
          value={commitDescription}
          onChange={(e) => setCommitDescription(e.target.value)}
          placeholder="Extended description (optional)"
          rows={2}
          disabled={isCommitting}
        />
      </div>

      {/* Error */}
      {commitError && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{commitError}</span>
        </div>
      )}

      {/* Staged count */}
      {stagedCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {stagedCount} file{stagedCount !== 1 ? 's' : ''} staged for commit
        </p>
      )}
    </>
  )

  // ── Render: Form ────────────────────────────────────────────────
  const renderForm = (): React.JSX.Element => (
    <>
      {/* Source branch (read-only) */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-foreground">Source branch</label>
        <div className="flex items-center gap-2 px-3 py-2 text-sm border rounded-md bg-muted/50 min-w-0">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="truncate">{branchInfo?.name ?? 'Unknown'}</span>
          {commitCount !== null && (
            <span className="ml-auto text-xs text-muted-foreground shrink-0">
              {commitCount} commit{commitCount !== 1 ? 's' : ''} ahead
            </span>
          )}
        </div>
      </div>

      {/* Target repository dropdown — only when more than one remote exists */}
      {remotes.length > 1 && (
        <div className="space-y-1.5">
          <label htmlFor="pr-base-remote" className="text-sm font-medium text-foreground">
            Target repository
          </label>
          <Popover open={remoteDropdownOpen} onOpenChange={setRemoteDropdownOpen}>
            <PopoverTrigger asChild>
              <button
                id="pr-base-remote"
                type="button"
                className={cn(
                  'flex items-center justify-between w-full px-3 py-2 text-sm border rounded-md',
                  'bg-background hover:bg-accent/50 transition-colors text-left'
                )}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <GitFork className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{baseRemote}</span>
                </span>
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 text-muted-foreground transition-transform',
                    remoteDropdownOpen && 'rotate-180'
                  )}
                />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
              <div className="max-h-[200px] overflow-y-auto">
                {remotes.map((remote) => (
                  <button
                    key={remote.name}
                    type="button"
                    className={cn(
                      'flex items-center gap-2 w-full px-3 py-2 text-sm text-left',
                      'hover:bg-accent transition-colors',
                      remote.name === baseRemote && 'bg-accent'
                    )}
                    onClick={() => handleSelectRemote(remote.name)}
                  >
                    <GitFork className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="flex flex-col min-w-0">
                      <span className="truncate">{remote.name}</span>
                      {remote.url && (
                        <span className="truncate text-xs text-muted-foreground">{remote.url}</span>
                      )}
                    </span>
                    {remote.name === baseRemote && (
                      <Check className="h-3 w-3 ml-auto text-primary shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}

      {/* Base branch dropdown */}
      <div className="space-y-1.5">
        <label htmlFor="pr-base-branch" className="text-sm font-medium text-foreground">
          Base branch
        </label>
        <Popover open={branchDropdownOpen} onOpenChange={setBranchDropdownOpen}>
          <PopoverTrigger asChild>
            <button
              id="pr-base-branch"
              type="button"
              className={cn(
                'flex items-center justify-between w-full px-3 py-2 text-sm border rounded-md',
                'bg-background hover:bg-accent/50 transition-colors text-left'
              )}
            >
              <span className="flex items-center gap-2 min-w-0">
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="truncate">{baseBranch || 'Select base branch...'}</span>
              </span>
              <ChevronDown
                className={cn(
                  'h-3.5 w-3.5 text-muted-foreground transition-transform',
                  branchDropdownOpen && 'rotate-180'
                )}
              />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
            {loadingBranches ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : branchOptions.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                No branches found
              </div>
            ) : (
              <div className="max-h-[200px] overflow-y-auto">
                {branchOptions.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={cn(
                      'flex items-center gap-2 w-full px-3 py-2 text-sm text-left',
                      'hover:bg-accent transition-colors',
                      name === baseBranch && 'bg-accent'
                    )}
                    onClick={() => {
                      setBaseBranch(name)
                      setBranchDropdownOpen(false)
                    }}
                  >
                    <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="truncate">{name}</span>
                    {name === baseBranch && (
                      <Check className="h-3 w-3 ml-auto text-primary shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {/* Title */}
      <div className="space-y-1.5">
        <label htmlFor="pr-title" className="text-sm font-medium text-foreground">
          Title
        </label>
        <Input
          id="pr-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Leave empty to auto-generate"
        />
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <label htmlFor="pr-description" className="text-sm font-medium text-foreground">
          Description
        </label>
        <Textarea
          id="pr-description"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Leave empty to auto-generate"
          rows={4}
        />
      </div>
    </>
  )

  // ── Render: Footer ──────────────────────────────────────────────
  const renderFooter = (): React.JSX.Element => {
    switch (phase) {
      case 'commit':
        return (
          <DialogFooter>
            <Button variant="ghost" onClick={handleSkipCommit}>
              Skip
            </Button>
            <Button
              onClick={handleCommitAndContinue}
              disabled={!commitSummary.trim() || stagedCount === 0 || isCommitting}
            >
              {isCommitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  Committing...
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-1.5" />
                  Commit & Continue
                </>
              )}
            </Button>
          </DialogFooter>
        )
      case 'form':
        return (
          <DialogFooter>
            <Button variant="ghost" onClick={handleCancel}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!baseBranch}>
              <GitPullRequest className="h-4 w-4 mr-1.5" />
              Create Pull Request
            </Button>
          </DialogFooter>
        )
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <GitPullRequest className="h-5 w-5" />
              Create Pull Request
            </span>
          </DialogTitle>
          {phase === 'commit' && (
            <DialogDescription>
              Commit your changes before creating a pull request.
            </DialogDescription>
          )}
          {phase === 'form' && (
            <DialogDescription>Create a new pull request for this workspace.</DialogDescription>
          )}
        </DialogHeader>

        {phase === 'commit' && renderCommit()}
        {phase === 'form' && renderForm()}

        {renderFooter()}
      </DialogContent>
    </Dialog>
  )
}
