import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
  KanbanTicket,
  KanbanTicketColumn,
  KanbanTicketCreate,
  KanbanTicketUpdate,
  MarkdownCardDiagnostic,
  TicketDependency
} from '../../../main/db/types'
import {
  registerKanbanSessionSync,
  registerKanbanNewSession,
  registerKanbanAutoCreateTicket,
  registerKanbanRenameSync,
  type KanbanSessionEvent
} from './store-coordination'
import { isPlanLike } from '../lib/constants'
import { sortTicketsBy, SORT_STEP, type SortField, type SortDir } from '../lib/kanban-sort'
import { useConnectionStore } from './useConnectionStore'
import { usePinnedStore } from './usePinnedStore'
import { useWorktreeStatusStore } from './useWorktreeStatusStore'
import { kanbanApi as kanban } from '@/api/kanban-api'

export interface BoardTelegramTarget {
  ticketId: string
  projectId: string
  worktreeId: string
  sessionId: string
}

export interface TicketRef {
  projectId: string
  ticketId: string
}

export type TicketKey = string

export interface MarkdownCardPlaceholder {
  projectId: string
  filePath: string
  kind: MarkdownCardDiagnostic['kind']
  message: string
  blocking: true
}

export function ticketKey(projectId: string, ticketId: string): TicketKey {
  return `${encodeURIComponent(projectId)}:${encodeURIComponent(ticketId)}`
}

export function ticketRefKey(ref: TicketRef): TicketKey {
  return ticketKey(ref.projectId, ref.ticketId)
}

export function parseTicketKey(key: TicketKey): TicketRef {
  const separator = key.indexOf(':')
  if (separator === -1) return { projectId: '', ticketId: decodeURIComponent(key) }
  return {
    projectId: decodeURIComponent(key.slice(0, separator)),
    ticketId: decodeURIComponent(key.slice(separator + 1))
  }
}

// ── Shared drag state (module-level, avoids DataTransfer issues in Electron) ──
export interface KanbanDragData {
  projectId: string
  ticketId: string
  sourceColumn: string
  sourceIndex: number
}

let _kanbanDragData: KanbanDragData | null = null
let _pendingDragTicketKeyFrame: number | undefined

export function setKanbanDragData(data: KanbanDragData | null): void {
  _kanbanDragData = data

  // Cancel any pending delayed draggingTicketKey update
  if (_pendingDragTicketKeyFrame !== undefined) {
    cancelAnimationFrame(_pendingDragTicketKeyFrame)
    _pendingDragTicketKeyFrame = undefined
  }

  if (data) {
    // isDragging set immediately so columns show drag affordance
    useKanbanStore.setState({ isDragging: true })
    // Delay draggingTicketKey to next frame — the wrapper collapse must happen
    // AFTER the browser has committed the drag (captured the drag image and
    // started tracking the pointer). Collapsing during dragstart aborts the drag.
    _pendingDragTicketKeyFrame = requestAnimationFrame(() => {
      _pendingDragTicketKeyFrame = undefined
      useKanbanStore.setState({ draggingTicketKey: ticketKey(data.projectId, data.ticketId) })
    })
  } else {
    // Clear everything immediately on drag end / drop. Clearing isMultiDragging
    // here (called by both handleDrop and handleDragEnd) un-hides the moved cards
    // in their new column before the optimistic re-render, avoiding a flicker.
    useKanbanStore.setState({ isDragging: false, draggingTicketKey: null, isMultiDragging: false })
  }
}

export function getKanbanDragData(): KanbanDragData | null {
  return _kanbanDragData
}

// ── Layout animation suppression (module-level, shared across all columns) ──
// Set during drag-and-drop so the resulting re-render uses instant transitions.
// Cleared after a short delay to ensure React has committed the render.
let _suppressLayoutAnimation = false

export function suppressLayoutAnimation(): void {
  _suppressLayoutAnimation = true
  setTimeout(() => {
    _suppressLayoutAnimation = false
  }, 300)
}

export function isLayoutAnimationSuppressed(): boolean {
  return _suppressLayoutAnimation
}

// ── Column ordering for sort comparisons ───────────────────────────────
const COLUMN_ORDER: Record<KanbanTicketColumn, number> = {
  todo: 0,
  in_progress: 1,
  review: 2,
  done: 3
}

function findTicketByRef(
  ticketsByProject: Map<string, KanbanTicket[]>,
  ref: TicketRef
): KanbanTicket | null {
  return ticketsByProject.get(ref.projectId)?.find((ticket) => ticket.id === ref.ticketId) ?? null
}

function removeDependencyLinksForTicket(
  dependencyMap: Map<TicketKey, Set<TicketKey>>,
  removedKey: TicketKey
): Map<TicketKey, Set<TicketKey>> {
  const newMap = new Map(dependencyMap)
  newMap.delete(removedKey)
  for (const [depKey, blockers] of newMap) {
    if (!blockers.has(removedKey)) continue
    const newSet = new Set(blockers)
    newSet.delete(removedKey)
    if (newSet.size === 0) {
      newMap.delete(depKey)
    } else {
      newMap.set(depKey, newSet)
    }
  }
  return newMap
}

function placeholdersFromDiagnostics(
  projectId: string,
  diagnostics: MarkdownCardDiagnostic[],
  tickets: KanbanTicket[] = []
): MarkdownCardPlaceholder[] {
  const renderedTicketIds = new Set(tickets.map((ticket) => ticket.id))
  return diagnostics
    .filter(
      (diagnostic) =>
        diagnostic.blocking && (!diagnostic.ticketId || !renderedTicketIds.has(diagnostic.ticketId))
    )
    .map((diagnostic) => ({
      projectId,
      filePath: diagnostic.filePath,
      kind: diagnostic.kind,
      message: diagnostic.message,
      blocking: true
    }))
}

// ── State interface ────────────────────────────────────────────────────
interface KanbanState {
  /** Tickets keyed by project ID */
  tickets: Map<string, KanbanTicket[]>
  isLoading: boolean
  /** Whether the kanban board view is active — persisted to localStorage */
  isBoardViewActive: boolean
  /** Per-project simple mode toggle — persisted to localStorage */
  simpleModeByProject: Record<string, boolean>
  /** Currently selected ticket ID for the detail modal (null = closed) */
  selectedTicketId: string | null
  selectedTicketRef: TicketRef | null
  /** Multi-select: ticket keys selected via marquee drag / modifier-click */
  selectedTicketKeys: Set<TicketKey>
  /** Whether a ticket is currently being dragged (reactive, for column styling) */
  isDragging: boolean
  draggingTicketKey: TicketKey | null
  /** True while a multi-selection drag is in flight — hides every selected card so the stacked drag image reads as the whole group lifting off. */
  isMultiDragging: boolean
  /** Per-project archive visibility toggle — NOT persisted to localStorage */
  showArchivedByProject: Record<string, boolean>
  markdownDiagnostics: Map<string, MarkdownCardDiagnostic[]>
  markdownPlaceholders: Map<string, MarkdownCardPlaceholder[]>
  /** Pending "move to done" data — set when a feature-branch ticket is dropped on Done, triggering the merge dialog */
  pendingDoneMove: {
    ticketId: string
    projectId: string
    sortOrder: number
  } | null
  /** Ephemeral board focus target used by the header Telegram toggle. */
  boardTelegramTarget: BoardTelegramTarget | null

  // ── Actions ────────────────────────────────────────────────────────
  setSelectedTicketId: (id: null) => void
  setSelectedTicketRef: (ref: TicketRef | null) => void
  setSelectedTicketKeys: (keys: Iterable<TicketKey>) => void
  /** Add the key if absent, remove it if present (Cmd/Ctrl-click toggle). */
  toggleSelectedTicketKey: (key: TicketKey) => void
  clearSelectedTicketKeys: () => void
  setBoardTelegramTarget: (target: BoardTelegramTarget | null) => void
  clearBoardTelegramTarget: () => void
  loadTickets: (projectId: string) => Promise<void>
  createTicket: (projectId: string, data: KanbanTicketCreate) => Promise<KanbanTicket>
  updateTicket: (ticketId: string, projectId: string, data: KanbanTicketUpdate) => Promise<void>
  deleteTicket: (ticketId: string, projectId: string) => Promise<void>
  moveTicketToProject: (
    ticketId: string,
    sourceProjectId: string,
    targetProjectId: string
  ) => Promise<KanbanTicket | null>
  moveTicket: (
    ticketId: string,
    projectId: string,
    column: KanbanTicketColumn,
    sortOrder: number
  ) => Promise<void>
  reorderTicket: (ticketId: string, projectId: string, newSortOrder: number) => Promise<void>
  /** Move several tickets to a column at once (multi-select drag), appended in order. */
  moveTicketsToColumn: (refs: TicketRef[], column: KanbanTicketColumn) => Promise<void>
  applyColumnSort: (tickets: KanbanTicket[], field: SortField, dir: SortDir) => Promise<void>
  toggleBoardView: () => void
  setSimpleMode: (projectId: string, enabled: boolean) => Promise<void>
  archiveTicket: (ticketId: string, projectId: string) => Promise<void>
  archiveAllDone: (projectId: string) => Promise<number>
  unarchiveTicket: (ticketId: string, projectId: string) => Promise<void>
  detachWorktreeTickets: (worktreeId: string) => Promise<void>
  setShowArchived: (projectId: string, show: boolean) => void
  setPendingDoneMove: (data: { ticketId: string; projectId: string; sortOrder: number }) => void
  clearPendingDoneMove: () => void
  completeDoneMove: () => Promise<void>

