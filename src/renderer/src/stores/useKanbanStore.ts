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
import { isSessionOwnedByAnotherTicket } from '@/lib/session-ownership'
import type {
  CompletionCheckProvider,
  SessionFingerprint,
  StoredCompletionVerdict,
  VerifyProgress
} from '@shared/types/completion'
import { sortTicketsBy, SORT_STEP, type SortField, type SortDir } from '../lib/kanban-sort'
import { useConnectionStore } from './useConnectionStore'
import { usePinnedStore } from './usePinnedStore'
import { useWorktreeStatusStore } from './useWorktreeStatusStore'
import { kanbanApi as kanban } from '@/api/kanban-api'
import { toast } from '@/lib/toast'

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

/**
 * A file/image attached to a queued prompt. Stored path-only — pasted/dropped
 * images are materialized to disk on add — so the persisted queue stays small
 * (no base64 in localStorage) and the dispatcher can hand the CLI a filesystem
 * path it can read. `id` is a stable client id for the preview tray's remove.
 */
export interface QueuedAttachment {
  id: string
  name: string
  mime: string
  filePath: string
}

/**
 * One pending follow-up in a ticket's Queue prompts queue (claude-code-cli).
 * `id` is a stable client id for CRUD/reorder + React keys.
 */
export interface QueuedPrompt {
  id: string
  content: string
  /** Files/images delivered alongside this prompt when it's dispatched. */
  attachments?: QueuedAttachment[]
}

/**
 * Compose the text delivered to the CLI for a queued prompt. Attachments are
 * prepended as an `<attached_files>` block of file paths — the same convention
 * the SDK followup path emits via `buildMessageParts` — so the agent reads them
 * before the prompt body. With no attachments the raw content is returned
 * unchanged, so the dispatched text matches exactly what the user typed.
 */
export function buildQueuedPromptText(content: string, attachments?: QueuedAttachment[]): string {
  if (!attachments || attachments.length === 0) return content
  const xml =
    '<attached_files>\n' +
    attachments.map((a) => `<file path="${a.filePath}">${a.name}</file>`).join('\n') +
    '\n</attached_files>'
  return content ? `${xml}\n${content}` : xml
}

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

async function loadProjectTicketsSnapshot(
  projectId: string,
  includeArchived: boolean
): Promise<{ tickets: KanbanTicket[]; diagnostics: MarkdownCardDiagnostic[] }> {
  const tickets = await kanban.ticket.getByProject<KanbanTicket>(projectId, includeArchived)
  const diagnostics = await kanban.diagnostics
    .get<MarkdownCardDiagnostic>(projectId)
    .catch(() => [])
  return { tickets, diagnostics }
}

// ── Paginated board load (fast first page + background streaming) ───────────
/** Tickets fetched per column per page in the paginated board load. */
const TICKETS_PER_PAGE = 20

/** Columns streamed, in display order, by the paginated load. */
const STREAM_COLUMNS: KanbanTicketColumn[] = ['todo', 'in_progress', 'review', 'done']

type ColumnPagesResult = Record<string, { tickets: KanbanTicket[]; total: number }>

/**
 * Per-project load generation. `loadTickets` bumps it at the start of every
 * (non-archived) load; in-flight background streams compare against it and bail
 * the moment a newer load (reload / project switch) supersedes them.
 */
const loadGeneration = new Map<string, number>()

/**
 * Per-project set of ticket IDs removed locally (delete / move-to-project) since
 * the current load began. A streamed page must not resurrect a ticket the user
 * already removed, so merges skip any ID in this set.
 */
const removedTicketIds = new Map<string, Set<string>>()

/** Start a fresh load generation for a project and reset its removed-id guard. */
function beginLoadGeneration(projectId: string): number {
  const next = (loadGeneration.get(projectId) ?? 0) + 1
  loadGeneration.set(projectId, next)
  removedTicketIds.set(projectId, new Set())
  return next
}

/** True while `generation` is still the active load for `projectId`. */
function isCurrentLoad(projectId: string, generation: number): boolean {
  return loadGeneration.get(projectId) === generation
}

/** Record a locally-removed ticket so background pages can't resurrect it. */
function trackRemovedTicket(projectId: string, ticketId: string): void {
  let ids = removedTicketIds.get(projectId)
  if (!ids) {
    ids = new Set()
    removedTicketIds.set(projectId, ids)
  }
  ids.add(ticketId)
}

/** Concatenate every column's first page into one tickets array (display order). */
function flattenColumnPages(pages: ColumnPagesResult): KanbanTicket[] {
  const out: KanbanTicket[] = []
  for (const column of STREAM_COLUMNS) {
    const page = pages[column]
    if (page) out.push(...page.tickets)
  }
  return out
}

/**
 * Merge a streamed page into a project's tickets, skipping IDs already present or
 * removed locally. No-op (and no re-render) when the load was superseded or the
 * page adds nothing.
 */
function mergeStreamedPage(
  projectId: string,
  generation: number,
  batch: KanbanTicket[]
): void {
  useKanbanStore.setState((state) => {
    if (!isCurrentLoad(projectId, generation)) return {}
    const existing = state.tickets.get(projectId) ?? []
    const existingIds = new Set(existing.map((t) => t.id))
    const removed = removedTicketIds.get(projectId)
    const additions = batch.filter((t) => !existingIds.has(t.id) && !removed?.has(t.id))
    if (additions.length === 0) return {}
    const merged = [...existing, ...additions]
    const next = new Map(state.tickets)
    next.set(projectId, merged)
    const diagnostics = state.markdownDiagnostics.get(projectId) ?? []
    const nextPlaceholders = new Map(state.markdownPlaceholders)
    nextPlaceholders.set(projectId, placeholdersFromDiagnostics(projectId, diagnostics, merged))
    return { tickets: next, markdownPlaceholders: nextPlaceholders }
  })
}

/**
 * Background phase of the paginated load: page through every column that has more
 * tickets than the first page, merging each batch into the store. Columns run in
 * parallel; offsets within a column run sequentially. Bails as soon as the load
 * is superseded.
 */
async function streamRemainingTickets(
  projectId: string,
  generation: number,
  pages: ColumnPagesResult
): Promise<void> {
  await Promise.all(
    STREAM_COLUMNS.map(async (column) => {
      const page = pages[column]
      if (!page || page.total <= TICKETS_PER_PAGE) return
      let offset = TICKETS_PER_PAGE
      while (offset < page.total) {
        if (!isCurrentLoad(projectId, generation)) return
        let batch: KanbanTicket[]
        try {
          batch = await kanban.ticket.getColumnPage<KanbanTicket>(
            projectId,
            column,
            TICKETS_PER_PAGE,
            offset
          )
        } catch {
          return
        }
        if (!isCurrentLoad(projectId, generation) || batch.length === 0) return
        mergeStreamedPage(projectId, generation, batch)
        offset += TICKETS_PER_PAGE
        if (batch.length < TICKETS_PER_PAGE) return
      }
    })
  )
}

