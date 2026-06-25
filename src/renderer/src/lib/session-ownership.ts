import type { KanbanTicket } from '../../../main/db/types'

/**
 * True when a ticket OTHER than `selfTicketId` already references `sessionId` as its
 * current session.
 *
 * Binding a second ticket to the same `current_session_id` makes session lifecycle
 * events (session_completed / session_error) drive BOTH tickets at once — e.g. a
 * blocked or queued sibling rides the running ticket into Review. The worktree picker
 * uses this to attach the worktree only (not the session) when the session is already
 * owned, so the second ticket gets its own session when it eventually launches.
 */
export function isSessionOwnedByAnotherTicket(
  ticketsByProject: Map<string, KanbanTicket[]>,
  sessionId: string,
  selfTicketId: string
): boolean {
  for (const tickets of ticketsByProject.values()) {
    for (const t of tickets) {
      if (t.id !== selfTicketId && t.current_session_id === sessionId) return true
    }
  }
  return false
}