  // ── Session coordination ────────────────────────────────────────────
  syncTicketWithSession: (sessionId: string, event: KanbanSessionEvent) => void
  relinkTicketsForHandoff: (
    oldSessionId: string,
    newSessionId: string,
    goalMode?: boolean
  ) => Promise<void>

  // ── Getters ────────────────────────────────────────────────────────
  getTicketsForProject: (projectId: string) => KanbanTicket[]
  getTicketsByColumn: (projectId: string, column: KanbanTicketColumn) => KanbanTicket[]
  getArchivedTicketsByColumn: (projectId: string, column: KanbanTicketColumn) => KanbanTicket[]
  getDiagnosticsForTicket: (projectId: string, ticketId: string) => MarkdownCardDiagnostic[]
  getInvalidPlaceholdersForProject: (projectId: string) => MarkdownCardPlaceholder[]
  loadTicketsForProjectInAggregate: (projectId: string) => Promise<void>

  // ── Connection-level accessors ──────────────────────────────────────
  getConnectionProjectIds: (connectionId: string) => string[]
  loadTicketsForConnection: (connectionId: string) => Promise<void>
  getTicketsByColumnForConnection: (
    connectionId: string,
    column: KanbanTicketColumn
  ) => KanbanTicket[]
  getInvalidPlaceholdersForConnection: (connectionId: string) => MarkdownCardPlaceholder[]

  // ── Pinned board accessors ──────────────────────────────────────────
  isPinnedBoardActive: boolean
  togglePinnedBoard: () => void
  loadTicketsForPinnedProjects: () => Promise<void>
  getTicketsByColumnForPinned: (column: KanbanTicketColumn) => KanbanTicket[]
  getInvalidPlaceholdersForPinned: () => MarkdownCardPlaceholder[]
  getPinnedProjectIdsArray: () => string[]

  // ── PR data sync ───────────────────────────────────────────────────
  syncPRToTicket: (worktreeId: string, prNumber: number, prUrl: string) => void
  clearPRFromTicket: (worktreeId: string) => void
  attachPRToTicket: (ticketId: string, projectId: string, prNumber: number, prUrl: string) => void
  detachPRFromTicket: (ticketId: string, projectId: string) => void

  // ── Helpers ────────────────────────────────────────────────────────
  computeSortOrder: (tickets: KanbanTicket[], targetIndex: number) => number

  // ── Dependency tracking ────────────────────────────────────────────
  dependencyMap: Map<TicketKey, Set<TicketKey>> // Map<dependent_ticket_key, Set<blocker_ticket_key>>
  dependencyMode: { active: boolean; sourceTicketId: string | null; sourceProjectId?: string | null } | null
  hoveredBlockedTicketKey: TicketKey | null

  // ── Dependency actions ─────────────────────────────────────────────
  loadDependencies: (projectId: string) => Promise<void>
  addDependency: (dependent: TicketRef, blocker: TicketRef) => Promise<{ success: boolean; error?: string }>
  removeDependency: (dependent: TicketRef, blocker: TicketRef) => Promise<void>
  enterDependencyMode: (sourceTicketId: string, sourceProjectId?: string) => void
  exitDependencyMode: () => void
  setHoveredBlockedTicketRef: (ref: TicketRef | null) => void
}

// Pending auto-approve settle timers, keyed by ticketKey. Kept at module scope
// (not in the store) since they are transient and must not trigger re-renders.
const pendingAutoApprove = new Map<TicketKey, ReturnType<typeof setTimeout>>()

/** Cancel a scheduled auto-approve for a ticket (e.g. it left Review or resumed work). */
function cancelAutoApprove(key: TicketKey): void {
  const timer = pendingAutoApprove.get(key)
  if (timer) {
    clearTimeout(timer)
    pendingAutoApprove.delete(key)
  }
}

/**
 * Schedule an auto-approve after a settle delay. Reschedules if already pending.
 * The delay absorbs the transient "completed → working → completed" churn that
 * occurs with multi-turn agents, queued follow-ups, and app-relaunch status
 * replays — a real resume of work cancels the timer before it fires.
 */
function scheduleAutoApprove(
  get: () => KanbanState,
  ticketId: string,
  projectId: string,
  delayMs: number
): void {
  const key = ticketKey(projectId, ticketId)
  cancelAutoApprove(key)
  const timer = setTimeout(() => {
    pendingAutoApprove.delete(key)
    void maybeAutoApprove(get, ticketId, projectId)
  }, Math.max(0, delayMs))
  pendingAutoApprove.set(key, timer)
}

/**
 * True when another ticket declares this ticket as a blocker — i.e. it is a
 * non-terminal link in a dependency chain. Terminal tickets (the last step of a
 * chain, or a standalone ticket) have no dependents.
 */
function ticketHasDependent(
  get: () => KanbanState,
  projectId: string,
  ticketId: string
): boolean {
  const key = ticketKey(projectId, ticketId)
  for (const blockers of get().dependencyMap.values()) {
    if (blockers.has(key)) return true
  }
  return false
}

/**
 * Stage & commit a ticket's worktree. Non-fatal: an empty or failed commit is
 * logged, not thrown — it must never block the surrounding flow.
 */
async function commitTicketWorktree(ticketId: string, ticket: KanbanTicket): Promise<void> {
  if (!ticket.worktree_id) return
  try {
    const { dbApi } = await import('@/api/db-api')
    const { gitApi } = await import('@/api/git-api')
    const worktree = await dbApi.worktree.get<{ path: string }>(ticket.worktree_id)
    if (worktree?.path) {
      await gitApi.stageAll(worktree.path)
      const message = ticket.title?.trim() || 'Auto commit on review'
      // commit returns { success: false } when there is nothing to commit — ignore it.
      await gitApi.commit(worktree.path, message)
    }
  } catch (err) {
    console.error('Auto-approve review: commit failed for ticket', ticketId, err)
  }
}

/** Advance a settled ticket to Done (unblocks + auto-launches its dependents). */
async function moveReviewedTicketToDone(
  get: () => KanbanState,
  ticketId: string,
  projectId: string
): Promise<void> {
  try {
    const doneTickets = (get().tickets.get(projectId) ?? []).filter((t) => t.column === 'done')
    const sortOrder = get().computeSortOrder(doneTickets, doneTickets.length)
    await get().moveTicket(ticketId, projectId, 'done', sortOrder)
  } catch (err) {
    console.error('Auto-approve review: move to Done failed for ticket', ticketId, err)
  }
}

/**
 * Re-validate, at fire time, that auto-approving is still safe, then act —
 * CHAIN-AWARE:
 *   • Commit the worktree (if enabled) — every chain step commits.
 *   • Non-terminal ticket (something depends on it) → move to Done, which
 *     unblocks and auto-launches the next chain ticket via its own
 *     pending_launch_config (the previously-configured worktree is respected).
 *   • Terminal ticket (last step / standalone) → stay in Review for the human
 *     to PR & merge.
 *
 * Safety guards (all must hold, else abort silently leaving the ticket in
 * Review): the ticket is still opted in (`auto_approve_review`); it is still a
 * build ticket sitting in Review; its session is genuinely idle (`completed`)
 * and has been so for the
 * full settle window; and there are no queued follow-up messages.
 */
