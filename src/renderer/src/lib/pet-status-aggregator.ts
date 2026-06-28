import type { PetState, PetStatusPayload, PetTicket } from '@shared/types/pet'
import { MAX_PET_TICKETS } from '@shared/types/pet'
import type { StoredCompletionVerdict } from '@shared/types/completion'
import type { SessionStatusEntry, SessionStatusType } from '@/stores/useWorktreeStatusStore'

const STATUS_PRIORITY: Record<SessionStatusType, number> = {
  answering: 8,
  command_approval: 7,
  permission: 6,
  planning: 5,
  working: 4,
  plan_ready: 3,
  completed: 2,
  unread: 1
}

const PET_STATE_BY_STATUS: Record<SessionStatusType, PetState> = {
  answering: 'question',
  command_approval: 'permission',
  permission: 'permission',
  planning: 'working',
  working: 'working',
  plan_ready: 'plan_ready',
  completed: 'idle',
  unread: 'idle'
}

const WORKING_SESSION_STATUSES = new Set<SessionStatusType>(['working', 'planning'])

type SessionRef = { id: string }
type ConnectionRef = { id: string; members: Array<{ worktree_id: string }> }

export interface PetAggregateInput {
  sessionStatuses: Record<string, SessionStatusEntry | null>
  worktreeSessions: Map<string, SessionRef[]>
  connectionSessions: Map<string, SessionRef[]>
  connections: ConnectionRef[]
}

interface Candidate {
  status: SessionStatusType
  sourceWorktreeId: string | null
  priority: number
}

function bestStatusForSessions(
  sessions: SessionRef[],
  sessionStatuses: Record<string, SessionStatusEntry | null>
): SessionStatusType | null {
  let best: SessionStatusType | null = null

  for (const session of sessions) {
    const status = sessionStatuses[session.id]?.status
    if (!status) continue
    if (!best || STATUS_PRIORITY[status] > STATUS_PRIORITY[best]) {
      best = status
    }
  }

  return best
}

function chooseBetter(current: Candidate | null, next: Candidate): Candidate {
  if (!current) return next
  return next.priority > current.priority ? next : current
}

