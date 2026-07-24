import { useKanbanStore, ticketKey, parseTicketKey } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import type { KanbanTicket } from '../../../main/db/types'

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

/** Count worktrees currently running for a project (launched tickets occupying a
 *  worktree). Human Require tickets are blocked on the user but still hold a live
 *  session + worktree, so they count against the cap exactly like In Progress. */
export function getRunningWorktreeCount(projectId: string): number {
  const store = useKanbanStore.getState()
  const active = [
    ...store.getTicketsByColumn(projectId, 'in_progress'),
    ...store.getTicketsByColumn(projectId, 'human_required')
  ]
  return active.filter((t) => !t.pending_launch_config && !t.archived_at).length
}

/** Whether a new worktree may be launched right now without exceeding the cap. */
export function canLaunchWorktreeNow(projectId: string): boolean {
  const max = getMaxParallelWorktrees(projectId)
  if (max <= 0) return true // 0 = unlimited
  return getRunningWorktreeCount(projectId) < max
}

// Projects with a drain loop in flight, and projects asked to re-drain while one was
// already running. A launch is async (createWorktree/createSession) and the running
// count only reflects it once the ticket lands in In Progress — so two concurrent
// loops would both read a stale count and launch past the cap. We serialize per
// project: concurrent callers set a rerun flag instead of starting a second loop.
const launchingProjects = new Set<string>()
const pendingRerun = new Set<string>()

/**
 * Start as many queued tickets as the project's free slots allow. Called whenever a
 * slot may have freed (a ticket left In Progress), a dependent became ready (a blocker
 * reached its trigger column), or the cap was raised.
 *
 * Serialized per project (see {@link launchingProjects}). A no-op when unlimited.
 */
export async function launchNextQueuedTickets(projectId: string): Promise<void> {
  if (getMaxParallelWorktrees(projectId) <= 0) return

  if (launchingProjects.has(projectId)) {
    // A loop is already draining this project; ask it to re-scan once it finishes so
    // state changes that arrived mid-drain (a new queued ticket, a freed slot) aren't
    // missed, rather than racing a second concurrent loop.
    pendingRerun.add(projectId)
    return
  }

  launchingProjects.add(projectId)
  try {
    do {
      pendingRerun.delete(projectId)
      await drainQueueOnce(projectId)
    } while (pendingRerun.has(projectId))
  } finally {
    launchingProjects.delete(projectId)
    pendingRerun.delete(projectId)
  }
}

/**
 * Launch every ready ticket a project just gained OUT OF BAND — i.e. tickets that
 * appeared straight in the DB (the agent-driven condition-gate fix loop CRUDs the
 * next round via the `hive-ticket` CLI) rather than through a store mutation. Such
 * creates never hit the launch triggers baked into {@link launchNextQueuedTickets}
 * (cap>0) or the uncapped dependency-unblock path in `moveTicket`, so a fresh chain
 * HEAD (no blockers) would otherwise never start.
 *
 *   • Capped project → defer to the serialized queue drainer (honors the cap +
 *     chain affinity; it already picks up ready no-blocker heads).
 *   • Uncapped project → the queue drainer is a no-op, so directly launch each
 *     ready ticket (pending config + all blockers satisfied), mirroring the uncapped
 *     dependency launch. Blocked chain members start later as their blockers land.
 *
 * `autoLaunchTicket`'s in-flight guard + cap check make this safe to call even if it
 * races an overlapping trigger.
 */
export async function launchReadyCreatedTickets(projectId: string): Promise<void> {
  if (getMaxParallelWorktrees(projectId) > 0) {
    await launchNextQueuedTickets(projectId)
    return
  }

  const [{ autoLaunchTicket }, { isBlockerSatisfied }, { useSettingsStore }] = await Promise.all([
    import('./auto-launch'),
    import('./blocker-utils'),
    import('@/stores/useSettingsStore')
  ])
  const triggerColumn = useSettingsStore.getState().followUpTriggerColumn
  const kanban = useKanbanStore.getState()
  const all = kanban.tickets.get(projectId) ?? []
  const dependencyMap = kanban.dependencyMap

  for (const t of all) {
    if (!t.pending_launch_config || t.archived_at || t.column === 'done') continue
    const blockers = dependencyMap.get(ticketKey(projectId, t.id))
    let ready = true
    if (blockers && blockers.size > 0) {
      for (const blockerKey of blockers) {
        const ref = parseTicketKey(blockerKey)
        const blocker = all.find((b) => b.id === ref.ticketId)
        if (blocker && !isBlockerSatisfied(blocker.column, blocker.mode, triggerColumn)) {
          ready = false
          break
        }
      }
    }
    if (!ready) continue
    await autoLaunchTicket(t).catch((err) => {
      console.error('Auto-launch failed for out-of-band created ticket:', t.id, err)
    })
  }
}

/** A ticket has "started" once a step has actually run for it — i.e. it launched
 *  (In Progress without a pending config), or has progressed to Review/Done. A
 *  still-queued ticket (pending config in Todo or In Progress) has NOT started. */