async function maybeAutoApprove(
  get: () => KanbanState,
  ticketId: string,
  projectId: string
): Promise<void> {
  const current = (get().tickets.get(projectId) ?? []).find((t) => t.id === ticketId)
  if (!current || current.column !== 'review' || current.mode !== 'build') return

  // Per-ticket opt-in is the source of truth (seeded from the global default at
  // creation, overridable in Ticket Detail). The global setting no longer gates here.
  if (!current.auto_approve_review) return

  const { useSettingsStore } = await import('./useSettingsStore')
  const settings = useSettingsStore.getState()
  const settleMs = Math.max(0, (settings.kanbanAutoApproveDelaySeconds ?? 10) * 1000)

  const sessionId = current.current_session_id
  if (sessionId) {
    const { useWorktreeStatusStore } = await import('./useWorktreeStatusStore')
    const { useSessionStore } = await import('./useSessionStore')
    // Session must be idle (`completed`) — not working/planning/permission/error —
    // and must have stayed that way for the full settle window.
    const statusEntry = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
    if (!statusEntry || statusEntry.status !== 'completed') return
    if (Date.now() - statusEntry.timestamp < settleMs) return
    // No queued follow-up turns waiting to run.
    const queued = useSessionStore.getState().pendingFollowUpMessages.get(sessionId)
    if (queued && queued.length > 0) return
  }

  // Passed all safety guards. Commit first (so each chain step is its own commit).
  if (settings.kanbanAutoCommitOnReview) {
    await commitTicketWorktree(ticketId, current)
  }

  // Only non-terminal tickets auto-advance to Done; terminal tickets wait for the human.
  if (ticketHasDependent(get, projectId, ticketId)) {
    await moveReviewedTicketToDone(get, ticketId, projectId)
  }
}