export function aggregatePetStatus(input: PetAggregateInput): PetStatusPayload {
  let best: Candidate | null = null
  const workingSessionCount = Object.values(input.sessionStatuses).filter((entry) =>
    entry?.status ? WORKING_SESSION_STATUSES.has(entry.status) : false
  ).length

  for (const [worktreeId, sessions] of input.worktreeSessions.entries()) {
    const status = bestStatusForSessions(sessions, input.sessionStatuses)
    if (!status) continue
    best = chooseBetter(best, {
      status,
      sourceWorktreeId: worktreeId,
      priority: STATUS_PRIORITY[status]
    })
  }

  for (const connection of input.connections) {
    const sessions = input.connectionSessions.get(connection.id) ?? []
    const status = bestStatusForSessions(sessions, input.sessionStatuses)
    if (!status) continue
    best = chooseBetter(best, {
      status,
      sourceWorktreeId: connection.members[0]?.worktree_id ?? null,
      priority: STATUS_PRIORITY[status]
    })
  }

  if (!best) return { state: 'idle', sourceWorktreeId: null, workingSessionCount }

  const state = PET_STATE_BY_STATUS[best.status]
  return {
    state,
    sourceWorktreeId: state === 'idle' ? null : best.sourceWorktreeId,
    workingSessionCount
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-ticket pets: one pet per active ticket (running / needs-attention).
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal shape read from a kanban ticket — `KanbanTicket` is a superset of this. */
export interface PetTicketInput {
  id: string
  project_id: string
  worktree_id: string | null
  current_session_id: string | null
  column: 'todo' | 'in_progress' | 'review' | 'done'
  title: string
  archived_at: string | null
  /**
   * ISO timestamp of when the user last opened the ticket while it sat in
   * Review. NULL/undefined means it reached Review but hasn't been opened since.
   */
  review_seen_at?: string | null
}

export interface PetTicketsAggregateInput {
  tickets: PetTicketInput[]
  sessionStatuses: Record<string, SessionStatusEntry | null>
  /** sessionId → number of pending questions awaiting the user. */
  pendingQuestionCountBySession: Map<string, number>
  /**
   * `petVerdictKey(projectId, id)` → the ticket's stored Strict Verify verdict,
   * when one exists. Drives two Review-column gates: a verdict that PASSED
   * (`complete && !movedBack`) drops the "needs review" pet, and a `needsInput`
   * verdict raises a question pet regardless of column (the agent is waiting on
   * the user — these tickets live in In Progress after being bounced back).
   */
  completionVerdicts?: Map<string, StoredCompletionVerdict>
}

/**
 * Key for {@link PetTicketsAggregateInput.completionVerdicts}. A pet-local
 * composite (NOT the store's `ticketKey`, which percent-encodes) so callers and
 * the aggregator agree without coupling to the store.
 */
export function petVerdictKey(projectId: string, ticketId: string): string {
  return `${projectId}:${ticketId}`
}

// Higher number = surfaced first and survives the cap. Mirrors the card's
// attention ordering: needs-input > plan-ready > running.
const PET_TICKET_STATE_PRIORITY: Record<Exclude<PetState, 'idle'>, number> = {
  question: 5,
  permission: 4,
  plan_ready: 3,
  working: 2
}

/**
 * The pet state for a single ticket, or `null` when the ticket should not get a
 * pet (todo, done, archived, or an idle/completed in-progress session).
 */
function ticketPetState(
  ticket: PetTicketInput,
  sessionStatuses: Record<string, SessionStatusEntry | null>,
  pendingQuestionCountBySession: Map<string, number>,
  verdict: StoredCompletionVerdict | null
): Exclude<PetState, 'idle'> | null {
  if (ticket.archived_at || ticket.column === 'done' || ticket.column === 'todo') return null

  const sessionId = ticket.current_session_id
  const status = sessionId ? sessionStatuses[sessionId]?.status : undefined
  const hasPendingQuestions = sessionId
    ? (pendingQuestionCountBySession.get(sessionId) ?? 0) > 0
    : false
  // The verdict only speaks for the session it judged — ignore one left over
  // from a prior session (a resume clears it store-side, but guard anyway).
  const verdictForSession = verdict && verdict.sessionId === sessionId ? verdict : null

  // Needs input — highest attention. Live "answering"/pending questions, OR a
  // Strict Verify verdict that judged the agent to be waiting on the user
  // (`needsInput` bounces the ticket to In Progress, so this fires off-Review).
  if (status === 'answering' || hasPendingQuestions || verdictForSession?.needsInput) {
    return 'question'
  }
  if (status === 'command_approval' || status === 'permission') return 'permission'
  if (status === 'plan_ready') return 'plan_ready'

  // A Review ticket needs a human look UNTIL one of two things clears it: the
  // user opens it (review_seen_at set), or Strict Verify passes it
  // (complete && !movedBack) — a passed ticket is AI-confirmed done and either
  // auto-advances or just awaits a merge, so it shouldn't nag as a question.
  if (ticket.column === 'review') {
    const passedStrictVerify = !!verdictForSession?.complete && !verdictForSession.movedBack
    return ticket.review_seen_at || passedStrictVerify ? null : 'question'
  }

  // Any started ticket in the In Progress column is "running" — including the
  // idle gap between agent turns (status completed/unread), when the session
  // still exists but isn't emitting. Without this, parked-but-running tickets
  // silently lose their pet, so N in-progress tickets collapse to one.
  if (ticket.column === 'in_progress' && sessionId) return 'working'

  // Safety net: a working/planning session in any other column.
  if (status === 'working' || status === 'planning') return 'working'

  return null
}

/**
 * Build the list of per-ticket pets: one pet for every running or
 * needs-attention ticket, sorted by attention priority (stable within a
 * priority by source order) and capped to `MAX_PET_TICKETS`.
 */
export function computePetTickets(input: PetTicketsAggregateInput): PetTicket[] {
  const ranked: Array<{ pet: PetTicket; priority: number; order: number }> = []

  input.tickets.forEach((ticket, order) => {
    const verdict =
      input.completionVerdicts?.get(petVerdictKey(ticket.project_id, ticket.id)) ?? null
    const state = ticketPetState(
      ticket,
      input.sessionStatuses,
      input.pendingQuestionCountBySession,
      verdict
    )
    if (!state) return
    ranked.push({
      pet: {
        ticketId: ticket.id,
        projectId: ticket.project_id,
        worktreeId: ticket.worktree_id,
        state,
        title: ticket.title
      },
      priority: PET_TICKET_STATE_PRIORITY[state],
      order
    })
  })

  ranked.sort((a, b) => b.priority - a.priority || a.order - b.order)
  return ranked.slice(0, MAX_PET_TICKETS).map((entry) => entry.pet)
}