function isTicketStarted(t: KanbanTicket): boolean {
  if (t.archived_at) return false
  // Human Require is reached only from a running In Progress session, so a ticket
  // there has unambiguously started (it's blocked on the user mid-run).
  if (t.column === 'done' || t.column === 'review' || t.column === 'human_required') return true
  return t.column === 'in_progress' && !t.pending_launch_config
}

interface ProjectChains {
  /** ticket id → its chain's representative id (dependency connected-component root). */
  componentOf: Map<string, string>
  /** Roots of chains that are "in flight": some step has started, but not all are Done. */
  inFlightRoots: Set<string>
  /** How many chains are currently in flight. */
  inFlightCount: number
}

/**
 * Group a project's (non-archived) tickets into dependency chains — the connected
 * components of the blocker graph — and report which chains are in flight (a step
 * has run, but the chain isn't fully Done). A ticket with no dependency links is its
 * own one-node chain.
 *
 * Used to enforce chain affinity: drain chains already underway before opening new
 * ones (see {@link drainQueueOnce}).
 */
function getProjectChains(projectId: string): ProjectChains {
  const kanban = useKanbanStore.getState()
  const tickets = (kanban.tickets.get(projectId) ?? []).filter((t) => !t.archived_at)
  const dependencyMap = kanban.dependencyMap

  // Union-find over ticket ids; every ticket starts in its own singleton set.
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root) as string
    let cur = x
    while (parent.get(cur) !== root) {
      const nxt = parent.get(cur) as string
      parent.set(cur, root)
      cur = nxt
    }
    return root
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const t of tickets) parent.set(t.id, t.id)
  // Edge per blocker link (dependent ↔ blocker), within this project and present.
  for (const [depKey, blockers] of dependencyMap) {
    const dep = parseTicketKey(depKey)
    if (dep.projectId !== projectId || !parent.has(dep.ticketId)) continue
    for (const blockerKey of blockers) {
      const b = parseTicketKey(blockerKey)
      if (b.projectId === projectId && parent.has(b.ticketId)) union(dep.ticketId, b.ticketId)
    }
  }

  const componentOf = new Map<string, string>()
  const started = new Map<string, boolean>()
  const allDone = new Map<string, boolean>()
  for (const t of tickets) {
    const root = find(t.id)
    componentOf.set(t.id, root)
    if (isTicketStarted(t)) started.set(root, true)
    const done = t.column === 'done'
    allDone.set(root, allDone.has(root) ? (allDone.get(root) as boolean) && done : done)
  }

  const inFlightRoots = new Set<string>()
  for (const root of new Set(componentOf.values())) {
    if (started.get(root) && !allDone.get(root)) inFlightRoots.add(root)
  }
  return { componentOf, inFlightRoots, inFlightCount: inFlightRoots.size }
}

/**
 * One drain pass: repeatedly pick the best queued ticket (has `pending_launch_config`)
 * whose dependency blockers are all satisfied and launch it, re-evaluating after each
 * launch. `autoLaunchTicket` moves the ticket into In Progress and clears its pending
 * config before resolving, so counts are accurate for the next pick.
 *
 * Chain affinity: finish chains already underway before starting new ones.
 *   • A ticket whose chain is already in flight CONTINUES that chain — always allowed,
 *     up to the running-worktree cap.
 *   • A ticket whose chain hasn't started yet OPENS a new chain — allowed only while
 *     fewer than `cap` chains are in flight. So an in-flight chain keeps a slot
 *     reserved across its between-step gaps (e.g. a step sitting in Review), and a new
 *     chain only begins once a started chain has fully finished.
 * Within each group the oldest (`created_at`) ticket goes first.
 */
async function drainQueueOnce(projectId: string): Promise<void> {
  const [{ autoLaunchTicket }, { isBlockerSatisfied }, { useSettingsStore }] = await Promise.all([
    import('./auto-launch'),
    import('./blocker-utils'),
    import('@/stores/useSettingsStore')
  ])
  const triggerColumn = useSettingsStore.getState().followUpTriggerColumn
  const cap = getMaxParallelWorktrees(projectId)

  // Tickets we already tried this pass — prevents re-picking one whose launch failed
  // (it keeps its pending_launch_config) and looping forever.
  const attempted = new Set<string>()

  // Bounded loop: at most one launch per iteration; guard caps a runaway.
  for (let guard = 0; guard < 200; guard++) {
    if (!canLaunchWorktreeNow(projectId)) return

    const kanban = useKanbanStore.getState()
    const all = kanban.tickets.get(projectId) ?? []
    const dependencyMap = kanban.dependencyMap
    const { componentOf, inFlightRoots, inFlightCount } = getProjectChains(projectId)

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

    const continueReady = ready.filter((t) => inFlightRoots.has(componentOf.get(t.id) as string))
    const newChainReady = ready.filter((t) => !inFlightRoots.has(componentOf.get(t.id) as string))

    // Prefer continuing an in-flight chain. Only open a new chain when none can be
    // continued AND a chain slot is free — otherwise stop and leave the slot reserved
    // for the in-flight chain that will reclaim it.
    let next = continueReady[0]
    if (!next && inFlightCount < cap) next = newChainReady[0]
    if (!next) return

    attempted.add(next.id)
    await autoLaunchTicket(next)
  }
}