// ── Store ──────────────────────────────────────────────────────────────
export const useKanbanStore = create<KanbanState>()(
  persist(
    (set, get) => ({
      tickets: new Map(),
      isLoading: false,
      isBoardViewActive: false,
      isPinnedBoardActive: false,
      simpleModeByProject: {} as Record<string, boolean>,
      selectedTicketId: null,
      selectedTicketRef: null,
      selectedTicketKeys: new Set<TicketKey>(),
      isDragging: false,
      draggingTicketKey: null,
      isMultiDragging: false,
      showArchivedByProject: {} as Record<string, boolean>,
      markdownDiagnostics: new Map(),
      markdownPlaceholders: new Map(),
      pendingDoneMove: null,
      boardTelegramTarget: null,
      dependencyMap: new Map(),
      dependencyMode: null,
      hoveredBlockedTicketKey: null,

      // ── setSelectedTicketId ────────────────────────────────────────
      setSelectedTicketId: (_id: null) => {
        set({ selectedTicketId: null, selectedTicketRef: null })
      },

      setSelectedTicketRef: (ref: TicketRef | null) => {
        set({ selectedTicketId: ref?.ticketId ?? null, selectedTicketRef: ref })
      },

      setSelectedTicketKeys: (keys: Iterable<TicketKey>) => {
        set({ selectedTicketKeys: new Set(keys) })
      },

      toggleSelectedTicketKey: (key: TicketKey) => {
        const next = new Set(get().selectedTicketKeys)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        set({ selectedTicketKeys: next })
      },

      clearSelectedTicketKeys: () => {
        // Avoid churning a fresh empty Set (and re-running every card selector)
        // when nothing is selected.
        if (get().selectedTicketKeys.size === 0) return
        set({ selectedTicketKeys: new Set<TicketKey>() })
      },

      setBoardTelegramTarget: (target: BoardTelegramTarget | null) => {
        set({ boardTelegramTarget: target })
      },

      clearBoardTelegramTarget: () => {
        set({ boardTelegramTarget: null })
      },

      // ── loadTickets ──────────────────────────────────────────────
      loadTickets: async (projectId: string) => {
        set({ isLoading: true })
        try {
          const includeArchived = get().showArchivedByProject[projectId] ?? false
          const tickets = await kanban.ticket.getByProject<KanbanTicket>(
            projectId,
            includeArchived
          )
          const diagnostics = await kanban.diagnostics
            .get<MarkdownCardDiagnostic>(projectId)
            .catch(() => [])
          set((state) => {
            const next = new Map(state.tickets)
            const nextDiagnostics = new Map(state.markdownDiagnostics)
            const nextPlaceholders = new Map(state.markdownPlaceholders)
            next.set(projectId, tickets)
            nextDiagnostics.set(projectId, diagnostics)
            nextPlaceholders.set(
              projectId,
              placeholdersFromDiagnostics(projectId, diagnostics, tickets)
            )
            return {
              tickets: next,
              markdownDiagnostics: nextDiagnostics,
              markdownPlaceholders: nextPlaceholders,
              isLoading: false
            }
          })
          // Load dependencies for this project
          get().loadDependencies(projectId)
        } catch {
          set({ isLoading: false })
        }
      },

      loadTicketsForProjectInAggregate: async (projectId: string) => {
        set({ isLoading: true })
        try {
          const includeArchived = get().showArchivedByProject[projectId] ?? get().showArchivedByProject[''] ?? false
          const tickets = await kanban.ticket.getByProject<KanbanTicket>(
            projectId,
            includeArchived
          )
          const diagnostics = await kanban.diagnostics
            .get<MarkdownCardDiagnostic>(projectId)
            .catch(() => [])
          set((state) => {
            const next = new Map(state.tickets)
            const nextDiagnostics = new Map(state.markdownDiagnostics)
            const nextPlaceholders = new Map(state.markdownPlaceholders)
            next.set(projectId, tickets)
            nextDiagnostics.set(projectId, diagnostics)
            nextPlaceholders.set(
              projectId,
              placeholdersFromDiagnostics(projectId, diagnostics, tickets)
            )
            return {
              tickets: next,
              markdownDiagnostics: nextDiagnostics,
              markdownPlaceholders: nextPlaceholders,
              isLoading: false
            }
          })
          get().loadDependencies(projectId)
        } catch {
          set({ isLoading: false })
        }
      },

      // ── createTicket ─────────────────────────────────────────────
      createTicket: async (projectId: string, data: KanbanTicketCreate) => {
        // Seed the per-ticket Review auto-approve flag from the global default
        // (Settings → "Auto-approve Review by default"), unless the caller set it.
        let seeded = data
        if (data.auto_approve_review === undefined) {
          const { useSettingsStore } = await import('./useSettingsStore')
          seeded = { ...data, auto_approve_review: useSettingsStore.getState().kanbanAutoApproveReview }
        }
        const ticket = await kanban.ticket.create<KanbanTicket, KanbanTicketCreate>(
          projectId,
          seeded
        )
        set((state) => {
          const next = new Map(state.tickets)
          const existing = next.get(projectId) ?? []
          next.set(projectId, [...existing, ticket])
          return { tickets: next }
        })
        return ticket
      },

      // ── updateTicket (optimistic) ────────────────────────────────
      updateTicket: async (ticketId: string, projectId: string, data: KanbanTicketUpdate) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        // Optimistic local update
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) =>
            t.id === ticketId ? { ...t, ...data } : t
          )
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await kanban.ticket.update(projectId, ticketId, data)
        } catch (err) {
          // Revert on failure
          set((state) => {
            const next = new Map(state.tickets)
            next.set(projectId, snapshot)
            return { tickets: next }
          })
          throw err
        }

        // Toggling the per-ticket flag while the ticket already sits idle in Review
        // must (re)arm or cancel the settle timer — column moves are handled by
        // moveTicket, but an in-place flag change is not.
        if (data.auto_approve_review !== undefined) {
          const updated = (get().tickets.get(projectId) ?? []).find((t) => t.id === ticketId)
          if (updated?.column === 'review' && updated.mode === 'build' && updated.auto_approve_review) {
            const { useSettingsStore } = await import('./useSettingsStore')
            scheduleAutoApprove(
              get,
              ticketId,
              projectId,
              (useSettingsStore.getState().kanbanAutoApproveDelaySeconds ?? 10) * 1000
            )
          } else {
            cancelAutoApprove(ticketKey(projectId, ticketId))
          }
        }
      },

      // ── deleteTicket (optimistic) ────────────────────────────────
      deleteTicket: async (ticketId: string, projectId: string) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        // Optimistic local delete
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).filter((t) => t.id !== ticketId)
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await kanban.ticket.delete(projectId, ticketId)

          // Remove all dependency links for deleted ticket
          kanban.dependency.removeAll(projectId, ticketId).catch(() => {})
          // Update local dependency map
          set((state) => {
            return { dependencyMap: removeDependencyLinksForTicket(state.dependencyMap, ticketKey(projectId, ticketId)) }
          })
        } catch (err) {
          // Revert on failure
          set((state) => {
            const next = new Map(state.tickets)
            next.set(projectId, snapshot)
            return { tickets: next }
          })
          throw err
        }
      },

      // ── moveTicketToProject (optimistic) ─────────────────────────
      moveTicketToProject: async (
        ticketId: string,
        sourceProjectId: string,
        targetProjectId: string
      ) => {
        if (sourceProjectId === targetProjectId) return null

        const prevSource = get().tickets.get(sourceProjectId) ?? []
        const moved = prevSource.find((t) => t.id === ticketId)
        if (!moved) return null
        const sourceSnapshot = prevSource.map((t) => ({ ...t }))

        // Optimistic: remove from the source project's list
        set((state) => {
          const next = new Map(state.tickets)
          next.set(
            sourceProjectId,
            (next.get(sourceProjectId) ?? []).filter((t) => t.id !== ticketId)
          )
          const update: Partial<KanbanState> = { tickets: next }
          // Selection lives under the source board; clear it if this ticket was selected
          if (
            state.selectedTicketRef?.projectId === sourceProjectId &&
            state.selectedTicketRef.ticketId === ticketId
          ) {
            update.selectedTicketId = null
            update.selectedTicketRef = null
          } else if (!state.selectedTicketRef && state.selectedTicketId === ticketId) {
            update.selectedTicketId = null
          }
          return update
        })

        try {
          const updated = await kanban.ticket.moveToProject<KanbanTicket | null>(
            sourceProjectId,
            ticketId,
            targetProjectId
          )

          // If the target board is already loaded, surface the moved ticket there
          if (updated) {
            set((state) => {
              if (!state.tickets.has(targetProjectId)) return {}
              const next = new Map(state.tickets)
              const targetTickets = next.get(targetProjectId) ?? []
              if (targetTickets.some((t) => t.id === ticketId)) return {}
              next.set(targetProjectId, [...targetTickets, updated])
              return { tickets: next }
            })
          }

          // Detach dependency links (they reference the source project's board)
          kanban.dependency.removeAll(sourceProjectId, ticketId).catch(() => {})
          set((state) => {
            return {
              dependencyMap: removeDependencyLinksForTicket(
                state.dependencyMap,
                ticketKey(sourceProjectId, ticketId)
              )
            }
          })

          return updated
        } catch (err) {
          // Revert on failure
          set((state) => {
            const next = new Map(state.tickets)
            next.set(sourceProjectId, sourceSnapshot)
            return { tickets: next }
          })
          throw err
        }
      },

      // ── archiveTicket (optimistic) ─────────────────────────────────
      archiveTicket: async (ticketId: string, projectId: string) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        const now = new Date().toISOString()
        // Optimistic local archive
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) =>
            t.id === ticketId ? { ...t, archived_at: now, updated_at: now } : t
          )
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await kanban.ticket.archive(projectId, ticketId)

          // Remove all dependency links for archived ticket
          await kanban.dependency.removeAll(projectId, ticketId)
          // Update local dependency map
          set((state) => {
            return { dependencyMap: removeDependencyLinksForTicket(state.dependencyMap, ticketKey(projectId, ticketId)) }
          })
        } catch (err) {
          // Revert on failure
          set((state) => {
            const next = new Map(state.tickets)
            next.set(projectId, snapshot)
            return { tickets: next }
          })
          throw err
        }
      },

      // ── archiveAllDone (optimistic) ────────────────────────────────
      archiveAllDone: async (projectId: string): Promise<number> => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        const now = new Date().toISOString()
        let count = 0
        // Optimistic local archive of all non-archived done tickets
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) => {
            if (t.column === 'done' && !t.archived_at) {
              count++
              return { ...t, archived_at: now, updated_at: now }
            }
            return t
          })
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await kanban.ticket.archiveAllDone(projectId)
          return count
        } catch (err) {
          // Revert on failure
          set((state) => {
            const next = new Map(state.tickets)
            next.set(projectId, snapshot)
            return { tickets: next }
          })
          throw err
        }
      },

      // ── unarchiveTicket (optimistic) ───────────────────────────────
      unarchiveTicket: async (ticketId: string, projectId: string) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        const now = new Date().toISOString()
        // Optimistic local unarchive
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) =>
            t.id === ticketId ? { ...t, archived_at: null, updated_at: now } : t
          )
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await kanban.ticket.unarchive(projectId, ticketId)
        } catch (err) {
          // Revert on failure
          set((state) => {
            const next = new Map(state.tickets)
            next.set(projectId, snapshot)
            return { tickets: next }
          })
          throw err
        }
      },

      // ── detachWorktreeTickets (optimistic) ────────────────────────
      detachWorktreeTickets: async (worktreeId: string) => {
        const snapshot = new Map<string, KanbanTicket[]>()
        const now = new Date().toISOString()

        set((state) => {
          const next = new Map(state.tickets)
          let anyChanged = false

          for (const [projectId, projectTickets] of next) {
            let projectChanged = false
            const updated = projectTickets.map((ticket) => {
              if (ticket.worktree_id !== worktreeId) return ticket
              projectChanged = true
              return {
                ...ticket,
                worktree_id: null,
                updated_at: now
              }
            })

            if (projectChanged) {
              anyChanged = true
              snapshot.set(
                projectId,
                projectTickets.map((t) => ({ ...t }))
              )
              next.set(projectId, updated)
            }
          }

          return anyChanged ? { tickets: next } : {}
        })

        try {
          await kanban.ticket.detachWorktree(worktreeId)
        } catch (err) {
          if (snapshot.size > 0) {
            set((state) => {
              const next = new Map(state.tickets)
              for (const [projectId, projectTickets] of snapshot) {
                next.set(projectId, projectTickets)
              }
              return { tickets: next }
            })
          }
          throw err
        }
      },

      // ── setShowArchived ────────────────────────────────────────────
      setShowArchived: (projectId: string, show: boolean) => {
        set((state) => ({
          showArchivedByProject: { ...state.showArchivedByProject, [projectId]: show }
        }))
        // Re-fetch tickets with updated archive visibility
        // (multi-project boards use '' as key and re-fetch via their own effect)
        if (projectId) {
          get().loadTickets(projectId)
        }
      },

      // ── moveTicket (optimistic) ──────────────────────────────────
      moveTicket: async (
        ticketId: string,
        projectId: string,
        column: KanbanTicketColumn,
        sortOrder: number
      ) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        // Optimistic local update
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) =>
            t.id === ticketId ? { ...t, column, sort_order: sortOrder } : t
          )
          next.set(projectId, tickets)
          return { tickets: next }
        })

        // Clear "Go to review" indicator when ticket moves columns (optimistic)
        const movedTicket = prev.find((t) => t.id === ticketId)
        if (movedTicket?.worktree_id) {
          useWorktreeStatusStore.getState().clearCompletedReviewSession(movedTicket.worktree_id)
        }

        try {
          await kanban.ticket.move(projectId, ticketId, column, sortOrder)

          // When a ticket moves to done (or review, if that's the trigger), check if any dependents can be auto-launched
          const { useSettingsStore } = await import('./useSettingsStore')
          const { isBlockerSatisfied } = await import('../lib/blocker-utils')
          const triggerColumn = useSettingsStore.getState().followUpTriggerColumn
          if (
            column === 'done' ||
            (triggerColumn === 'review' && column === 'review' && movedTicket?.mode === 'build')
          ) {
            const { dependencyMap, tickets: allTickets } = get()
            const movedKey = ticketKey(projectId, ticketId)
            // Find tickets that list this ticket as a blocker
            for (const [depKey, blockers] of dependencyMap) {
              if (!blockers.has(movedKey)) continue
              // Check if ALL blockers of this dependent are now satisfied
              let allSatisfied = true
              for (const blockerKey of blockers) {
                const blockerRef = parseTicketKey(blockerKey)
                const blockerTicket = findTicketByRef(allTickets, blockerRef)
                if (blockerTicket && !isBlockerSatisfied(blockerTicket.column, blockerTicket.mode, triggerColumn)) {
                  allSatisfied = false
                  break
                }
              }
              if (allSatisfied) {
                const depTicket = findTicketByRef(allTickets, parseTicketKey(depKey))
                if (depTicket?.pending_launch_config) {
                  // Auto-launch the dependent using its own pending_launch_config
                  // (worktree `new`/`existing` exactly as it was queued).
                  import('../lib/auto-launch')
                    .then(({ autoLaunchTicket }) => {
                      autoLaunchTicket(depTicket).catch((err) => {
                        console.error('Auto-launch failed for ticket:', depTicket.id, err)
                      })
                    })
                    .catch(() => {})
                }
              }
            }
          }

          // Auto-approve Review: schedule the chain-aware auto-approve (commit, then
          // advance non-terminal tickets to Done) after a settle delay — but only for
          // build tickets that opted in via their own `auto_approve_review` flag.
          // Leaving Review for any other column cancels a pending approval, so the
          // transient "completed → working → completed" churn never fires mid-work.
          if (column === 'review' && movedTicket?.mode === 'build' && movedTicket.auto_approve_review) {
            const { kanbanAutoApproveDelaySeconds } = useSettingsStore.getState()
            scheduleAutoApprove(get, ticketId, projectId, (kanbanAutoApproveDelaySeconds ?? 10) * 1000)
          } else {
            cancelAutoApprove(ticketKey(projectId, ticketId))
          }
        } catch (err) {
          // Revert on failure
          set((state) => {
            const next = new Map(state.tickets)
            next.set(projectId, snapshot)
            return { tickets: next }
          })
          throw err
        }
      },

      // ── reorderTicket (optimistic) ───────────────────────────────
      reorderTicket: async (ticketId: string, projectId: string, newSortOrder: number) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        // Optimistic local update
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) =>
            t.id === ticketId ? { ...t, sort_order: newSortOrder } : t
          )
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await kanban.ticket.reorder(projectId, ticketId, newSortOrder)
        } catch (err) {
          // Revert on failure
          set((state) => {
            const next = new Map(state.tickets)
            next.set(projectId, snapshot)
            return { tickets: next }
          })
          throw err
        }
      },

      // ── moveTicketsToColumn (multi-select drag) ──────────────────
      // Append every ref to the end of `column`, one project at a time, in a
      // stable order (current column, then sort_order) so the dragged group keeps
      // its relative arrangement. Reuses moveTicket so per-ticket side effects
      // (auto-launch / auto-approve) still fire. Bypasses the single-drag modals
      // (worktree picker, merge-on-done) by design — N modals would be unusable.
      moveTicketsToColumn: async (refs: TicketRef[], column: KanbanTicketColumn) => {
        const resolved = refs
          .map((ref) => ({ ref, ticket: findTicketByRef(get().tickets, ref) }))
          .filter((entry): entry is { ref: TicketRef; ticket: KanbanTicket } => !!entry.ticket)
          .sort(
            (a, b) =>
              COLUMN_ORDER[a.ticket.column] - COLUMN_ORDER[b.ticket.column] ||
              a.ticket.sort_order - b.ticket.sort_order
          )

        for (const { ref } of resolved) {
          // Recompute against the latest state so each append lands after the
          // previous one (moveTicket updates state optimistically and synchronously).
          const rest = get()
            .getTicketsByColumn(ref.projectId, column)
            .filter((t) => t.id !== ref.ticketId)
          const sortOrder = get().computeSortOrder(rest, rest.length)
          await get().moveTicket(ref.ticketId, ref.projectId, column, sortOrder)
        }
      },

      // ── applyColumnSort (one-shot, optimistic) ───────────────────
      // Reorders the given column's displayed tickets once, by field/dir,
      // assigning fresh evenly-spaced sort_order across the GLOBAL ordered
      // list (so multi-project merges reproduce the interleave). No persistent
      // sort mode — drag still works afterwards. updated_at is preserved by the
      // no-bump reorderBatch backend path.
      applyColumnSort: async (tickets: KanbanTicket[], field: SortField, dir: SortDir) => {
        if (tickets.length === 0) return

        const ordered = sortTicketsBy(tickets, field, dir)
        const newOrder = new Map<string, number>()
        ordered.forEach((t, i) => newOrder.set(t.id, (i + 1) * SORT_STEP))

        // Snapshot every affected project for revert-on-failure.
        const affectedProjectIds = new Set(ordered.map((t) => t.project_id))
        const snapshots = new Map<string, KanbanTicket[]>()
        for (const pid of affectedProjectIds) {
          snapshots.set(
            pid,
            (get().tickets.get(pid) ?? []).map((t) => ({ ...t }))
          )
        }

        // Optimistic single set across all affected projects.
        set((state) => {
          const next = new Map(state.tickets)
          for (const pid of affectedProjectIds) {
            const updated = (next.get(pid) ?? []).map((t) =>
              newOrder.has(t.id) ? { ...t, sort_order: newOrder.get(t.id)! } : t
            )
            next.set(pid, updated)
          }
          return { tickets: next }
        })

        // Group updates by project_id; persist each project's batch in parallel.
        const updatesByProject = new Map<string, { id: string; sortOrder: number }[]>()
        for (const t of ordered) {
          const arr = updatesByProject.get(t.project_id) ?? []
          arr.push({ id: t.id, sortOrder: newOrder.get(t.id)! })
          updatesByProject.set(t.project_id, arr)
        }

        try {
          await Promise.all(
            [...updatesByProject.entries()].map(([pid, updates]) =>
              kanban.ticket.reorderBatch(pid, updates)
            )
          )
        } catch (err) {
          // Revert all affected projects on failure.
          set((state) => {
            const next = new Map(state.tickets)
            for (const [pid, snap] of snapshots) {
              next.set(pid, snap)
            }
            return { tickets: next }
          })
          throw err
        }
      },

      // ── toggleBoardView ──────────────────────────────────────────
      toggleBoardView: () => {
        set((state) => ({ isBoardViewActive: !state.isBoardViewActive }))
      },

      // ── setSimpleMode ────────────────────────────────────────────
      setSimpleMode: async (projectId: string, enabled: boolean) => {
        set((state) => ({
          simpleModeByProject: { ...state.simpleModeByProject, [projectId]: enabled }
        }))
        await kanban.simpleMode.toggle(projectId, enabled)
      },

      // ── syncTicketWithSession (called via store-coordination) ────
      syncTicketWithSession: (sessionId: string, event: KanbanSessionEvent) => {
        // Find all tickets across all projects referencing this session
        const allTickets = get().tickets
        for (const [projectId, tickets] of allTickets.entries()) {
          for (const ticket of tickets) {
            if (ticket.current_session_id !== sessionId) continue

            // 'done' is a terminal column: once a user marks a ticket done, no
            // session event may auto-move it back. This matters on app
            // relaunch/focus, when a still-active session re-emits its status
            // (e.g. an `idle` replay → session_completed) for a done ticket.
            // Each column-moving branch below guards on `column !== 'done'`.
            switch (event.type) {
              case 'session_completed': {
                if (
                  ticket.mode === 'build' &&
                  ticket.column !== 'review' &&
                  ticket.column !== 'done'
                ) {
                  // Auto-advance build ticket to review column (idempotent — skip if already there)
                  get()
                    .moveTicket(ticket.id, projectId, 'review', ticket.sort_order)
                    .catch(() => {})
                } else if (isPlanLike(ticket.mode) && !ticket.plan_ready) {
                  // Plan finished — set plan_ready and move to review for user attention
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: true })
                    .catch(() => {})
                  if (ticket.column !== 'review' && ticket.column !== 'done') {
                    get()
                      .moveTicket(ticket.id, projectId, 'review', ticket.sort_order)
                      .catch(() => {})
                  }
                }
                // Accumulate token delta to ticket's persistent total
                if (event.tokenDelta && event.tokenDelta > 0) {
                  kanban.ticket
                    .addTokens<KanbanTicket | null>(projectId, ticket.id, event.tokenDelta)
                    .then((updated) => {
                      if (updated) {
                        set((state) => {
                          const next = new Map(state.tickets)
                          const tickets = (next.get(projectId) ?? []).map((t) =>
                            t.id === ticket.id ? { ...t, total_tokens: updated.total_tokens } : t
                          )
                          next.set(projectId, tickets)
                          return { tickets: next }
                        })
                      }
                    })
                    .catch(() => {})
                }
                break
              }

              case 'plan_ready': {
                // Explicit plan.ready event — set flag and move to review
                if (isPlanLike(ticket.mode) && !ticket.plan_ready) {
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: true })
                    .catch(() => {})
                  if (ticket.column !== 'review' && ticket.column !== 'done') {
                    get()
                      .moveTicket(ticket.id, projectId, 'review', ticket.sort_order)
                      .catch(() => {})
                  }
                }
                break
              }

              case 'plan_followup': {
                // User rejected or revised a ready plan in the Claude CLI terminal.
                // The session is planning again, so clear review state and return
                // the ticket to active work.
                if (ticket.plan_ready) {
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: false })
                    .catch(() => {})
                }
                if (ticket.column !== 'in_progress' && ticket.column !== 'done') {
                  get()
                    .moveTicket(ticket.id, projectId, 'in_progress', ticket.sort_order)
                    .catch(() => {})
                }
                break
              }

              case 'supercharge': {
                // Supercharge creates a new session — re-attach ticket and reset plan_ready
                // Idempotent: skip if already pointing at the new session
                if (event.newSessionId && ticket.current_session_id !== event.newSessionId) {
                  get()
                    .updateTicket(ticket.id, projectId, {
                      current_session_id: event.newSessionId,
                      plan_ready: false,
                      mode: 'build'
                    })
                    .catch(() => {})
                }
                break
              }

              case 'mode_change': {
                // Mode toggled outside the Kanban board — sync ticket mode + plan_ready
                const targetMode = event.sessionMode ?? null
                const targetPlanReady = targetMode === 'build' ? false : ticket.plan_ready
                if (ticket.mode !== targetMode || ticket.plan_ready !== targetPlanReady) {
                  get()
                    .updateTicket(ticket.id, projectId, {
                      mode: targetMode,
                      plan_ready: targetPlanReady
                    })
                    .catch(() => {})
                }
                break
              }

              case 'implement': {
                // Plan approved from session view — clear plan_ready, set mode to build
                if (ticket.plan_ready || ticket.mode !== 'build') {
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: false, mode: 'build' })
                    .catch(() => {})
                }
                break
              }

              case 'session_error': {
                // Error requires user attention — move to review if currently in_progress
                if (ticket.column === 'in_progress') {
                  get()
                    .moveTicket(ticket.id, projectId, 'review', ticket.sort_order)
                    .catch(() => {})
                }
                break
              }

              case 'session_working': {
                // Session became active — move ticket to in_progress if it's in
                // todo (pre-assigned, first activity) or review (returning to work).
                if (ticket.plan_ready) {
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: false })
                    .catch(() => {})
                }
                if (ticket.column === 'todo' || ticket.column === 'review') {
                  get()
                    .moveTicket(ticket.id, projectId, 'in_progress', ticket.sort_order)
                    .catch(() => {})
                }
                break
              }
            }
          }
        }
      },

      relinkTicketsForHandoff: async (
        oldSessionId: string,
        newSessionId: string,
        goalMode?: boolean
      ) => {
        const linkedTickets = await kanban.ticket.getBySession<KanbanTicket>(oldSessionId)
        if (!linkedTickets || linkedTickets.length === 0) return

        const nextGoalMode = goalMode === true
        const relinkedByKey = new Map<TicketKey, KanbanTicket>()

        for (const ticket of linkedTickets) {
          const nextGoalSuccessCriteria = nextGoalMode
            ? (ticket.goal_success_criteria ?? null)
            : null
          const alreadyRelinked =
            ticket.current_session_id === newSessionId &&
            ticket.plan_ready === false &&
            ticket.mode === 'build' &&
            ticket.goal_mode === nextGoalMode &&
            ticket.goal_success_criteria === nextGoalSuccessCriteria

          if (!alreadyRelinked) {
            await kanban.ticket.update(ticket.project_id, ticket.id, {
              current_session_id: newSessionId,
              plan_ready: false,
              mode: 'build',
              goal_mode: nextGoalMode,
              goal_success_criteria: nextGoalSuccessCriteria
            })
          }

          relinkedByKey.set(ticketKey(ticket.project_id, ticket.id), {
            ...ticket,
            current_session_id: newSessionId,
            plan_ready: false,
            mode: 'build',
            goal_mode: nextGoalMode,
            goal_success_criteria: nextGoalSuccessCriteria
          })
        }

        set((state) => {
          const next = new Map(state.tickets)
          let changed = false
          let boardTelegramTarget = state.boardTelegramTarget

          for (const [projectId, projectTickets] of next.entries()) {
            let projectChanged = false
            const updatedTickets = projectTickets.map((ticket) => {
              const relinked = relinkedByKey.get(ticketKey(projectId, ticket.id))
              if (!relinked) return ticket
              projectChanged = true
              if (boardTelegramTarget?.projectId === projectId && boardTelegramTarget.ticketId === ticket.id) {
                boardTelegramTarget = {
                  ...boardTelegramTarget,
                  sessionId: newSessionId,
                  worktreeId: relinked.worktree_id ?? boardTelegramTarget.worktreeId
                }
              }
              return {
                ...ticket,
                current_session_id: relinked.current_session_id,
                plan_ready: relinked.plan_ready,
                mode: relinked.mode,
                goal_mode: relinked.goal_mode,
                goal_success_criteria: relinked.goal_success_criteria
              }
            })

            if (projectChanged) {
              changed = true
              next.set(projectId, updatedTickets)
            }
          }

          return changed ? { tickets: next, boardTelegramTarget } : { boardTelegramTarget }
        })
      },

      // ── Merge-on-done state ──────────────────────────────────────────
      setPendingDoneMove: (data) => {
        set({ pendingDoneMove: data })
      },

      clearPendingDoneMove: () => {
        set({ pendingDoneMove: null })
      },

      completeDoneMove: async () => {
        const pending = get().pendingDoneMove
        if (!pending) return
        set({ pendingDoneMove: null })
        await get().moveTicket(pending.ticketId, pending.projectId, 'done', pending.sortOrder)
      },

      // ── getTicketsForProject ─────────────────────────────────────
      getTicketsForProject: (projectId: string): KanbanTicket[] => {
        const tickets = get().tickets.get(projectId) ?? []
        return [...tickets].sort((a, b) => {
          const colDiff = COLUMN_ORDER[a.column] - COLUMN_ORDER[b.column]
          if (colDiff !== 0) return colDiff
          return a.sort_order - b.sort_order
        })
      },

      // ── getTicketsByColumn ───────────────────────────────────────
      getTicketsByColumn: (projectId: string, column: KanbanTicketColumn): KanbanTicket[] => {
        const tickets = get().tickets.get(projectId) ?? []
        return tickets
          .filter((t) => t.column === column && !t.archived_at)
          .sort((a, b) => a.sort_order - b.sort_order)
      },

      // ── getArchivedTicketsByColumn ─────────────────────────────────
      getArchivedTicketsByColumn: (
        projectId: string,
        column: KanbanTicketColumn
      ): KanbanTicket[] => {
        const tickets = get().tickets.get(projectId) ?? []
        return tickets
          .filter((t) => t.column === column && t.archived_at)
          .sort((a, b) => (b.archived_at ?? '').localeCompare(a.archived_at ?? ''))
      },

      getDiagnosticsForTicket: (projectId: string, ticketId: string): MarkdownCardDiagnostic[] => {
        return (get().markdownDiagnostics.get(projectId) ?? []).filter(
          (diagnostic) => diagnostic.ticketId === ticketId
        )
      },

      getInvalidPlaceholdersForProject: (projectId: string): MarkdownCardPlaceholder[] => {
        return get().markdownPlaceholders.get(projectId) ?? []
      },

      // ── getConnectionProjectIds ─────────────────────────────────
      getConnectionProjectIds: (connectionId: string): string[] => {
        const connection = useConnectionStore
          .getState()
          .connections.find((c) => c.id === connectionId)
        if (!connection) return []
        return [...new Set(connection.members.map((m) => m.project_id))]
      },

      // ── loadTicketsForConnection ────────────────────────────────
      loadTicketsForConnection: async (connectionId: string) => {
        let projectIds = get().getConnectionProjectIds(connectionId)
        if (projectIds.length === 0) {
          const connStore = useConnectionStore.getState()
          if (!connStore.loaded) {
            await connStore.loadConnections()
            projectIds = get().getConnectionProjectIds(connectionId)
          }
          if (projectIds.length === 0) return
        }

        set({ isLoading: true })
        try {
          const includeArchived = (pid: string) =>
            get().showArchivedByProject[pid] ?? get().showArchivedByProject[''] ?? false
          const results = await Promise.all(
            projectIds.map(async (pid) => ({
              projectId: pid,
              tickets: await kanban.ticket.getByProject<KanbanTicket>(pid, includeArchived(pid))
            }))
          )
          const diagnosticsByProject = await Promise.all(
            results.map(async (result) => ({
              projectId: result.projectId,
              diagnostics: await kanban.diagnostics
                .get<MarkdownCardDiagnostic>(result.projectId)
                .catch(() => [])
            }))
          )
          const diagnosticsMap = new Map(diagnosticsByProject.map((result) => [result.projectId, result.diagnostics]))

          // Batch update all projects at once
          set((state) => {
            const newTickets = new Map(state.tickets)
            const newDiagnostics = new Map(state.markdownDiagnostics)
            const newPlaceholders = new Map(state.markdownPlaceholders)
            results.forEach((result) => {
              const diagnostics = diagnosticsMap.get(result.projectId) ?? []
              newTickets.set(result.projectId, result.tickets)
              newDiagnostics.set(result.projectId, diagnostics)
              newPlaceholders.set(
                result.projectId,
                placeholdersFromDiagnostics(result.projectId, diagnostics, result.tickets)
              )
            })
            return {
              tickets: newTickets,
              markdownDiagnostics: newDiagnostics,
              markdownPlaceholders: newPlaceholders
            }
          })
          // Load dependencies for each project
          for (const pid of projectIds) {
            get().loadDependencies(pid)
          }
        } catch (error) {
          console.error('Failed to load tickets for connection:', error)
        } finally {
          set({ isLoading: false })
        }
      },

      // ── getTicketsByColumnForConnection ─────────────────────────
      getTicketsByColumnForConnection: (
        connectionId: string,
        column: KanbanTicketColumn
      ): KanbanTicket[] => {
        const projectIds = get().getConnectionProjectIds(connectionId)
        const merged = projectIds.flatMap((pid) => get().getTicketsByColumn(pid, column))
        merged.sort((a, b) => a.sort_order - b.sort_order)
        return merged
      },

      getInvalidPlaceholdersForConnection: (connectionId: string): MarkdownCardPlaceholder[] => {
        const projectIds = get().getConnectionProjectIds(connectionId)
        return projectIds.flatMap((pid) => get().getInvalidPlaceholdersForProject(pid))
      },

      // ── togglePinnedBoard ────────────────────────────────────────
      togglePinnedBoard: () => {
        set((state) => ({ isPinnedBoardActive: !state.isPinnedBoardActive }))
      },

      // ── loadTicketsForPinnedProjects ─────────────────────────────
      loadTicketsForPinnedProjects: async () => {
        let projectIds = [...usePinnedStore.getState().pinnedProjectIds]
        if (projectIds.length === 0) {
          const pinnedStore = usePinnedStore.getState()
          if (!pinnedStore.loaded) {
            await pinnedStore.loadPinned()
            projectIds = [...usePinnedStore.getState().pinnedProjectIds]
          }
          if (projectIds.length === 0) return
        }

        set({ isLoading: true })
        try {
          const includeArchived = (pid: string) =>
            get().showArchivedByProject[pid] ?? get().showArchivedByProject[''] ?? false
          const results = await Promise.all(
            projectIds.map(async (pid) => ({
              projectId: pid,
              tickets: await kanban.ticket.getByProject<KanbanTicket>(pid, includeArchived(pid))
            }))
          )
          const diagnosticsByProject = await Promise.all(
            results.map(async (result) => ({
              projectId: result.projectId,
              diagnostics: await kanban.diagnostics
                .get<MarkdownCardDiagnostic>(result.projectId)
                .catch(() => [])
            }))
          )
          const diagnosticsMap = new Map(diagnosticsByProject.map((result) => [result.projectId, result.diagnostics]))

          // Batch update all projects at once
          set((state) => {
            const newTickets = new Map(state.tickets)
            const newDiagnostics = new Map(state.markdownDiagnostics)
            const newPlaceholders = new Map(state.markdownPlaceholders)
            results.forEach((result) => {
              const diagnostics = diagnosticsMap.get(result.projectId) ?? []
              newTickets.set(result.projectId, result.tickets)
              newDiagnostics.set(result.projectId, diagnostics)
              newPlaceholders.set(
                result.projectId,
                placeholdersFromDiagnostics(result.projectId, diagnostics, result.tickets)
              )
            })
            return {
              tickets: newTickets,
              markdownDiagnostics: newDiagnostics,
              markdownPlaceholders: newPlaceholders
            }
          })
          // Load dependencies for each project
          for (const pid of projectIds) {
            get().loadDependencies(pid)
          }
        } catch (error) {
          console.error('Failed to load tickets for pinned projects:', error)
        } finally {
          set({ isLoading: false })
        }
      },

      // ── getTicketsByColumnForPinned ──────────────────────────────
      getTicketsByColumnForPinned: (column: KanbanTicketColumn): KanbanTicket[] => {
        const projectIds = [...usePinnedStore.getState().pinnedProjectIds]
        const merged = projectIds.flatMap((pid) => get().getTicketsByColumn(pid, column))
        merged.sort((a, b) => a.sort_order - b.sort_order)
        return merged
      },

      getInvalidPlaceholdersForPinned: (): MarkdownCardPlaceholder[] => {
        const projectIds = [...usePinnedStore.getState().pinnedProjectIds]
        return projectIds.flatMap((pid) => get().getInvalidPlaceholdersForProject(pid))
      },

      // ── getPinnedProjectIdsArray ─────────────────────────────────
      getPinnedProjectIdsArray: (): string[] => {
        return [...usePinnedStore.getState().pinnedProjectIds].sort()
      },

      // ── syncPRToTicket ───────────────────────────────────────────
      syncPRToTicket: (worktreeId: string, prNumber: number, prUrl: string) => {
        set((state) => {
          const newTickets = new Map(state.tickets)
          let anyChanged = false
          for (const [projectId, projectTickets] of newTickets) {
            let projectChanged = false
            const updated = projectTickets.map((t) => {
              if (t.worktree_id === worktreeId) {
                projectChanged = true
                return { ...t, github_pr_number: prNumber, github_pr_url: prUrl }
              }
              return t
            })
            if (projectChanged) {
              anyChanged = true
              newTickets.set(projectId, updated)
            }
          }
          return anyChanged ? { tickets: newTickets } : {}
        })
      },

      // ── clearPRFromTicket ──────────────────────────────────────────
      clearPRFromTicket: (worktreeId: string) => {
        set((state) => {
          const newTickets = new Map(state.tickets)
          let anyChanged = false
          for (const [projectId, projectTickets] of newTickets) {
            let projectChanged = false
            const updated = projectTickets.map((t) => {
              if (t.worktree_id === worktreeId) {
                projectChanged = true
                return { ...t, github_pr_number: null, github_pr_url: null }
              }
              return t
            })
            if (projectChanged) {
              anyChanged = true
              newTickets.set(projectId, updated)
            }
          }
          return anyChanged ? { tickets: newTickets } : {}
        })
      },

      // ── attachPRToTicket ──────────────────────────────────────────
      attachPRToTicket: (ticketId: string, projectId: string, prNumber: number, prUrl: string) => {
        set((state) => {
          const projectTickets = state.tickets.get(projectId)
          if (!projectTickets) return {}
          const updated = projectTickets.map((t) =>
            t.id === ticketId ? { ...t, github_pr_number: prNumber, github_pr_url: prUrl } : t
          )
          const newTickets = new Map(state.tickets)
          newTickets.set(projectId, updated)
          return { tickets: newTickets }
        })
      },

      // ── detachPRFromTicket ──────────────────────────────────────────
      detachPRFromTicket: (ticketId: string, projectId: string) => {
        set((state) => {
          const projectTickets = state.tickets.get(projectId)
          if (!projectTickets) return {}
          const updated = projectTickets.map((t) =>
            t.id === ticketId ? { ...t, github_pr_number: null, github_pr_url: null } : t
          )
          const newTickets = new Map(state.tickets)
          newTickets.set(projectId, updated)
          return { tickets: newTickets }
        })
      },

      // ── computeSortOrder ─────────────────────────────────────────
      computeSortOrder: (tickets: KanbanTicket[], targetIndex: number): number => {
        if (tickets.length === 0) return 0

        // Insert at beginning
        if (targetIndex <= 0) {
          return tickets[0].sort_order - 1
        }

        // Insert at end
        if (targetIndex >= tickets.length) {
          return tickets[tickets.length - 1].sort_order + 1
        }

        // Insert between
        const before = tickets[targetIndex - 1]
        const after = tickets[targetIndex]
        return (before.sort_order + after.sort_order) / 2
      },

      // ── loadDependencies ────────────────────────────────────────────
      loadDependencies: async (projectId: string) => {
        try {
          const deps = await kanban.dependency.getForProject<TicketDependency>(projectId)
          set((state) => {
            const newMap = new Map(state.dependencyMap)
            for (const [depKey] of newMap) {
              if (parseTicketKey(depKey).projectId === projectId) newMap.delete(depKey)
            }
            // Populate from fetched data
            for (const dep of deps) {
              const dependentKey = ticketKey(projectId, dep.dependent_id)
              const blockerKey = ticketKey(projectId, dep.blocker_id)
              const existing = newMap.get(dependentKey) ?? new Set<TicketKey>()
              existing.add(blockerKey)
              newMap.set(dependentKey, existing)
            }
            return { dependencyMap: newMap }
          })
        } catch (err) {
          console.error('Failed to load dependencies:', err)
        }
      },

      // ── addDependency ───────────────────────────────────────────────
      addDependency: async (dependent: TicketRef, blocker: TicketRef) => {
        if (dependent.projectId !== blocker.projectId) {
          return { success: false, error: 'Dependencies can only be created within the same project' }
        }
        const result = await kanban.dependency.add(
          dependent.projectId,
          dependent.ticketId,
          blocker.ticketId
        )
        if (result.success) {
          set((state) => {
            const newMap = new Map(state.dependencyMap)
            const dependentKey = ticketRefKey(dependent)
            const existing = newMap.get(dependentKey) ?? new Set<TicketKey>()
            const newSet = new Set(existing)
            newSet.add(ticketRefKey(blocker))
            newMap.set(dependentKey, newSet)
            return { dependencyMap: newMap }
          })
        }
        return result
      },

      // ── removeDependency ────────────────────────────────────────────
      removeDependency: async (dependent: TicketRef, blocker: TicketRef) => {
        if (dependent.projectId !== blocker.projectId) return
        await kanban.dependency.remove(dependent.projectId, dependent.ticketId, blocker.ticketId)
        set((state) => {
          const newMap = new Map(state.dependencyMap)
          const dependentKey = ticketRefKey(dependent)
          const existing = newMap.get(dependentKey)
          if (existing) {
            const newSet = new Set(existing)
            newSet.delete(ticketRefKey(blocker))
            if (newSet.size === 0) {
              newMap.delete(dependentKey)
            } else {
              newMap.set(dependentKey, newSet)
            }
          }
          return { dependencyMap: newMap }
        })
      },

      // ── enterDependencyMode ─────────────────────────────────────────
      enterDependencyMode: (sourceTicketId: string, sourceProjectId?: string) => {
        set({ dependencyMode: { active: true, sourceTicketId, sourceProjectId: sourceProjectId ?? null } })
      },

      // ── exitDependencyMode ──────────────────────────────────────────
      exitDependencyMode: () => {
        set({ dependencyMode: null })
      },

      // ── setHoveredBlockedTicketRef ──────────────────────────────────
      setHoveredBlockedTicketRef: (ref: TicketRef | null) => {
        set({ hoveredBlockedTicketKey: ref ? ticketRefKey(ref) : null })
      }
    }),
    {
      name: 'hive-kanban',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        isBoardViewActive: state.isBoardViewActive,
        isPinnedBoardActive: state.isPinnedBoardActive,
        simpleModeByProject: state.simpleModeByProject
      })
    }
  )
)

