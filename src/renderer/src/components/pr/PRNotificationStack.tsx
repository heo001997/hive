import { useCallback, useState } from 'react'
import {
  Loader2,
  Check,
  AlertCircle,
  AlertTriangle,
  Info,
  X,
  ExternalLink,
  GitMerge,
  Archive,
  Ticket
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useKanbanStore, ticketKey } from '@/stores/useKanbanStore'
import { openTicketDetail } from '@/lib/navigate-to-ticket'
import { toast } from '@/lib/toast'
import { gitApi } from '@/api/git-api'

// ---------------------------------------------------------------------------
// Status icon
// ---------------------------------------------------------------------------

function StatusIcon({ status }: { status: string }): React.JSX.Element {
  switch (status) {
    case 'loading':
      return <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
    case 'success':
      return <Check className="h-4 w-4 text-emerald-400" />
    case 'error':
      return <AlertCircle className="h-4 w-4 text-red-400" />
    case 'warning':
      return <AlertTriangle className="h-4 w-4 text-amber-400" />
    case 'info':
      return <Info className="h-4 w-4 text-blue-400" />
    default:
      return <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
  }
}

// ---------------------------------------------------------------------------
// Single notification card
// ---------------------------------------------------------------------------

type MergePhase = 'idle' | 'merging' | 'merged' | 'moving' | 'moved' | 'archiving'