// ── State interface ────────────────────────────────────────────────────
/** Options for `moveTicket`. */
export interface MoveTicketOptions {
  /**
   * True when the move was triggered directly by the user (e.g. a drag-and-drop),
   * as opposed to an automatic system move (Stop-hook promotion, `session_completed`
   * replay, rescue re-promote). A user-initiated move into Review busts any cached
   * completion verdict for the ticket's session so Strict Verify re-judges fresh —
   * the deliberate "judge it again" the reuse guard would otherwise swallow.
   */
  userInitiated?: boolean
}

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
  loadTicketsWithArchiveVisibility: (projectId: string, includeArchived: boolean) => Promise<void>
  createTicket: (projectId: string, data: KanbanTicketCreate) => Promise<KanbanTicket>
  convertMarkdownPlaceholder: (projectId: string, filePath: string) => Promise<KanbanTicket>
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
    sortOrder: number,
    opts?: MoveTicketOptions
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

  // ── AI completion verdicts (transient, not persisted) ──────────────
  /** Latest AI "is this really complete?" verdict per ticket, keyed by ticketKey. */
  completionVerdicts: Map<TicketKey, StoredCompletionVerdict>
  setCompletionVerdict: (key: TicketKey, verdict: StoredCompletionVerdict) => void
  clearCompletionVerdict: (key: TicketKey) => void
  /**
   * Live progress of the Strict Verify / Auto Review Bypass pipeline per ticket,
   * keyed by ticketKey. Drives the countdown + status badge on the Kanban card.
   * Transient (not persisted); a `null` value clears it.
   */
  verifyProgress: Map<TicketKey, VerifyProgress>
  setVerifyProgress: (key: TicketKey, progress: VerifyProgress | null) => void
  /**
   * Run the AI completion check for a ticket on demand (manual "Verify
   * completion" action). Stores the verdict and, if the verdict is incomplete,
   * moves the ticket back to In Progress — same as the automatic settle path.
   */
  recheckTicketCompletion: (
    ticketId: string,
    projectId: string
  ) => Promise<StoredCompletionVerdict | null>
  /**
   * Queue prompts (claude-code-cli only). Immediately enter `prompt` into the
   * ticket's CLI session and move it to In Progress — the "send now" path used
   * for the first prompt when the session is idle and nothing is queued.
   */
  startClaudeCliFollowup: (
    projectId: string,
    ticketId: string,
    prompt: string,
    attachments?: QueuedAttachment[]
  ) => Promise<boolean>
  /**
   * Queue prompts (claude-code-cli only). Enter the next queued follow-up IFF
   * the feature is active, the ticket is a verified-complete build ticket idle
   * in Review, and its CLI session is idle. No-op (returns false) otherwise —
   * the queue then waits for the next Strict Verify pass to drain it.
   */
  dispatchClaudeCliQueueIfReady: (projectId: string, ticketId: string) => Promise<boolean>
  /**
   * Queue prompts (claude-code-cli). Ordered pending follow-ups per ticket, keyed
   * by ticketKey so the queue exists before a session does (Todo) and survives a
   * reload (persisted). Drained one-at-a-time once Strict Verify marks the ticket
   * complete in Review. CRUD actions back the queue management UI.
   */
  promptQueues: Record<TicketKey, QueuedPrompt[]>
  /**
   * Append `content` (+ optional attachments) to the ticket's queue. Trimmed;
   * no-op only when both the text and attachments are empty.
   */
  addQueuedPrompt: (
    projectId: string,
    ticketId: string,
    content: string,
    attachments?: QueuedAttachment[]
  ) => void
  /**
   * Replace the text of one queued prompt (trimmed). When `attachments` is
   * omitted the prompt's existing attachments are kept. Removes the prompt only
   * when it would end up with neither text nor attachments.
   */
  updateQueuedPrompt: (
    projectId: string,
    ticketId: string,
    promptId: string,
    content: string,
    attachments?: QueuedAttachment[]
  ) => void
  /** Remove one queued prompt by id. */
  removeQueuedPrompt: (projectId: string, ticketId: string, promptId: string) => void
  /** Reorder one queued prompt up or down by a single slot. */
  moveQueuedPrompt: (
    projectId: string,
    ticketId: string,
    promptId: string,
    direction: 'up' | 'down'
  ) => void
  /** Drop the ticket's entire queue. */
  clearQueuedPrompts: (projectId: string, ticketId: string) => void
}

// Pending settle timers, keyed by ticketKey. Kept at module scope (not in the
// store) since they are transient and must not trigger re-renders. There are two
// independent, sequential delays:
//   D1 — Strict Verify (Feature A): frozen check + AI Watcher.
//   D2 — Auto Review Bypass (Feature B): commit + advance a verified ticket.
const pendingStrictVerify = new Map<TicketKey, ReturnType<typeof setTimeout>>()
const pendingAutoBypass = new Map<TicketKey, ReturnType<typeof setTimeout>>()

/**
 * Gate-1 frozen-check snapshots. Captured (asynchronously) when Strict Verify is
 * armed: S0 is the session's output fingerprint at arm time. At settle the
 * handler re-captures S1 and compares — a change means the session is still
 * emitting (not done) so it's bounced back without a model call. Stored as the
 * in-flight promise so the settle handler can await it regardless of whether the
 * capture has resolved by the time the timer fires.
 */
const frozenSnapshots = new Map<
  TicketKey,
  { sessionId: string; fp: Promise<SessionFingerprint | null> }
>()

/**
 * Window (ms) used to confirm a session is frozen when there is no pre-armed S0
 * baseline to compare against: two fingerprints taken this far apart must match.
 */
const FROZEN_STABILITY_MS = 1200

/**
 * Strict Review rule: the AI Watcher must NEVER judge a ticket until its session
 * is confirmed frozen — a session still emitting output (or actively working) is
 * still In Progress, not finished. Every path that would judge with AI calls this
 * first and bounces a non-frozen ticket back to In Progress without a model call.
 *
 * "Frozen" requires BOTH:
 *   (a) liveness  — the session's status is not actively `working`; and
 *   (b) stability — its output fingerprint isn't changing.
 *
 * Stability comes either from the pre-armed S0 baseline captured when the settle
 * timer armed (`opts.baseline`, spanning the whole settle window — the cheapest,
 * most accurate signal), or, lacking one, by sampling a fresh pair of fingerprints
 * `FROZEN_STABILITY_MS` apart when `opts.sample` is set. With neither (the manual
 * recheck — no settle window exists) the liveness check alone decides.
 *
 * Returns:
 *   'frozen'  — idle + stable → safe to hand to the Watcher.
 *   'active'  — still working / still emitting → belongs in In Progress.
 *   'unknown' — the fingerprint round-trip failed → caller must NOT fail open into
 *               the Watcher; leave the ticket put and surface/log instead.
 */
async function confirmSessionFrozen(
  sessionId: string,
  opts: { baseline?: Promise<SessionFingerprint | null>; sample?: boolean } = {}
): Promise<'frozen' | 'active' | 'unknown'> {
  // (a) Liveness — a session still actively working is, by definition, not frozen.
  const statusEntry = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
  if (statusEntry?.status === 'working') return 'active'

  // (b) Stability — compare the armed S0 baseline (if any) against a fresh
  // fingerprint, or sample a fresh pair a short window apart. With neither signal
  // the liveness verdict above stands (status already says idle → treat as frozen).
  const s0 = opts.baseline ? await opts.baseline.catch(() => null) : null
  if (!s0 && !opts.sample) return 'frozen'

  try {
    const { completionApi } = await import('@/api/completion-api')
    const a = s0 ?? (await completionApi.getSessionFingerprint(sessionId))
    if (!s0) await new Promise<void>((resolve) => setTimeout(resolve, FROZEN_STABILITY_MS))
    const b = await completionApi.getSessionFingerprint(sessionId)
    return a.length === b.length && a.hash === b.hash ? 'frozen' : 'active'
  } catch (err) {
    console.warn('[StrictVerify] frozen check: fingerprint round-trip failed', err)
    return 'unknown'
  }
}

/**
 * Maximum number of times the In Progress rescue may re-promote a single ticket
 * (per session) back to Review. After this it gives up, labels the card
 * "Re-checked", and leaves the ticket alone — the loop-breaker the user asked for.
 */
const MAX_RESCUE_ATTEMPTS = 1

/**
 * In Progress rescue state (mirrors the Strict Verify timers/snapshots). When
 * Strict Verify bounces a build ticket back to In Progress as "Not done", we arm a
 * watcher: after the delay we re-fingerprint the session and, if it has gone frozen
 * (stopped emitting) while the ticket is still stuck, re-promote it to Review for a
 * fresh judgment — at most MAX_RESCUE_ATTEMPTS times per session.
 *   pendingRescue   — the armed settle timer, keyed by ticketKey.
 *   rescueSnapshots — S0 fingerprint captured at arm time (the frozen baseline).
 *   rescueAttempts  — re-promote count per session (survives the bounce cycle;
 *                     reset only when a different session is tracked or work resumes).
 */
const pendingRescue = new Map<TicketKey, ReturnType<typeof setTimeout>>()
const rescueSnapshots = new Map<
  TicketKey,
  { sessionId: string; fp: Promise<SessionFingerprint | null> }
>()
const rescueAttempts = new Map<TicketKey, { sessionId: string; count: number }>()

function cancelInProgressRescue(key: TicketKey): void {
  const timer = pendingRescue.get(key)
  if (timer) {
    clearTimeout(timer)
    pendingRescue.delete(key)
  }
  rescueSnapshots.delete(key)
}

function cancelStrictVerify(key: TicketKey): void {
  const timer = pendingStrictVerify.get(key)
  if (timer) {
    clearTimeout(timer)
    pendingStrictVerify.delete(key)
  }
}

function cancelAutoBypass(key: TicketKey): void {
  const timer = pendingAutoBypass.get(key)
  if (timer) {
    clearTimeout(timer)
    pendingAutoBypass.delete(key)
  }
}

/** Cancel both settle timers and drop any frozen snapshot for a ticket. */
function cancelAll(key: TicketKey): void {
  cancelStrictVerify(key)
  cancelAutoBypass(key)
  cancelInProgressRescue(key)
  frozenSnapshots.delete(key)
}

/**
 * Forget every transient Strict Verify entry for a ticket that is leaving this
 * board — deleted, archived, or moved to another project. Mirrors the
 * `session_working` cleanup so a removed ticket can't leak timers/snapshots or
 * fire a settle/rescue handler (and a stray fingerprint round-trip) against a
 * row that no longer exists. Includes `rescueAttempts`, which `cancelAll`
 * intentionally preserves across the In Progress bounce cycle.
 */
function forgetTicketState(get: () => KanbanState, key: TicketKey): void {
  cancelAll(key)
  rescueAttempts.delete(key)
  get().clearCompletionVerdict(key)
  get().setVerifyProgress(key, null)
}