// ── Register coordination callback after store creation ──────────────
registerKanbanSessionSync((sessionId, event) => {
  useKanbanStore.getState().syncTicketWithSession(sessionId, event)
})

// ── Register new-session callback: auto-attach pre-assigned tickets ──
registerKanbanNewSession((sessionId, worktreeId, projectId, sessionMode) => {
  const store = useKanbanStore.getState()
  const tickets = store.tickets.get(projectId) ?? []

  // Find the first ticket pre-assigned to this worktree with no active session
  const orphan = tickets.find(
    (t) => t.worktree_id === worktreeId && !t.current_session_id && !t.archived_at
  )
  if (!orphan) return

  // Auto-attach: link session and move to in_progress.
  // Setting `mode` is critical — the progress bar only renders when
  // ticket.mode is truthy, and session_completed only advances tickets
  // whose mode matches 'build' or a plan-like mode.
  const sortOrder = store.computeSortOrder(store.getTicketsByColumn(projectId, 'in_progress'), 0)
  store.updateTicket(orphan.id, projectId, {
    current_session_id: sessionId,
    column: 'in_progress',
    sort_order: sortOrder,
    mode: sessionMode as 'build' | 'plan',
    plan_ready: false
  })
  if (store.isBoardViewActive || store.isPinnedBoardActive) {
    store.setBoardTelegramTarget({
      ticketId: orphan.id,
      projectId,
      worktreeId,
      sessionId
    })
  }
})

