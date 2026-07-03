import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '@shared/rpc/protocol'
import { KANBAN_TICKETS_CREATED_CHANNEL } from '../../shared/kanban-events'
import type { EventBus } from '../events/event-bus'
import { makeKanbanRpcHandlers, type KanbanRpcService } from '../rpc/domains/kanban'
import type { KanbanTicket } from '../../main/db'

// The handler enumerates projects via getDatabase().getAllProjects(); mock the native
// db module so this suite runs without better-sqlite3.
const dbMocks = vi.hoisted(() => ({ getAllProjects: vi.fn() }))
vi.mock('../../main/db', () => ({
  getDatabase: () => ({ getAllProjects: dbMocks.getAllProjects })
}))

function ticket(overrides: Partial<KanbanTicket>): KanbanTicket {
  return {
    id: 't',
    column: 'todo',
    archived_at: null,
    pending_launch_config: null,
    ...overrides
  } as unknown as KanbanTicket
}

/** An EventBus that records everything published, so we can assert the replay emits. */
function makeRecordingBus(): { bus: EventBus; published: ServerEvent[] } {
  const published: ServerEvent[] = []
  const bus: EventBus = {
    publish: (event) =>
      Effect.sync(() => {
        published.push(event)
      }),
    subscribe: () => Effect.sync(() => () => {}),
    subscribeAll: () => Effect.sync(() => () => {})
  }
  return { bus, published }
}

const QUEUED = JSON.stringify({ worktree: { type: 'new' }, prompt: 'x' })

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('kanban.autoLaunch.replayPending', () => {
  it('re-emits KANBAN_TICKETS_CREATED once per project with a pending-launch backlog, and never for empty ones', async () => {
    dbMocks.getAllProjects.mockReturnValue([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }])

    const ticketsByProject: Record<string, KanbanTicket[]> = {
      // p1: one eligible + noise that must be filtered out.
      p1: [
        ticket({ id: 'match', pending_launch_config: QUEUED }),
        ticket({ id: 'done-skip', column: 'done', pending_launch_config: QUEUED }),
        ticket({ id: 'archived-skip', pending_launch_config: QUEUED, archived_at: '2026-01-01T00:00:00.000Z' }),
        ticket({ id: 'no-config', pending_launch_config: null })
      ],
      // p2: no eligible tickets → no publish.
      p2: [ticket({ id: 'plain', pending_launch_config: null })],
      // p3: two eligible.
      p3: [
        ticket({ id: 'a', pending_launch_config: QUEUED }),
        ticket({ id: 'b', pending_launch_config: QUEUED })
      ]
    }

    const getTicketsByProject = vi.fn((projectId: string) =>
      Effect.succeed(ticketsByProject[projectId] ?? [])
    )
    const service = { getTicketsByProject } as unknown as KanbanRpcService
    const handler = makeKanbanRpcHandlers(service).get('kanban.autoLaunch.replayPending')
    expect(handler).toBeDefined()

    const { bus, published } = makeRecordingBus()
    await Effect.runPromise(handler!({}, { eventBus: bus }) as Effect.Effect<unknown>)

    // Backend-agnostic, non-archived list per project.
    expect(getTicketsByProject).toHaveBeenCalledWith('p1', false)
    expect(getTicketsByProject).toHaveBeenCalledWith('p2', false)
    expect(getTicketsByProject).toHaveBeenCalledWith('p3', false)

    // One publish for p1 and p3; none for p2.
    expect(published).toHaveLength(2)
    expect(published).toContainEqual({
      channel: KANBAN_TICKETS_CREATED_CHANNEL,
      payload: { projectId: 'p1', ticketIds: ['match'] }
    })
    expect(published).toContainEqual({
      channel: KANBAN_TICKETS_CREATED_CHANNEL,
      payload: { projectId: 'p3', ticketIds: ['a', 'b'] }
    })
    expect(published.some((e) => (e.payload as { projectId: string }).projectId === 'p2')).toBe(false)
  })

  it('publishes nothing when no project has a backlog', async () => {
    dbMocks.getAllProjects.mockReturnValue([{ id: 'p1' }])
    const getTicketsByProject = vi.fn(() => Effect.succeed([ticket({ pending_launch_config: null })]))
    const service = { getTicketsByProject } as unknown as KanbanRpcService
    const handler = makeKanbanRpcHandlers(service).get('kanban.autoLaunch.replayPending')

    const { bus, published } = makeRecordingBus()
    await Effect.runPromise(handler!({}, { eventBus: bus }) as Effect.Effect<unknown>)

    expect(published).toHaveLength(0)
  })
})