function PRNotificationCard({
  id,
  status,
  message,
  description,
  prTitle,
  prUrl,
  prNumber,
  worktreeId,
  ticketId
}: {
  id: string
  status: string
  message: string
  description?: string
  prTitle?: string
  prUrl?: string
  prNumber?: number
  worktreeId?: string
  ticketId?: string
}): React.JSX.Element {
  const dismiss = usePRNotificationStore((s) => s.dismiss)
  const isDone =
    status === 'success' || status === 'error' || status === 'info' || status === 'warning'

  const [mergePhase, setMergePhase] = useState<MergePhase>('idle')
  // Reveal the "Open Ticket" shortcut whenever the card is settled and linked to
  // a worktree — the linked ticket is resolved lazily on click.
  const showOpenTicketButton = !!(worktreeId && isDone)

  // Resolve the owning project reactively so the chain/terminal check can run at
  // render time (the Merge/Archive button visibility depends on it).
  const projectId = useWorktreeStore((s) => {
    if (!worktreeId) return null
    for (const [pid, worktrees] of s.worktreesByProject) {
      if (worktrees.some((w) => w.id === worktreeId)) return pid
    }
    return null
  })

  // A ticket is the chain's last step ("terminal") when no other ticket depends on
  // it. Archiving deletes the shared worktree/branch, so only the terminal ticket
  // may archive — otherwise the next chain ticket loses its branch out from under
  // it. Standalone tickets (and the no-ticket fallback) are terminal.
  const isTerminalTicket = useKanbanStore((s) => {
    if (!ticketId || !projectId) return true
    const myKey = ticketKey(projectId, ticketId)
    for (const blockers of s.dependencyMap.values()) {
      if (blockers.has(myKey)) return false
    }
    return true
  })

  // Merge merges the whole shared branch/PR, so it's only valid on the chain's
  // terminal ticket — merging from an earlier step would ship the chain before
  // the later steps finish their work on the same branch.
  const showMergeButton = !!(
    prNumber &&
    worktreeId &&
    isTerminalTicket &&
    (status === 'success' || status === 'info')
  )

  // True while the originating ticket still needs completing (not yet in Done).
  const ticketNeedsDone = useKanbanStore((s) => {
    if (!projectId) return false
    const list = s.tickets.get(projectId) ?? []
    const t = ticketId
      ? list.find((x) => x.id === ticketId)
      : list.find((x) => x.worktree_id === worktreeId)
    return !!t && t.column !== 'done'
  })

  // Completing a ticket is its own state, independent of merging the shared PR —
  // any not-yet-done ticket (standalone, terminal, or mid-chain) can move to Done.
  // Only Merge/Archive are terminal-gated (they act on the shared branch).
  const showMoveToDoneButton = !!(worktreeId && isDone && ticketNeedsDone && mergePhase === 'idle')

  const handleClose = useCallback(() => {
    dismiss(id)
  }, [id, dismiss])

  // Resolve the worktree's owning project, then navigate to the board and open the
  // originating ticket's detail modal. Prefer the explicit ticketId carried by the
  // notification — chained tickets share one worktree, so resolving by worktree_id
  // alone is ambiguous and would open the wrong ticket.
  const handleOpenTicket = useCallback(async () => {
    if (!worktreeId) return

    const worktreeStore = useWorktreeStore.getState()
    let projectId: string | null = null
    for (const [projId, worktrees] of worktreeStore.worktreesByProject) {
      if (worktrees.some((w) => w.id === worktreeId)) {
        projectId = projId
        break
      }
    }
    if (!projectId) {
      toast.error('Worktree not found')
      return
    }

    // Fall back to the first ticket on the worktree only when no explicit ticket was
    // captured (e.g. PR created from the worktree header rather than a ticket).
    const targetTicketId =
      ticketId ??
      useKanbanStore
        .getState()
        .getTicketsForProject(projectId)
        .find((t) => t.worktree_id === worktreeId)?.id
    if (!targetTicketId) {
      toast.error('Linked ticket not found')
      return
    }

    await openTicketDetail(projectId, targetTicketId)
  }, [worktreeId, ticketId])

  const handleMerge = useCallback(async () => {
    if (!prNumber || !worktreeId) return

    // Resolve worktree path from store
    const worktreeStore = useWorktreeStore.getState()
    let worktreePath: string | null = null
    for (const worktrees of worktreeStore.worktreesByProject.values()) {
      const match = worktrees.find((w) => w.id === worktreeId)
      if (match) {
        worktreePath = match.path
        break
      }
    }
    if (!worktreePath) {
      toast.error('Worktree not found')
      return
    }

    setMergePhase('merging')
    try {
      const result = await gitApi.prMerge(worktreePath, prNumber)
      if (result.success) {
        const pull = result.localBasePull
        if (pull?.pulled) {
          toast.success(`Pulled latest ${pull.baseBranch} locally`)
        }
        if (pull?.warning) {
          toast.warning(pull.warning)
        }
        setMergePhase('merged')
      } else if (result.conflicted) {
        toast.error(result.error ?? 'PR has conflicts with its base branch')
        setMergePhase('idle')
      } else {
        toast.error(`Merge failed: ${result.error}`)
        setMergePhase('idle')
      }
    } catch {
      toast.error('Failed to merge PR')
      setMergePhase('idle')
    }
  }, [prNumber, worktreeId])

  // Step 1 (after merge): advance the linked ticket to Done. Mirrors the
  // MergeOnDoneDialog flow — a merged PR means the work is finished. Only once this
  // succeeds does the card reveal the Archive button (phase 'moved').
  const handleMoveToDone = useCallback(async () => {
    if (!worktreeId) return

    // Resolve the owning project for this worktree.
    const worktreeStore = useWorktreeStore.getState()
    let projectId: string | null = null
    for (const [projId, worktrees] of worktreeStore.worktreesByProject) {
      if (worktrees.some((w) => w.id === worktreeId)) {
        projectId = projId
        break
      }
    }
    if (!projectId) {
      toast.error('Worktree not found')
      return
    }

    // Move the ticket that initiated this PR — not just the first ticket on the
    // worktree. Chained tickets share one worktree, so a worktree_id match would
    // advance the wrong ticket. Fall back to the worktree match only when no
    // explicit ticketId was captured.
    const projectTickets = useKanbanStore.getState().getTicketsForProject(projectId)
    const ticket = ticketId
      ? projectTickets.find((t) => t.id === ticketId)
      : projectTickets.find((t) => t.worktree_id === worktreeId)
    const kanbanStore = useKanbanStore.getState()

    setMergePhase('moving')
    try {
      // No-op when there is no linked ticket or it is already Done — the card still
      // advances so the user can archive.
      if (ticket && ticket.column !== 'done') {
        const doneTickets = kanbanStore.getTicketsByColumn(projectId, 'done')
        const sortOrder = kanbanStore.computeSortOrder(doneTickets, 0)
        await kanbanStore.moveTicket(ticket.id, projectId, 'done', sortOrder)
      }
      setMergePhase('moved')
    } catch (err) {
      console.error('PR notification: move to Done failed', err)
      toast.error('Failed to move ticket to Done')
      setMergePhase('merged')
    }
  }, [worktreeId, ticketId])

  // Step 2 (after Move to Done): archive the worktree.
  const handleArchive = useCallback(async () => {
    if (!worktreeId) return
    // Guard: archiving wipes the shared worktree/branch. Refuse on a non-terminal
    // chain ticket (the button is hidden in that case, but defend in depth).
    if (!isTerminalTicket) return

    // Resolve worktree and project path from stores
    const worktreeStore = useWorktreeStore.getState()
    let worktree: { id: string; path: string; branch_name: string } | null = null
    let projectId: string | null = null
    for (const [projId, worktrees] of worktreeStore.worktreesByProject) {
      const match = worktrees.find((w) => w.id === worktreeId)
      if (match) {
        worktree = match
        projectId = projId
        break
      }
    }
    if (!worktree || !projectId) {
      toast.error('Worktree not found')
      return
    }

    const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
    const projectPath = project?.path
    if (!projectPath) {
      toast.error('Project not found')
      return
    }

    setMergePhase('archiving')
    try {
      const result = await worktreeStore.archiveWorktree(
        worktreeId,
        worktree.path,
        worktree.branch_name,
        projectPath
      )
      if (result.success) {
        dismiss(id)
      } else {
        toast.error(result.error || 'Archive failed')
        setMergePhase('moved')
      }
    } catch {
      toast.error('Failed to archive worktree')
      setMergePhase('moved')
    }
  }, [worktreeId, id, dismiss, isTerminalTicket])

  return (
    <div
      className={cn(
        // Layout
        'relative flex items-start gap-3 px-4 py-3 min-w-[300px] max-w-[380px]',
        // Glass morphism
        'rounded-xl border border-white/[0.08] shadow-xl shadow-black/20',
        'bg-background/70 backdrop-blur-xl backdrop-saturate-150',
        // Entry animation
        'animate-in slide-in-from-right-5 fade-in-0 duration-300',
        // Accent strip
        status === 'success' && 'border-l-2 border-l-emerald-500/60',
        status === 'error' && 'border-l-2 border-l-red-500/60',
        status === 'warning' && 'border-l-2 border-l-amber-500/60',
        status === 'info' && 'border-l-2 border-l-blue-500/60',
        status === 'loading' && 'border-l-2 border-l-blue-500/40'
      )}
    >
      {/* Icon */}
      <div className="mt-0.5 shrink-0">
        <StatusIcon status={status} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-1">
        <p className="text-sm font-medium text-foreground leading-snug">{message}</p>
        {prTitle && (
          <p className="text-xs text-muted-foreground leading-snug line-clamp-2" title={prTitle}>
            {prTitle}
          </p>
        )}
        {description && (
          <p className="text-xs text-muted-foreground leading-snug line-clamp-2">{description}</p>
        )}
        {prUrl && isDone && (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'inline-flex items-center gap-1.5 mt-1 text-xs font-medium',
              'text-blue-400 hover:text-blue-300 transition-colors'
            )}
          >
            <ExternalLink className="h-3 w-3" />
            Open on GitHub
          </a>
        )}
        {(showOpenTicketButton || showMergeButton || showMoveToDoneButton) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {showOpenTicketButton && (
              <button
                type="button"
                onClick={handleOpenTicket}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
                  'bg-blue-500/10 border border-blue-500/30 text-blue-400',
                  'hover:bg-blue-500/20 transition-colors'
                )}
              >
                <Ticket className="h-3 w-3" />
                Open Ticket
              </button>
            )}
            {/* Move to Done — completing a ticket is independent of merging its PR,
                so any not-yet-done ticket gets it. Reuses the 'moving' spinner below. */}
            {showMoveToDoneButton && (
              <button
                type="button"
                onClick={handleMoveToDone}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
                  'bg-emerald-600/10 border border-emerald-600/30 text-emerald-500',
                  'hover:bg-emerald-600/20 transition-colors'
                )}
              >
                <Check className="h-3 w-3" />
                Move to Done
              </button>
            )}
            {showMergeButton && mergePhase === 'idle' && (
              <button
                type="button"
                onClick={handleMerge}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
                  'bg-emerald-600/10 border border-emerald-600/30 text-emerald-500',
                  'hover:bg-emerald-600/20 transition-colors'
                )}
              >
                <GitMerge className="h-3 w-3" />
                Merge PR
              </button>
            )}
            {mergePhase === 'merging' && (
              <button
                type="button"
                disabled
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
                  'bg-emerald-600/10 border border-emerald-600/30 text-emerald-500',
                  'opacity-60 cursor-not-allowed'
                )}
              >
                <Loader2 className="h-3 w-3 animate-spin" />
                Merging...
              </button>
            )}
            {mergePhase === 'merged' && (
              <button
                type="button"
                onClick={handleMoveToDone}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
                  'bg-emerald-600/10 border border-emerald-600/30 text-emerald-500',
                  'hover:bg-emerald-600/20 transition-colors'
                )}
              >
                <Check className="h-3 w-3" />
                Move to Done
              </button>
            )}
            {mergePhase === 'moving' && (
              <button
                type="button"
                disabled
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
                  'bg-emerald-600/10 border border-emerald-600/30 text-emerald-500',
                  'opacity-60 cursor-not-allowed'
                )}
              >
                <Loader2 className="h-3 w-3 animate-spin" />
                Moving to Done...
              </button>
            )}
            {/* Archive deletes the shared worktree/branch — only offer it on the
                chain's terminal ticket so earlier chain steps keep their branch. */}
            {mergePhase === 'moved' && isTerminalTicket && (
              <button
                type="button"
                onClick={handleArchive}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
                  'bg-red-500/10 border border-red-500/30 text-red-500',
                  'hover:bg-red-500/20 transition-colors'
                )}
              >
                <Archive className="h-3 w-3" />
                Archive
              </button>
            )}
            {mergePhase === 'archiving' && (
              <button
                type="button"
                disabled
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
                  'bg-red-500/10 border border-red-500/30 text-red-500',
                  'opacity-60 cursor-not-allowed'
                )}
              >
                <Loader2 className="h-3 w-3 animate-spin" />
                Archiving...
              </button>
            )}
          </div>
        )}
      </div>

      {/* Close button — always rendered but only visible when done */}
      {isDone && (
        <button
          type="button"
          onClick={handleClose}
          className={cn(
            'shrink-0 p-0.5 rounded-md -mt-0.5 -mr-1',
            'text-muted-foreground hover:text-foreground hover:bg-white/[0.06]',
            'transition-colors'
          )}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stack — mounts once in AppLayout
// ---------------------------------------------------------------------------

export function PRNotificationStack(): React.JSX.Element | null {
  const notifications = usePRNotificationStore((s) => s.notifications)

  if (notifications.length === 0) return null

  return (
    <div
      className="absolute top-4 right-4 z-[60] flex flex-col gap-2 pointer-events-auto"
      data-testid="pr-notification-stack"
    >
      {notifications.map((n) => (
        <PRNotificationCard
          key={n.id}
          id={n.id}
          status={n.status}
          message={n.message}
          description={n.description}
          prTitle={n.prTitle}
          prUrl={n.prUrl}
          prNumber={n.prNumber}
          worktreeId={n.worktreeId}
          ticketId={n.ticketId}
        />
      ))}
    </div>
  )
}