// ── Register auto-create-ticket callback (first message of a session) ──
// Creates a kanban ticket in the session's project on the first user message,
// when the "automatically create ticket" setting is on. Idempotent: skips if a
// ticket is already linked to the session (e.g. auto-attach above already ran).
registerKanbanAutoCreateTicket(({ sessionId, rawPrompt }) => {
  void (async () => {
    try {
      const [{ useSettingsStore }, { useSessionStore }] = await Promise.all([
        import('./useSettingsStore'),
        import('./useSessionStore')
      ])
      if (!useSettingsStore.getState().automaticallyCreateTicket) return

      const session = useSessionStore.getState().getSessionById(sessionId)
      if (!session) return
      // Raw terminals and the board assistant have no real "prompt" to capture.
      if (session.session_type === 'board-assistant' || session.agent_sdk === 'terminal') return

      // Idempotency gate (authoritative — immune to the auto-attach timing and a
      // stale in-memory tickets map): skip if any non-archived ticket is linked.
      const existing = await kanban.ticket.getBySession<KanbanTicket>(sessionId)
      if (existing.some((t) => !t.archived_at)) return

      const trimmed = rawPrompt.trim()
      const hasText = trimmed.length > 0
      const title = hasText ? trimmed.split(/\s+/).slice(0, 10).join(' ') : 'Untitled session'

      const store = useKanbanStore.getState()
      const sortOrder = store.computeSortOrder(
        store.getTicketsByColumn(session.project_id, 'in_progress'),
        0
      )
      await store.createTicket(session.project_id, {
        project_id: session.project_id,
        title,
        description: hasText ? rawPrompt : null,
        column: 'in_progress',
        sort_order: sortOrder,
        current_session_id: sessionId,
        worktree_id: session.worktree_id,
        mode: session.mode,
        created_from_session: true
      })

      // Mirror the manual-open behavior: when auto-pin is enabled, pin the
      // project's root/base worktree so the auto-created ticket shows on the
      // pinned board. No-op unless `autoPinBaseWorktreeOnBoardPrompt` is on.
      const { autoPinBaseWorktree } = await import('@/lib/auto-pin')
      void autoPinBaseWorktree(session.project_id)
    } catch {
      // Best-effort — never disrupt the user's send/prompt flow.
    }
  })()
})

