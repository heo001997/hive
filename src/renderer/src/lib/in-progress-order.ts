import type { KanbanTicket } from '../../../main/db/types'

/**
 * Reorders the In Progress column for display so the task that is actually
 * running — has a live session and is not blocked — floats to the top, while
 * preserving the underlying order within each group.
 *
 * The input is expected to already be sorted by `sort_order` (which encodes the
 * chain's "first task → last task" order set when a chain is moved in). This
 * only lifts the running task(s) above the queued/blocked ones; it does not
 * otherwise reshuffle the column.
 */
export function orderInProgressTickets(
  tickets: KanbanTicket[],
  isRunningNotBlocked: (ticket: KanbanTicket) => boolean
): KanbanTicket[] {
  const running: KanbanTicket[] = []
  const rest: KanbanTicket[] = []
  for (const ticket of tickets) {
    if (isRunningNotBlocked(ticket)) running.push(ticket)
    else rest.push(ticket)
  }
  // Nothing to lift — return the original reference to avoid needless churn.
  if (running.length === 0 || rest.length === 0) return tickets
  return [...running, ...rest]
}
