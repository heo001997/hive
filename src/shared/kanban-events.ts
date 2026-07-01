export const MARKDOWN_KANBAN_CHANGED_CHANNEL = 'kanban:markdown:changed'

/**
 * Fired by the server after a `kanban.ticket.createBatch` RPC lands, on ANY
 * backend (DB-backed or markdown). Unlike the markdown file watcher, this covers
 * tickets created out-of-band — e.g. the agent-driven condition-gate fix loop,
 * where a spawned Claude CLI CRUDs the next round's tickets straight into the DB
 * via the `hive-ticket` CLI. The renderer listens so it can reload the affected
 * board AND re-drive the auto-launch queue (a DB create otherwise never reaches
 * the renderer's launcher — the queue would sit forever).
 */
export const KANBAN_TICKETS_CREATED_CHANNEL = 'kanban:tickets:created'

export interface KanbanTicketsCreatedEvent {
  projectId: string
  ticketIds: string[]
}