// ── Register rename-sync callback (session renamed → ticket title) ────
// Keeps an auto-created ticket's title in sync with its session's name, for
// both manual renames and LLM auto-titles. Gated on the setting so disabling it
// freezes existing auto-created tickets too. Only touches created_from_session
// tickets, so a session started FROM a hand-written ticket is never clobbered.
registerKanbanRenameSync((sessionId, name) => {
  void (async () => {
    try {
      const { useSettingsStore } = await import('./useSettingsStore')
      if (!useSettingsStore.getState().automaticallyCreateTicket) return
      if (/^Session \d+$/.test(name.trim())) return // never sync a placeholder over a real title

      const store = useKanbanStore.getState()
      for (const [projectId, tickets] of store.tickets.entries()) {
        for (const ticket of tickets) {
          if (
            ticket.current_session_id === sessionId &&
            ticket.created_from_session &&
            !ticket.archived_at
          ) {
            if (ticket.title !== name) {
              store.updateTicket(ticket.id, projectId, { title: name }).catch(() => {})
            }
            return
          }
        }
      }

      // Fallback: the ticket's board may not be loaded into the map yet.
      const linked = await kanban.ticket.getBySession<KanbanTicket>(sessionId)
      const target = linked.find((t) => t.created_from_session && !t.archived_at)
      if (target && target.title !== name) {
        store.updateTicket(target.id, target.project_id, { title: name }).catch(() => {})
      }
    } catch {
      // Best-effort.
    }
  })()
})