/**
 * Schedule Strict Verify (Feature A, D1) after a settle delay. Reschedules if
 * already pending and supersedes any pending bypass. Asynchronously captures the
 * S0 fingerprint so the frozen check has a baseline to compare against. The delay
 * absorbs the transient "completed → working → completed" churn that occurs with
 * multi-turn agents, queued follow-ups, and app-relaunch status replays — a real
 * resume of work cancels the timer before it fires.
 */
function scheduleStrictVerify(
  get: () => KanbanState,
  ticketId: string,
  projectId: string,
  delayMs: number,
  captureSnapshot: boolean
): void {
  const key = ticketKey(projectId, ticketId)
  cancelStrictVerify(key)
  cancelAutoBypass(key)

  // Capture the S0 fingerprint only when the Snapshot gate is on — otherwise the
  // frozen check won't run and the extra round-trip would be wasted.
  const ticket = (get().tickets.get(projectId) ?? []).find((t) => t.id === ticketId)
  const sessionId = captureSnapshot ? (ticket?.current_session_id ?? null) : null
  if (sessionId) {
    const fp = (async (): Promise<SessionFingerprint | null> => {
      try {
        const { completionApi } = await import('@/api/completion-api')
        return await completionApi.getSessionFingerprint(sessionId)
      } catch (err) {
        console.warn('Strict verify: failed to capture S0 fingerprint', err)
        return null
      }
    })()
    frozenSnapshots.set(key, { sessionId, fp })
  } else {
    frozenSnapshots.delete(key)
  }

  const ms = Math.max(0, delayMs)
  const timer = setTimeout(() => {
    pendingStrictVerify.delete(key)
    void onStrictVerifySettled(get, ticketId, projectId)
  }, ms)
  pendingStrictVerify.set(key, timer)
  get().setVerifyProgress(key, { phase: 'verify-countdown', deadline: Date.now() + ms })
}

/**
 * Schedule Auto Review Bypass (Feature B, D2) after a settle delay. Reschedules
 * if already pending. Armed either by Strict Verify once it verifies a ticket, or
 * directly (legacy path) when Strict Verify is off.
 */
function scheduleAutoBypass(
  get: () => KanbanState,
  ticketId: string,
  projectId: string,
  delayMs: number
): void {
  const key = ticketKey(projectId, ticketId)
  cancelAutoBypass(key)
  const ms = Math.max(0, delayMs)
  const timer = setTimeout(() => {
    pendingAutoBypass.delete(key)
    void onAutoBypassSettled(get, ticketId, projectId)
  }, ms)
  pendingAutoBypass.set(key, timer)
  get().setVerifyProgress(key, { phase: 'bypass-countdown', deadline: Date.now() + ms })
}

/**
 * (Re)arm the settle pipeline for a ticket. Called whenever a build ticket lands
 * in (or changes while sitting in) Review. When Strict Verify (Feature A) is on,
 * arm D1 — it arms D2 itself after verifying. Otherwise fall back to the legacy
 * path: arm D2 directly if the ticket opted into auto-approve. Any other state
 * cancels both timers (and drops the frozen snapshot). `ticket` must be the
 * freshly-looked-up row (post optimistic update) so its column is current.
 */
