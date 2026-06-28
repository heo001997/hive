import { useKanbanStore, ticketKey, parseTicketKey } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'

/**
 * Per-project cap on how many worktrees may run in parallel — the "max in the
 * In Progress column" limit. Hardware-protection feature: too many concurrent
 * worktrees (each with its own Claude session + dev server) overwhelms the machine.
 *
 * "Running" = a ticket sitting in the In Progress column that has actually launched
 * (i.e. no `pending_launch_config` left). A ticket in In Progress that is still
 * queued (carries a pending_launch_config — e.g. a dependency-chain member waiting
 * on its blockers) does NOT occupy a slot, since nothing is executing yet.
 *
 * When the cap is hit, new launches are queued (the ticket keeps its
 * `pending_launch_config`) and auto-started by {@link launchNextQueuedTickets} as
 * soon as a slot frees (a running ticket leaves In Progress).
 */

/** Resolve the configured cap for a project. Returns 0 when unlimited. */
export function getMaxParallelWorktrees(projectId: string): number {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
  const max = project?.max_parallel_worktrees ?? 0
  return Number.isFinite(max) && max > 0 ? Math.floor(max) : 0
}

/** Count worktrees currently running for a project (launched tickets in In Progress). */
export function getRunningWorktreeCount(projectId: string): number {
  const inProgress = useKanbanStore.getState().getTicketsByColumn(projectId, 'in_progress')
  return inProgress.filter((t) => !t.pending_launch_config && !t.archived_at).length
}

/** Whether a new worktree may be launched right now without exceeding the cap. */
export function canLaunchWorktreeNow(projectId: string): boolean {
  const max = getMaxParallelWorktrees(projectId)
  if (max <= 0) return true // 0 = unlimited
  return getRunningWorktreeCount(projectId) < max
}

/**
 * Start as many queued tickets as the project's free slots allow. Called whenever a
 * slot may have freed (a ticket left In Progress) or the cap was raised.
 *
 * Picks the oldest queued ticket (has `pending_launch_config`) whose dependency
 * blockers are all satisfied, launches it, then re-evaluates — launching is async
 * and moves the ticket into In Progress, consuming a slot. A no-op when the project
 * is unlimited.
 */
export async function launchNextQueuedTickets(projectId: string): Promise<void> {
  if (getMaxParallelWorktrees(projectId) <= 0) return

  const [{ autoLaunchTicket }, { isBlockerSatisfied }, { useSettingsStore }] = await Promise.all([
    import('./auto-launch'),
    import('./blocker-utils'),
    import('@/stores/useSettingsStore')
  ])
  const triggerColumn = useSettingsStore.getState().followUpTriggerColumn

  // Tickets we already tried this pass — prevents re-picking one whose launch failed
  // (it keeps its pending_launch_config) and looping forever.
  const attempted = new Set<string>()

  // Bounded loop: at most one launch per iteration; guard caps a runaway.
  for (let guard = 0; guard < 200; guard++) {
    if (!canLaunchWorktreeNow(projectId)) return

    const kanban = useKanbanStore.getState()
    const all = kanban.tickets.get(projectId) ?? []
    const dependencyMap = kanban.dependencyMap

    const ready = all
      .filter(
        (t) =>
          !!t.pending_launch_config &&
          !t.archived_at &&
          t.column !== 'done' &&
          !attempted.has(t.id)
      )
      .filter((t) => {
        const blockers = dependencyMap.get(ticketKey(projectId, t.id))
        if (!blockers || blockers.size === 0) return true
        for (const blockerKey of blockers) {
          const ref = parseTicketKey(blockerKey)
          const blocker = all.find((b) => b.id === ref.ticketId)
          if (blocker && !isBlockerSatisfied(blocker.column, blocker.mode, triggerColumn)) {
            return false
          }
        }
        return true
      })
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))

    const next = ready[0]
    if (!next) return

    attempted.add(next.id)
    await autoLaunchTicket(next)
  }
}