async function armSettleTimers(
  get: () => KanbanState,
  projectId: string,
  ticketId: string,
  ticket: KanbanTicket | undefined
): Promise<void> {
  const key = ticketKey(projectId, ticketId)
  if (!ticket || ticket.column !== 'review' || ticket.mode !== 'build') {
    cancelAll(key)
    get().setVerifyProgress(key, null)
    return
  }
  const { useSettingsStore } = await import('./useSettingsStore')
  const settings = useSettingsStore.getState()
  if (settings.kanbanStrictVerifyEnabled) {
    scheduleStrictVerify(
      get,
      ticketId,
      projectId,
      (settings.kanbanStrictVerifyDelaySeconds ?? 8) * 1000,
      settings.kanbanStrictVerifySnapshotEnabled ?? true
    )
  } else if (ticket.auto_approve_review) {
    scheduleAutoBypass(
      get,
      ticketId,
      projectId,
      (settings.kanbanAutoApproveDelaySeconds ?? 10) * 1000
    )
  } else {
    cancelAll(key)
    get().setVerifyProgress(key, null)
  }
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

/**
 * Compute the sort_order that lands a ticket at the TOP of `column`.
 * Used by every column-advancing action (a ticket the user just acted on
 * should surface at the top of its new column, not stay buried at its old
 * position). Excludes archived tickets via getTicketsByColumn.
 */
function topOfColumnSortOrder(
  get: () => KanbanState,
  projectId: string,
  column: KanbanTicketColumn
): number {
  return get().computeSortOrder(get().getTicketsByColumn(projectId, column), 0)
}

/** Advance a settled ticket to Done (unblocks + auto-launches its dependents). */
async function moveReviewedTicketToDone(
  get: () => KanbanState,
  ticketId: string,
  projectId: string
): Promise<void> {
  try {
    const sortOrder = topOfColumnSortOrder(get, projectId, 'done')
    await get().moveTicket(ticketId, projectId, 'done', sortOrder)
  } catch (err) {
    console.error('Auto-approve review: move to Done failed for ticket', ticketId, err)
  }
}

/** Move a settled-but-incomplete ticket back to In Progress (bottom of the column). */
async function moveTicketBackToInProgress(
  get: () => KanbanState,
  ticketId: string,
  projectId: string
): Promise<void> {
  try {
    const inProgress = (get().tickets.get(projectId) ?? []).filter((t) => t.column === 'in_progress')
    const sortOrder = get().computeSortOrder(inProgress, inProgress.length)
    await get().moveTicket(ticketId, projectId, 'in_progress', sortOrder)
  } catch (err) {
    console.error('Completion check: move back to In Progress failed for ticket', ticketId, err)
  }
}

/**
 * Arm the In Progress rescue watcher for a ticket Strict Verify just bounced back
 * to In Progress as "Not done". Captures the S0 fingerprint now and schedules the
 * frozen re-check after `delayMs`. Resets the per-session retry budget when a
 * different session is being watched. Silent (no countdown UI — the ticket is in
 * In Progress, not Review). Caller must gate on the rescue setting + a non-needsInput
 * verdict, and arm AFTER the move-back (the move re-runs armSettleTimers → cancelAll,
 * which would otherwise cancel this timer).
 */
function armInProgressRescue(
  get: () => KanbanState,
  ticketId: string,
  projectId: string,
  sessionId: string,
  delayMs: number
): void {
  const key = ticketKey(projectId, ticketId)
  cancelInProgressRescue(key)

  // Reset the retry budget when we start watching a different session.
  const att = rescueAttempts.get(key)
  if (!att || att.sessionId !== sessionId) {
    rescueAttempts.set(key, { sessionId, count: 0 })
  }

  // Capture S0 now so the frozen check has a baseline at settle time.
  const fp = (async (): Promise<SessionFingerprint | null> => {
    try {
      const { completionApi } = await import('@/api/completion-api')
      return await completionApi.getSessionFingerprint(sessionId)
    } catch (err) {
      console.warn('In Progress rescue: failed to capture S0 fingerprint', err)
      return null
    }
  })()
  rescueSnapshots.set(key, { sessionId, fp })

  const ms = Math.max(0, delayMs)
  const timer = setTimeout(() => {
    pendingRescue.delete(key)
    void onInProgressRescueSettled(get, ticketId, projectId)
  }, ms)
  pendingRescue.set(key, timer)
}

/**
 * In Progress rescue settle handler. Fires `delayMs` after a build ticket was
 * bounced to In Progress as "Not done". Re-fingerprints the session:
 *   not frozen (still emitting) → genuinely working → leave it (correct in In Progress).
 *   frozen (idle) but still "Not done" → the bounce was likely premature (stale
 *     transcript at judge time); re-promote to Review for a fresh judgment — up to
 *     MAX_RESCUE_ATTEMPTS times per session, then label "Re-checked" and give up.
 * Aborts silently (leaves the ticket) on any guard failure or missing baseline.
 */
async function onInProgressRescueSettled(
  get: () => KanbanState,
  ticketId: string,
  projectId: string
): Promise<void> {
  const key = ticketKey(projectId, ticketId)
  const snap = rescueSnapshots.get(key)
  rescueSnapshots.delete(key)

  const current = (get().tickets.get(projectId) ?? []).find((t) => t.id === ticketId)
  // Guard: still a build ticket sitting in In Progress.
  if (!current || current.column !== 'in_progress' || current.mode !== 'build') return
  const sessionId = current.current_session_id
  if (!sessionId) return

  // Only rescue a ticket Strict Verify bounced here as "Not done" — not one waiting
  // on the user (needsInput), and only for the session we snapshotted.
  const verdict = get().completionVerdicts.get(key)
  if (!verdict || verdict.sessionId !== sessionId || !verdict.movedBack || verdict.needsInput) {
    return
  }

  // Frozen check (S0 at arm vs S1 now). No baseline → can't tell → conservatively
  // leave it (treat as possibly still working).
  if (!snap || snap.sessionId !== sessionId) return
  const s0 = await snap.fp.catch(() => null)
  if (!s0) return
  let s1: SessionFingerprint | null = null
  try {
    const { completionApi } = await import('@/api/completion-api')
    s1 = await completionApi.getSessionFingerprint(sessionId)
  } catch (err) {
    console.warn('In Progress rescue: failed to capture S1 fingerprint', err)
    return
  }
  if (!s1) return

  const frozen = s1.length === s0.length && s1.hash === s0.hash
  if (!frozen) {
    console.log(
      `[StrictVerify] rescue: ticket ${ticketId} still emitting → leaving in In Progress`
    )
    return
  }

  // Frozen + still "Not done" → re-promote to Review (capped), or give up + label.
  const tracked = rescueAttempts.get(key)
  const count = tracked && tracked.sessionId === sessionId ? tracked.count : 0
  if (count >= MAX_RESCUE_ATTEMPTS) {
    console.warn(
      `[StrictVerify] rescue: ticket ${ticketId} exhausted ${MAX_RESCUE_ATTEMPTS} retry — leaving in In Progress with "Re-checked" label`
    )
    const v = get().completionVerdicts.get(key)
    if (v && !v.rescueExhausted) {
      get().setCompletionVerdict(key, { ...v, rescueExhausted: true })
      // All Strict Verify rescue retries are exhausted and the ticket still isn't
      // done — it's genuinely stuck and needs user action. This is the ONLY
      // "stuck review" notification trigger. Once per session (the rescue budget
      // is per-session, so a fresh session re-arms and can notify again).
      void import('../lib/ticket-telegram-notify')
        .then((m) => {
          void m
            .notifyTicketEvent('stuck_review', {
              ticketId,
              title: current.title,
              dedupeKey: `stuck_review:${ticketId}:${sessionId}`
            })
            .catch(() => {})
          // Also unlock two-way Telegram chat for this stuck session so the user can act
          // from Telegram like the terminal (opt-in; never steals an active forward).
          void m
            .autoForwardTicketForUserAction({
              sessionId,
              worktreeId: current.worktree_id ?? null,
              connectionId: null
            })
            .catch(() => {})
        })
        .catch(() => {})
    }
    return
  }

  rescueAttempts.set(key, { sessionId, count: count + 1 })
  console.log(
    `[StrictVerify] rescue: ticket ${ticketId} frozen + Not done → re-promoting to Review (attempt ${count + 1}/${MAX_RESCUE_ATTEMPTS})`
  )
  // Clear the cached verdict so the re-judge is FRESH (bypasses runStrictVerify's
  // per-session reuse guard).
  get().clearCompletionVerdict(key)
  try {
    const reviewTickets = (get().tickets.get(projectId) ?? []).filter((t) => t.column === 'review')
    const sortOrder = get().computeSortOrder(reviewTickets, reviewTickets.length)
    await get().moveTicket(ticketId, projectId, 'review', sortOrder)
  } catch (err) {
    console.error('In Progress rescue: re-promote to Review failed for ticket', ticketId, err)
  }
}

/**
 * Arm the In Progress rescue after a "Not done" bounce, if enabled and the verdict
 * is a plain incomplete (not a needsInput / waiting-on-user verdict). Reuses the
 * Strict Verify delay as the frozen-check window. No-op when rescue is off.
 */
function maybeArmRescueAfterBounce(
  get: () => KanbanState,
  ticketId: string,
  projectId: string,
  sessionId: string,
  needsInput: boolean,
  settings: { kanbanInProgressRescueEnabled?: boolean; kanbanStrictVerifyDelaySeconds?: number }
): void {
  if (needsInput || !settings.kanbanInProgressRescueEnabled) return
  armInProgressRescue(
    get,
    ticketId,
    projectId,
    sessionId,
    (settings.kanbanStrictVerifyDelaySeconds ?? 8) * 1000
  )
}

/** The Strict Verify settings slice (subset of the settings store). */
interface StrictVerifySettings {
  kanbanStrictVerifyProvider: CompletionCheckProvider
  kanbanStrictVerifyModel: string
  kanbanStrictVerifyChars: number
  kanbanStrictVerifyConfidenceThreshold: number
  /** User-editable Ticket Reviewer system prompt (blank → built-in default). */
  kanbanStrictVerifyPrompt: string
  /** Settle delay (s); reused as the In Progress rescue frozen-check window. */
  kanbanStrictVerifyDelaySeconds?: number
  /** In Progress rescue master switch (re-promote a frozen "Not done" ticket once). */
  kanbanInProgressRescueEnabled?: boolean
}

/**
 * Gate 2 — the AI Watcher. Returns `true` when the ticket is judged NOT genuinely
 * complete (incomplete, low confidence, OR the agent is waiting on the user), in
 * which case it stores the verdict and bounces the ticket back to In Progress.
 *
 * Idempotent per session: once a verdict exists for the ticket's current session,
 * we neither re-call the model nor re-store — this absorbs the `session_completed`
 * status replays that fire on app relaunch/focus. A genuine resume of work clears
 * the verdict (see `session_working`), so the next settle re-checks the now-longer
 * transcript. A detection error does NOT fail open: it surfaces the error and
 * leaves the ticket in Review (outcome `'error'`) so the cause can be traced.
 */
/**
 * Outcome of a Strict Verify pass:
 *  - `'complete'` — verified complete (or nothing to judge); proceed to Feature B.
 *  - `'bounced'`  — judged incomplete; verdict stored and ticket moved back.
 *  - `'error'`    — the Reviewer threw or returned no verdict. We do NOT fail open
 *                   (no fake "complete" verdict, no advance); the ticket rests in
 *                   Review with the error surfaced + logged for tracing.
 */
type StrictVerifyOutcome = 'complete' | 'bounced' | 'error'

/**
 * Surface a Strict Verify failure loudly instead of failing open. The Reviewer
 * threw or returned no verdict — we do NOT fabricate a "complete" verdict and we
 * do NOT advance the ticket. It rests in Review with the error shown to the user
 * (toast, with a one-click re-run) and logged under the traceable `[StrictVerify]`
 * prefix so the failure can be traced end-to-end.
 */
function reportStrictVerifyError(
  get: () => KanbanState,
  ticketId: string,
  projectId: string,
  ticket: KanbanTicket,
  detail: unknown
): void {
  const message = detail instanceof Error ? detail.message : String(detail ?? 'unknown error')
  console.error(
    `[StrictVerify] completion check FAILED for ticket ${ticketId} ` +
      `(session ${ticket.current_session_id ?? 'none'}) — left in Review, NOT advanced: ${message}`
  )
  const title = ticket.title?.trim() || 'ticket'
  const label = title.length > 80 ? `${title.slice(0, 79)}…` : title
  toast.error(`AI completion check failed for "${label}" — left in Review. ${message}`, {
    retry: () => {
      void get().recheckTicketCompletion(ticketId, projectId)
    }
  })
}

async function runStrictVerify(
  get: () => KanbanState,
  ticketId: string,
  projectId: string,
  ticket: KanbanTicket,
  settings: StrictVerifySettings
): Promise<StrictVerifyOutcome> {
  const sessionId = ticket.current_session_id
  if (!sessionId) return 'complete' // no transcript to judge → don't block

  const key = ticketKey(projectId, ticketId)
  const prior = get().completionVerdicts.get(key)
  if (prior && prior.sessionId === sessionId) {
    // Already judged this session's settle — reuse it (no model call). Re-apply
    // the move-back so a `session_completed` replay (which the sync handler
    // bounces back to Review) can't strand an incomplete ticket there.
    console.warn(
      `[StrictVerify] REUSING cached verdict for ticket ${ticketId} — session ${sessionId} unchanged, NO fresh model call. ` +
        `complete=${prior.complete} conf=${prior.confidence} reason="${prior.reason}"`
    )
    if (prior.movedBack) {
      await moveTicketBackToInProgress(get, ticketId, projectId)
      maybeArmRescueAfterBounce(get, ticketId, projectId, sessionId, prior.needsInput, settings)
    }
    return prior.movedBack ? 'bounced' : 'complete'
  }

  const threshold = settings.kanbanStrictVerifyConfidenceThreshold ?? 0.6
  let result
  try {
    const { completionApi } = await import('@/api/completion-api')
    result = await completionApi.detectTicketCompletion({
      sessionId,
      ticketId,
      maxChars: settings.kanbanStrictVerifyChars,
      provider: settings.kanbanStrictVerifyProvider,
      model: settings.kanbanStrictVerifyModel || undefined,
      systemPrompt: settings.kanbanStrictVerifyPrompt || undefined
    })
  } catch (err) {
    reportStrictVerifyError(get, ticketId, projectId, ticket, err)
    return 'error'
  }

  if (!result.success || !result.verdict) {
    reportStrictVerifyError(get, ticketId, projectId, ticket, result.error)
    return 'error'
  }

  const verdict = result.verdict
  const incomplete = !verdict.complete || verdict.confidence < threshold || verdict.needsInput
  console.log(
    `[StrictVerify] FRESH verdict for ticket ${ticketId} (session ${sessionId}): ` +
      `complete=${verdict.complete} conf=${verdict.confidence} needsInput=${verdict.needsInput} ` +
      `threshold=${threshold} → ${incomplete ? 'INCOMPLETE (moving back)' : 'COMPLETE (stays)'} reason="${verdict.reason}"`
  )
  get().setCompletionVerdict(key, {
    ...verdict,
    sessionId,
    checkedAt: Date.now(),
    movedBack: incomplete
  })

  if (incomplete) {
    await moveTicketBackToInProgress(get, ticketId, projectId)
    maybeArmRescueAfterBounce(get, ticketId, projectId, sessionId, verdict.needsInput, settings)
  }
  return incomplete ? 'bounced' : 'complete'
}

/**
 * Shared liveness gate used by both settle handlers: the ticket is still a build
 * ticket in Review, and its session has been idle (`completed`) for the full
 * settle window with no queued follow-ups. Returns `false` (abort silently,
 * leaving the ticket in Review) when any condition fails.
 *
 * `allowQueued` keeps the settle alive when the session has queued follow-ups —
 * required by the Queue prompts feature, where Strict Verify must still run on a
 * Review ticket so a verified-complete verdict can drain the next queued prompt.
 */
async function passesSettleGuards(
  current: KanbanTicket,
  settleMs: number,
  allowQueued = false
): Promise<boolean> {
  if (current.column !== 'review' || current.mode !== 'build') return false
  const sessionId = current.current_session_id
  if (!sessionId) return true
  const { useSessionStore } = await import('./useSessionStore')
  const statusEntry = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
  if (!statusEntry || statusEntry.status !== 'completed') return false
  if (Date.now() - statusEntry.timestamp < settleMs) return false
  if (!allowQueued) {
    const queued = useSessionStore.getState().pendingFollowUpMessages.get(sessionId)
    if (queued && queued.length > 0) return false
  }
  return true
}

/**
 * True when the Queue prompts feature is active for `sessionId`: Strict Verify +
 * its Reviewer sub-gate are on (the verified-complete verdict the queue drains on
 * comes from the Reviewer), the global toggle is on, and the session is a Claude
 * Code CLI session (the only kind the queue manages — SDK sessions queue natively).
 */
async function isClaudeCliQueueFeatureActive(sessionId: string | null): Promise<boolean> {
  if (!sessionId) return false
  const { useSettingsStore } = await import('./useSettingsStore')
  const s = useSettingsStore.getState()
  if (!s.kanbanStrictVerifyEnabled || !s.kanbanQueuePromptsEnabled) return false
  if (!(s.kanbanStrictVerifyReviewerEnabled ?? true)) return false
  const { useSessionStore } = await import('./useSessionStore')
  return useSessionStore.getState().getSessionById(sessionId)?.agent_sdk === 'claude-code-cli'
}

/**
 * Queue prompts drain step. When the feature is active and `ticket` is a
 * verified-complete build ticket idle in Review with its CLI session idle, enter
 * the head of the ticket's prompt queue (which moves it back to In Progress via
 * the resulting `session_working` event) and remove that prompt from the queue.
 * Returns `true` when a prompt was dispatched. On a delivery failure the prompt
 * is left at the head and `false` is returned so the next pass retries it.
 */
async function maybeDispatchClaudeCliQueue(
  get: () => KanbanState,
  projectId: string,
  ticketId: string
): Promise<boolean> {
  const current = (get().tickets.get(projectId) ?? []).find((t) => t.id === ticketId)
  if (!current || current.column !== 'review' || current.mode !== 'build') return false
  const sessionId = current.current_session_id
  if (!sessionId) return false
  if (!(await isClaudeCliQueueFeatureActive(sessionId))) return false

  // The verified-complete gate: only advance the queue once the ticket has a
  // Reviewer verdict for THIS session that says complete and wasn't bounced.
  const verdict = get().completionVerdicts.get(ticketKey(projectId, ticketId))
  const verified =
    !!verdict && verdict.sessionId === sessionId && verdict.complete && !verdict.movedBack
  if (!verified) return false

  // Peek the head; only remove it once delivery succeeds so nothing is lost.
  const head = get().promptQueues[ticketKey(projectId, ticketId)]?.[0]
  if (!head) return false

  const { dispatchClaudeCliFollowup } = await import('@/lib/claude-cli-followup')
  const delivered = await dispatchClaudeCliFollowup(
    sessionId,
    buildQueuedPromptText(head.content, head.attachments)
  )
  if (!delivered) return false

  get().removeQueuedPrompt(projectId, ticketId, head.id)
  return true
}

/**
 * Feature A settle handler (D1). Runs the two-gate Strict Verify pipeline:
 *
 *   Gate 1 (frozen check, ALWAYS runs) — confirm the session is frozen before any
 *     model call: compare the S0 snapshot taken at arm time against a fresh S1 (or,
 *     when no S0 was armed, sample a fresh pair a short window apart). A session
 *     still emitting output → bounce back to In Progress WITHOUT a model call; a
 *     fingerprint round-trip failure leaves the ticket in Review (never fails open).
 *   Gate 2 (AI Watcher) — judge complete / asking-user / incomplete. Anything but
 *     "genuinely complete" stores the verdict and bounces back.
 *
 * On a verified-complete verdict the ticket stays in Review; if it opted into
 * auto-approve, Feature B (Auto Review Bypass, D2) is armed.
 */
async function onStrictVerifySettled(
  get: () => KanbanState,
  ticketId: string,
  projectId: string
): Promise<void> {
  const key = ticketKey(projectId, ticketId)
  const current = (get().tickets.get(projectId) ?? []).find((t) => t.id === ticketId)
  if (!current) {
    frozenSnapshots.delete(key)
    get().setVerifyProgress(key, null)
    return
  }

  const { useSettingsStore } = await import('./useSettingsStore')
  const settings = useSettingsStore.getState()
  const settleMs = Math.max(0, (settings.kanbanStrictVerifyDelaySeconds ?? 8) * 1000)
  // Queue prompts: a Review ticket with queued follow-ups must still settle so it
  // gets verified — the verdict is what drains the queue. Allow the queued state.
  const queueFeatureActive = await isClaudeCliQueueFeatureActive(current.current_session_id)
  if (!(await passesSettleGuards(current, settleMs, queueFeatureActive))) {
    frozenSnapshots.delete(key)
    get().setVerifyProgress(key, null)
    return
  }

  // Countdown elapsed — the gates run now (no fixed duration).
  get().setVerifyProgress(key, { phase: 'checking' })
  const sessionId = current.current_session_id

  // ── Gate 1: frozen check (ALWAYS precedes the AI Watcher) ─────────────
  // Strict Review rule: never judge with AI until the session is confirmed frozen.
  // Prefer the S0 baseline captured at arm time (spans the whole settle window);
  // when none was armed (Snapshot sub-gate off, or capture failed) sample a fresh
  // pair instead. A still-emitting session is not done → back to In Progress.
  if (sessionId) {
    const snap = frozenSnapshots.get(key)
    const baseline = snap && snap.sessionId === sessionId ? snap.fp : undefined
    frozenSnapshots.delete(key)
    const frozen = await confirmSessionFrozen(sessionId, { baseline, sample: true })
    if (frozen === 'active') {
      // Still emitting / working → not frozen → it's In Progress, not done.
      await moveTicketBackToInProgress(get, ticketId, projectId)
      return
    }
    if (frozen === 'unknown') {
      // Could not confirm frozen → do NOT fail open into the Watcher. Leave the
      // ticket in Review (no verdict, no advance) so the miss is traceable.
      console.error(
        `[StrictVerify] frozen check INCONCLUSIVE for ticket ${ticketId} ` +
          `(session ${sessionId}) — left in Review, Watcher NOT run`
      )
      get().setVerifyProgress(key, null)
      return
    }
  } else {
    frozenSnapshots.delete(key)
  }

  // ── Gate 2: Ticket Reviewer (the AI Watcher) ──────────────────────
  // Skipped when the Reviewer sub-gate is off — a ticket that cleared the
  // snapshot (or had it disabled) is then treated as verified without a model call.
  if (settings.kanbanStrictVerifyReviewerEnabled ?? true) {
    const outcome = await runStrictVerify(get, ticketId, projectId, current, settings)
    if (outcome === 'bounced') return // verdict stored + moved back (the move clears progress)
    if (outcome === 'error') {
      // The Reviewer failed — error already surfaced + logged by runStrictVerify.
      // Do NOT fail open: leave the ticket in Review (no verdict, no advance) so
      // the failure can be traced, and clear the in-progress badge. This is a
      // transient verifier failure (retried internally), NOT the "stuck — needs
      // user action" state, so it does not fire a Telegram notification.
      get().setVerifyProgress(key, null)
      return
    }
  }

  // Verified complete. Queue prompts takes precedence over Done/auto-approve: if
  // a follow-up is queued, enter it now (moves the ticket back to In Progress)
  // and stop — the next verified-complete will drain the prompt after it.
  if (queueFeatureActive && (await maybeDispatchClaudeCliQueue(get, projectId, ticketId))) {
    get().setVerifyProgress(key, null)
    return
  }

  // Verified complete — the ticket stays in Review. Hand off to Feature B if this
  // ticket opted into auto-approve; otherwise the pipeline is done.
  if (current.auto_approve_review) {
    scheduleAutoBypass(
      get,
      ticketId,
      projectId,
      (settings.kanbanAutoApproveDelaySeconds ?? 10) * 1000
    )
  } else {
    get().setVerifyProgress(key, null)
  }
}

/**
 * Feature B settle handler (D2) — Auto Review Bypass. Commits the worktree (if
 * enabled), then advances a non-terminal (chain) ticket to Done so the next ticket
 * auto-starts; a terminal ticket stays in Review. Per-ticket opt-in
 * (`auto_approve_review`).
 *
 * When Strict Verify (Feature A) is on, this only proceeds once a VERIFIED verdict
 * (complete, not bounced) exists for the current session — Feature A arms this
 * timer itself after verifying. When Feature A is off, the opt-in alone is enough
 * (legacy behavior). Re-checks the settle guards so transient churn can't fire it.
 */
async function onAutoBypassSettled(
  get: () => KanbanState,
  ticketId: string,
  projectId: string
): Promise<void> {
  const key = ticketKey(projectId, ticketId)
  const current = (get().tickets.get(projectId) ?? []).find((t) => t.id === ticketId)
  if (!current || !current.auto_approve_review) {
    get().setVerifyProgress(key, null)
    return
  }

  const { useSettingsStore } = await import('./useSettingsStore')
  const settings = useSettingsStore.getState()
  const settleMs = Math.max(0, (settings.kanbanAutoApproveDelaySeconds ?? 10) * 1000)
  if (!(await passesSettleGuards(current, settleMs))) {
    get().setVerifyProgress(key, null)
    return
  }

  if (settings.kanbanStrictVerifyEnabled) {
    const verdict = get().completionVerdicts.get(key)
    const verified =
      !!verdict &&
      verdict.sessionId === current.current_session_id &&
      verdict.complete &&
      !verdict.movedBack
    if (!verified) {
      get().setVerifyProgress(key, null)
      return
    }
  }

  // Countdown elapsed — commit and (if a chain) advance now.
  await finalizeReviewBypass(get, ticketId, projectId, current, settings.kanbanAutoCommitOnReview)
}

/**
 * Feature B's terminal step: commit the worktree (when auto-commit is on) and
 * advance a chain ticket (one a later ticket depends on) to Done so the next
 * step can launch; a terminal ticket just stays in Review. Shared by the
 * automatic settle (`onAutoBypassSettled`, after its guards) AND the manual
 * "Verify with AI" recheck — so a hand-verified complete ticket commits and
 * advances exactly like the automatic pass instead of stalling in Review.
 */
async function finalizeReviewBypass(
  get: () => KanbanState,
  ticketId: string,
  projectId: string,
  current: KanbanTicket,
  autoCommit: boolean
): Promise<void> {
  const key = ticketKey(projectId, ticketId)
  get().setVerifyProgress(key, { phase: 'finalizing' })
  if (autoCommit) {
    await commitTicketWorktree(ticketId, current)
  }
  if (ticketHasDependent(get, projectId, ticketId)) {
    await moveReviewedTicketToDone(get, ticketId, projectId)
  }
  // Terminal ticket stays in Review (no move to clear it); ensure the badge clears.
  get().setVerifyProgress(key, null)
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
      completionVerdicts: new Map(),
      verifyProgress: new Map(),
      promptQueues: {},

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
        const includeArchived = get().showArchivedByProject[projectId] ?? false

        // Archived view stays a single full fetch: it's opt-in, and correctness
        // (no interleaving of archived/active in the paginated sort order) wins
        // over the first-paint speed the paginated path buys.
        if (includeArchived) {
          set({ isLoading: true })
          try {
            const { tickets, diagnostics } = await loadProjectTicketsSnapshot(projectId, true)
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
          return
        }

        // Fast path: first page per column in one round-trip → render now, then
        // stream the remaining pages into the store in the background.
        const generation = beginLoadGeneration(projectId)
        set({ isLoading: true })
        try {
          const [pages, diagnostics] = await Promise.all([
            kanban.ticket.getColumnPages<KanbanTicket>(projectId, TICKETS_PER_PAGE),
            kanban.diagnostics.get<MarkdownCardDiagnostic>(projectId).catch(() => [])
          ])
          // A newer load (reload / project switch) superseded us mid-flight.
          if (!isCurrentLoad(projectId, generation)) return
          const firstPage = flattenColumnPages(pages)
          set((state) => {
            const next = new Map(state.tickets)
            const nextDiagnostics = new Map(state.markdownDiagnostics)
            const nextPlaceholders = new Map(state.markdownPlaceholders)
            next.set(projectId, firstPage)
            nextDiagnostics.set(projectId, diagnostics)
            nextPlaceholders.set(
              projectId,
              placeholdersFromDiagnostics(projectId, diagnostics, firstPage)
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
          // Phase 2: page in the rest without blocking first paint.
          void streamRemainingTickets(projectId, generation, pages)
        } catch {
          if (isCurrentLoad(projectId, generation)) set({ isLoading: false })
        }
      },

      loadTicketsWithArchiveVisibility: async (projectId: string, includeArchived: boolean) => {
        set({ isLoading: true })
        try {
          const { tickets, diagnostics } = await loadProjectTicketsSnapshot(
            projectId,
            includeArchived
          )
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

      convertMarkdownPlaceholder: async (projectId: string, filePath: string) => {
        const ticket = await kanban.markdown.convertFileToCard<KanbanTicket>(projectId, filePath)
        const includeArchived =
          get().showArchivedByProject[projectId] ?? get().showArchivedByProject[''] ?? false
        await get().loadTicketsWithArchiveVisibility(projectId, includeArchived)
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
        // must (re)arm or cancel the settle pipeline — column moves are handled by
        // moveTicket, but an in-place flag change is not. armSettleTimers decides
        // between Strict Verify (D1) and the legacy Auto Review Bypass (D2).
        if (data.auto_approve_review !== undefined) {
          const updated = (get().tickets.get(projectId) ?? []).find((t) => t.id === ticketId)
          await armSettleTimers(get, projectId, ticketId, updated)
        }

        // An in-place column write (auto-launch / auto-attach move a ticket
        // Todo → In Progress via updateTicket, not moveTicket) must still fire the
        // Telegram lifecycle notification. The shared handler gates on the actual
        // transition, so passing a non-column update is a harmless no-op.
        if (data.column !== undefined) {
          const prevTicket = prev.find((t) => t.id === ticketId)
          const title = data.title ?? prevTicket?.title ?? ''
          void import('../lib/ticket-telegram-notify')
            .then((m) =>
              m.notifyTicketColumnChange({
                ticketId,
                title,
                prevColumn: prevTicket?.column,
                column: data.column
              })
            )
            .catch(() => {})
        }
      },

      // ── deleteTicket (optimistic) ────────────────────────────────
      deleteTicket: async (ticketId: string, projectId: string) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        // Guard against a still-streaming background page resurrecting this ticket.
        trackRemovedTicket(projectId, ticketId)

        // Optimistic local delete
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).filter((t) => t.id !== ticketId)
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await kanban.ticket.delete(projectId, ticketId)

          // Drop any pending Strict Verify timers/snapshots for the gone ticket.
          forgetTicketState(get, ticketKey(projectId, ticketId))

          // Remove all dependency links for deleted ticket
          kanban.dependency.removeAll(projectId, ticketId).catch(() => {})
          // Update local dependency map
          set((state) => {
            return { dependencyMap: removeDependencyLinksForTicket(state.dependencyMap, ticketKey(projectId, ticketId)) }
          })
          // Drop the persisted ticket-detail tab view (dynamic import avoids a
          // static cycle with useSessionStore, matching the pattern elsewhere here).
          void import('./useSessionStore').then(({ useSessionStore }) => {
            useSessionStore.getState().setTicketActiveView(ticketId, null)
          })

          // Deleting a running ticket frees a worktree slot (and unblocks any
          // dependents it gated) without a column move — drive the launcher so a
          // queued chain can take the slot. No-op for uncapped projects.
          void import('../lib/worktree-concurrency').then(({ launchNextQueuedTickets }) =>
            launchNextQueuedTickets(projectId).catch(() => {})
          )
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

        // Guard against a still-streaming source-board page resurrecting this ticket.
        trackRemovedTicket(sourceProjectId, ticketId)

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

          // The ticket left this board — drop its transient Strict Verify state
          // (the target board re-arms fresh when the ticket settles there).
          forgetTicketState(get, ticketKey(sourceProjectId, ticketId))

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

          // The ticket left the source board — if it was running there, a slot just
          // freed. Drive the source project's launcher so its queue advances. No-op
          // for uncapped projects.
          void import('../lib/worktree-concurrency').then(({ launchNextQueuedTickets }) =>
            launchNextQueuedTickets(sourceProjectId).catch(() => {})
          )

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

          // Drop any pending Strict Verify timers/snapshots for the archived ticket.
          forgetTicketState(get, ticketKey(projectId, ticketId))

          // Remove all dependency links for archived ticket
          await kanban.dependency.removeAll(projectId, ticketId)
          // Update local dependency map
          set((state) => {
            return { dependencyMap: removeDependencyLinksForTicket(state.dependencyMap, ticketKey(projectId, ticketId)) }
          })

          // Archiving a running ticket frees a worktree slot (and unblocks any
          // dependents it gated), but there's no column move to trigger the queue —
          // so drive the concurrency launcher here. No-op for uncapped projects.
          void import('../lib/worktree-concurrency').then(({ launchNextQueuedTickets }) =>
            launchNextQueuedTickets(projectId).catch(() => {})
          )
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
        const archivedKeys: TicketKey[] = []
        // Optimistic local archive of all non-archived done tickets
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) => {
            if (t.column === 'done' && !t.archived_at) {
              count++
              archivedKeys.push(ticketKey(projectId, t.id))
              return { ...t, archived_at: now, updated_at: now }
            }
            return t
          })
          next.set(projectId, tickets)
          return { tickets: next }
        })

        try {
          await kanban.ticket.archiveAllDone(projectId)
          // Drop any pending Strict Verify state for the archived tickets.
          for (const key of archivedKeys) forgetTicketState(get, key)
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
        sortOrder: number,
        opts?: MoveTicketOptions
      ) => {
        const prev = get().tickets.get(projectId) ?? []
        const snapshot = prev.map((t) => ({ ...t }))

        // A user-initiated move INTO Review is a deliberate "judge this again" —
        // drop any cached verdict + rescue budget for the session so Strict Verify
        // runs a FRESH model call (the per-session reuse guard would otherwise replay
        // the stale verdict and bounce it straight back, unchanged). Automatic moves
        // (Stop-hook, session_completed replay, rescue re-promote) keep the cache so
        // they stay idempotent.
        if (opts?.userInitiated && column === 'review') {
          const key = ticketKey(projectId, ticketId)
          get().clearCompletionVerdict(key)
          rescueAttempts.delete(key)
        }

        // Optimistic local update
        set((state) => {
          const next = new Map(state.tickets)
          const tickets = (next.get(projectId) ?? []).map((t) =>
            t.id === ticketId
              ? {
                  ...t,
                  column,
                  sort_order: sortOrder,
                  // Re-arm the unviewed-Review glow the instant the ticket first
                  // enters Review (mirrors the DB reset in moveKanbanTicket).
                  ...(column === 'review' && t.column !== 'review'
                    ? { review_seen_at: null }
                    : {})
                }
              : t
          )
          next.set(projectId, tickets)
          return { tickets: next }
        })

        const movedTicket = prev.find((t) => t.id === ticketId)

        try {
          await kanban.ticket.move(projectId, ticketId, column, sortOrder)

          // When a ticket moves to done (or review, if that's the trigger), check if any dependents can be auto-launched
          const { useSettingsStore } = await import('./useSettingsStore')
          const { isBlockerSatisfied } = await import('../lib/blocker-utils')
          const { getMaxParallelWorktrees, launchNextQueuedTickets } = await import(
            '../lib/worktree-concurrency'
          )
          const triggerColumn = useSettingsStore.getState().followUpTriggerColumn
          // Capped projects route EVERY auto-launch (dependency-ready AND
          // concurrency-queued) through the single serialized launchNextQueuedTickets
          // call below — so a dependency launch and a freed-slot launch can't race and
          // blow past the cap. Uncapped projects keep the direct dependency launch.
          const capped = getMaxParallelWorktrees(projectId) > 0
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
                // Capped projects defer to launchNextQueuedTickets (below) so the cap
                // is honored; only uncapped projects launch the dependent directly.
                if (!capped && depTicket?.pending_launch_config) {
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

          // Drive the serialized launcher on EVERY move (no-op for uncapped projects).
          // It covers both triggers at once: a freed slot (a ticket left In Progress)
          // and a dependent becoming ready (a blocker reached its trigger column),
          // launching queued tickets oldest-first up to the cap.
          launchNextQueuedTickets(projectId).catch((err) => {
            console.error('Concurrency dequeue failed for project:', projectId, err)
          })

          // (Re)arm the settle pipeline for build tickets entering Review.
          // armSettleTimers picks Strict Verify (D1) when Feature A is on, else the
          // legacy Auto Review Bypass (D2) for auto-approve tickets; any other
          // column cancels both. Use the freshly-updated row from state (its column
          // reflects the move target) — `movedTicket` is the pre-move snapshot.
          const updated = (get().tickets.get(projectId) ?? []).find((t) => t.id === ticketId)
          await armSettleTimers(get, projectId, ticketId, updated)

          // Telegram ticket-lifecycle notifications (gated per-event in settings).
          // Hand the pre-move snapshot column and the target to the shared
          // transition handler: it fires "started" on the first Todo → In Progress
          // and "done" on a genuine move into Done (and frees stale dedupe slots).
          const prevColumn = movedTicket?.column
          const ticketTitle = updated?.title ?? movedTicket?.title ?? ''
          void import('../lib/ticket-telegram-notify')
            .then((m) => m.notifyTicketColumnChange({ ticketId, title: ticketTitle, prevColumn, column }))
            .catch(() => {})
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
                // A queued/un-launched ticket still carries pending_launch_config —
                // it does NOT own this session. It only got current_session_id by
                // being attached to a shared worktree's already-running session (or
                // swept by a handoff relink). Never auto-advance it on another
                // ticket's completion, or a blocked/queued ticket rides to Review.
                if (ticket.pending_launch_config) break
                if (
                  ticket.mode === 'build' &&
                  ticket.column !== 'review' &&
                  ticket.column !== 'done'
                ) {
                  // Auto-advance build ticket to review column (idempotent — skip if already there)
                  get()
                    .moveTicket(ticket.id, projectId, 'review', topOfColumnSortOrder(get, projectId, 'review'))
                    .catch(() => {})
                } else if (isPlanLike(ticket.mode) && !ticket.plan_ready) {
                  // Plan finished — set plan_ready and move to review for user attention
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: true })
                    .catch(() => {})
                  if (ticket.column !== 'review' && ticket.column !== 'done') {
                    get()
                      .moveTicket(ticket.id, projectId, 'review', topOfColumnSortOrder(get, projectId, 'review'))
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
                      .moveTicket(ticket.id, projectId, 'review', topOfColumnSortOrder(get, projectId, 'review'))
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
                    .moveTicket(ticket.id, projectId, 'in_progress', topOfColumnSortOrder(get, projectId, 'in_progress'))
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
                // Same rider guard as session_completed: a queued ticket attached to
                // someone else's session must not be dragged to Review on their error.
                if (ticket.pending_launch_config) break
                // Error requires user attention — move to review if currently in_progress
                if (ticket.column === 'in_progress') {
                  get()
                    .moveTicket(ticket.id, projectId, 'review', topOfColumnSortOrder(get, projectId, 'review'))
                    .catch(() => {})
                }
                break
              }

              case 'session_working': {
                // Session became active — move ticket to in_progress if it's in
                // todo (pre-assigned, first activity) or review (returning to work).
                // A genuine resume invalidates any prior completion verdict so the
                // next settle re-checks the now-longer transcript, and cancels any
                // armed Strict Verify / Auto Review Bypass timers (the ticket is no
                // longer idle in Review).
                get().clearCompletionVerdict(ticketKey(projectId, ticket.id))
                cancelAll(ticketKey(projectId, ticket.id))
                // Genuine resume = fresh work → reset the rescue retry budget too.
                rescueAttempts.delete(ticketKey(projectId, ticket.id))
                get().setVerifyProgress(ticketKey(projectId, ticket.id), null)
                if (ticket.plan_ready) {
                  get()
                    .updateTicket(ticket.id, projectId, { plan_ready: false })
                    .catch(() => {})
                }
                if (ticket.column === 'todo' || ticket.column === 'review') {
                  get()
                    .moveTicket(ticket.id, projectId, 'in_progress', topOfColumnSortOrder(get, projectId, 'in_progress'))
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
      },

      // ── completion verdicts (transient) ─────────────────────────────
      setCompletionVerdict: (key: TicketKey, verdict: StoredCompletionVerdict) => {
        set((state) => {
          const next = new Map(state.completionVerdicts)
          next.set(key, verdict)
          return { completionVerdicts: next }
        })
      },

      clearCompletionVerdict: (key: TicketKey) => {
        set((state) => {
          if (!state.completionVerdicts.has(key)) return state
          const next = new Map(state.completionVerdicts)
          next.delete(key)
          return { completionVerdicts: next }
        })
      },

      setVerifyProgress: (key: TicketKey, progress: VerifyProgress | null) => {
        set((state) => {
          if (progress === null && !state.verifyProgress.has(key)) return state
          const next = new Map(state.verifyProgress)
          if (progress === null) next.delete(key)
          else next.set(key, progress)
          return { verifyProgress: next }
        })
      },

      // Manual "Verify completion" — runs the Watcher (Gate 2) on demand, ignoring
      // the per-session idempotency cache (forces a fresh model call). Like the
      // automatic pipeline it confirms the session is frozen FIRST (Strict Review
      // rule): a session still working is still In Progress, so it is bounced there
      // without a model call. Stores the verdict and bounces the ticket back to In
      // Progress when the Watcher then judges it incomplete or asking the user.
      recheckTicketCompletion: async (ticketId: string, projectId: string) => {
        const ticket = (get().tickets.get(projectId) ?? []).find((t) => t.id === ticketId)
        if (!ticket) return null
        const sessionId = ticket.current_session_id
        if (!sessionId) return null

        // A manual recheck supersedes any in-flight automatic countdown — cancel
        // pending timers so the auto pass can't fire a redundant judge after this
        // one. The rescue budget (rescueAttempts) is intentionally preserved.
        cancelAll(ticketKey(projectId, ticketId))

        // Strict Review rule: confirm the session is frozen BEFORE judging with AI.
        // No settle window exists here, so liveness (session status) is the signal:
        // a session still actively working is still In Progress — bounce it there
        // (when in Review) without spending a model call.
        if ((await confirmSessionFrozen(sessionId)) === 'active') {
          if (ticket.column === 'review') {
            await moveTicketBackToInProgress(get, ticketId, projectId)
          }
          return null
        }

        const { useSettingsStore } = await import('./useSettingsStore')
        const settings = useSettingsStore.getState()
        const threshold = settings.kanbanStrictVerifyConfidenceThreshold ?? 0.6

        let result
        try {
          const { completionApi } = await import('@/api/completion-api')
          result = await completionApi.detectTicketCompletion({
            sessionId,
            ticketId,
            maxChars: settings.kanbanStrictVerifyChars,
            provider: settings.kanbanStrictVerifyProvider,
            model: settings.kanbanStrictVerifyModel || undefined,
            systemPrompt: settings.kanbanStrictVerifyPrompt || undefined
          })
        } catch (err) {
          // No fail-open: surface + log, leave the ticket where it is.
          reportStrictVerifyError(get, ticketId, projectId, ticket, err)
          return null
        }
        if (!result.success || !result.verdict) {
          reportStrictVerifyError(get, ticketId, projectId, ticket, result.error)
          return null
        }

        const verdict = result.verdict
        const incomplete = !verdict.complete || verdict.confidence < threshold || verdict.needsInput
        const stored: StoredCompletionVerdict = {
          ...verdict,
          sessionId,
          checkedAt: Date.now(),
          movedBack: incomplete
        }
        get().setCompletionVerdict(ticketKey(projectId, ticketId), stored)
        if (incomplete && ticket.column === 'review') {
          await moveTicketBackToInProgress(get, ticketId, projectId)
          maybeArmRescueAfterBounce(
            get,
            ticketId,
            projectId,
            sessionId,
            verdict.needsInput,
            settings
          )
        } else if (!incomplete) {
          // Verified complete via a manual check. Queue prompts takes precedence:
          // if a follow-up was queued, entering it moves the ticket back to In
          // Progress — stop there. Otherwise hand off to Feature B exactly like
          // the automatic pass: an auto-approve ticket sitting in Review is
          // committed and (if a chain) advanced to Done. Without this, a manual
          // "Verify with AI" that passed stored the verdict but never committed
          // or advanced — the ticket just sat in Review.
          const dispatched = await maybeDispatchClaudeCliQueue(get, projectId, ticketId)
          if (!dispatched && ticket.column === 'review' && ticket.auto_approve_review) {
            await finalizeReviewBypass(
              get,
              ticketId,
              projectId,
              ticket,
              settings.kanbanAutoCommitOnReview
            )
          }
        }
        return stored
      },

      addQueuedPrompt: (
        projectId: string,
        ticketId: string,
        content: string,
        attachments?: QueuedAttachment[]
      ): void => {
        const text = content.trim()
        // An attachment-only prompt (e.g. just an image) is valid — only bail
        // when there's nothing at all to send.
        if (!text && !attachments?.length) return
        const key = ticketKey(projectId, ticketId)
        set((state) => {
          const next = { ...state.promptQueues }
          const entry: QueuedPrompt = { id: crypto.randomUUID(), content: text }
          if (attachments?.length) entry.attachments = attachments
          next[key] = [...(next[key] ?? []), entry]
          return { promptQueues: next }
        })
      },

      updateQueuedPrompt: (
        projectId: string,
        ticketId: string,
        promptId: string,
        content: string,
        attachments?: QueuedAttachment[]
      ): void => {
        const text = content.trim()
        const key = ticketKey(projectId, ticketId)
        set((state) => {
          const list = state.promptQueues[key]
          if (!list) return {}
          const target = list.find((p) => p.id === promptId)
          if (!target) return {}
          // Keep existing attachments unless the caller passed a new set.
          const nextAttachments = attachments ?? target.attachments
          const hasAttachments = !!nextAttachments?.length
          // Removing the text of an attachment-less prompt drops it; a prompt
          // that still has attachments survives even with empty text.
          const updated =
            !text && !hasAttachments
              ? list.filter((p) => p.id !== promptId)
              : list.map((p) =>
                  p.id === promptId
                    ? {
                        ...p,
                        content: text,
                        ...(hasAttachments
                          ? { attachments: nextAttachments }
                          : { attachments: undefined })
                      }
                    : p
                )
          const next = { ...state.promptQueues }
          if (updated.length === 0) delete next[key]
          else next[key] = updated
          return { promptQueues: next }
        })
      },

      removeQueuedPrompt: (projectId: string, ticketId: string, promptId: string): void => {
        const key = ticketKey(projectId, ticketId)
        set((state) => {
          const list = state.promptQueues[key]
          if (!list) return {}
          const updated = list.filter((p) => p.id !== promptId)
          const next = { ...state.promptQueues }
          if (updated.length === 0) delete next[key]
          else next[key] = updated
          return { promptQueues: next }
        })
      },

      moveQueuedPrompt: (
        projectId: string,
        ticketId: string,
        promptId: string,
        direction: 'up' | 'down'
      ): void => {
        const key = ticketKey(projectId, ticketId)
        set((state) => {
          const list = state.promptQueues[key]
          if (!list) return {}
          const i = list.findIndex((p) => p.id === promptId)
          if (i < 0) return {}
          const j = direction === 'up' ? i - 1 : i + 1
          if (j < 0 || j >= list.length) return {}
          const updated = [...list]
          ;[updated[i], updated[j]] = [updated[j], updated[i]]
          return { promptQueues: { ...state.promptQueues, [key]: updated } }
        })
      },

      clearQueuedPrompts: (projectId: string, ticketId: string): void => {
        const key = ticketKey(projectId, ticketId)
        set((state) => {
          if (!state.promptQueues[key]) return {}
          const next = { ...state.promptQueues }
          delete next[key]
          return { promptQueues: next }
        })
      },

      startClaudeCliFollowup: async (
        projectId: string,
        ticketId: string,
        prompt: string,
        attachments?: QueuedAttachment[]
      ): Promise<boolean> => {
        const text = prompt.trim()
        if (!text && !attachments?.length) return false
        const current = (get().tickets.get(projectId) ?? []).find((t) => t.id === ticketId)
        const sessionId = current?.current_session_id
        if (!current || !sessionId) return false

        // Move to In Progress (top) immediately for responsive UI; the resulting
        // `session_working` event would do this too, but only after the async send.
        if (current.column !== 'in_progress') {
          const inProgress = get().getTicketsByColumn(projectId, 'in_progress')
          const sortOrder = get().computeSortOrder(inProgress, 0)
          await get().moveTicket(ticketId, projectId, 'in_progress', sortOrder).catch(() => {})
        }
        const { dispatchClaudeCliFollowup } = await import('@/lib/claude-cli-followup')
        return dispatchClaudeCliFollowup(sessionId, buildQueuedPromptText(text, attachments))
      },

      dispatchClaudeCliQueueIfReady: async (
        projectId: string,
        ticketId: string
      ): Promise<boolean> => {
        return maybeDispatchClaudeCliQueue(get, projectId, ticketId)
      }
    }),
    {
      name: 'hive-kanban',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        isBoardViewActive: state.isBoardViewActive,
        isPinnedBoardActive: state.isPinnedBoardActive,
        simpleModeByProject: state.simpleModeByProject,
        promptQueues: state.promptQueues
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

  // Defense-in-depth: never bind a session that another ticket already owns. A
  // ticket-launch flow (auto-launch / worktree picker) binds its own ticket and
  // passes skipKanbanAutoAttach, so this callback only runs for sessions started
  // outside a ticket (sidebar / session view). The guard still matters because
  // several tickets can share one worktree (speckit reuses one worktree per spec),
  // and binding a second ticket to one current_session_id cross-wires both — the
  // ticket detail then opens the wrong terminal and a sibling rides session events.
  if (isSessionOwnedByAnotherTicket(useKanbanStore.getState().tickets, sessionId, '')) return

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
