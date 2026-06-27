import { describe, expect, it } from 'vitest'
import { MAX_PET_TICKETS } from '@shared/types/pet'
import type { SessionStatusEntry, SessionStatusType } from '@/stores/useWorktreeStatusStore'
import { computePetTickets, type PetTicketInput } from '../pet-status-aggregator'

function ticket(overrides: Partial<PetTicketInput> & { id: string }): PetTicketInput {
  return {
    project_id: 'proj',
    worktree_id: 'wt',
    current_session_id: `${overrides.id}-sess`,
    column: 'in_progress',
    title: overrides.id,
    archived_at: null,
    ...overrides
  }
}

function status(type: SessionStatusType): SessionStatusEntry {
  return { status: type, timestamp: 0 }
}

describe('computePetTickets', () => {
  it('gives every started in-progress ticket a working pet, even between turns', () => {
    // Three running tickets parked between agent turns (status completed/unread)
    // must each keep their pet — this is the "3 in-progress, 1 pet" regression.
    const tickets = [
      ticket({ id: 'a', current_session_id: 'sa' }),
      ticket({ id: 'b', current_session_id: 'sb' }),
      ticket({ id: 'c', current_session_id: 'sc' })
    ]
    const pets = computePetTickets({
      tickets,
      sessionStatuses: { sa: status('completed'), sb: status('unread'), sc: null },
      pendingQuestionCountBySession: new Map()
    })
    expect(pets.map((p) => p.ticketId)).toEqual(['a', 'b', 'c'])
    expect(pets.every((p) => p.state === 'working')).toBe(true)
  })

  it('does not give a pet to an in-progress ticket that never ran', () => {
    const pets = computePetTickets({
      tickets: [ticket({ id: 'a', current_session_id: null })],
      sessionStatuses: {},
      pendingQuestionCountBySession: new Map()
    })
    expect(pets).toHaveLength(0)
  })

  it('skips todo / done / archived tickets', () => {
    const tickets = [
      ticket({ id: 'todo', column: 'todo' }),
      ticket({ id: 'done', column: 'done' }),
      ticket({ id: 'arch', archived_at: '2026-01-01' })
    ]
    const pets = computePetTickets({
      tickets,
      sessionStatuses: {},
      pendingQuestionCountBySession: new Map()
    })
    expect(pets).toHaveLength(0)
  })

  it('surfaces a Review-column ticket as a question pet', () => {
    const pets = computePetTickets({
      tickets: [ticket({ id: 'r', column: 'review', current_session_id: null })],
      sessionStatuses: {},
      pendingQuestionCountBySession: new Map()
    })
    expect(pets).toEqual([
      expect.objectContaining({ ticketId: 'r', state: 'question' })
    ])
  })

  it('ranks needs-attention pets ahead of running pets', () => {
    const tickets = [
      ticket({ id: 'run', current_session_id: 'srun' }),
      ticket({ id: 'ask', current_session_id: 'sask' }),
      ticket({ id: 'perm', current_session_id: 'sperm' })
    ]
    const pets = computePetTickets({
      tickets,
      sessionStatuses: {
        srun: status('working'),
        sask: status('answering'),
        sperm: status('permission')
      },
      pendingQuestionCountBySession: new Map()
    })
    expect(pets.map((p) => [p.ticketId, p.state])).toEqual([
      ['ask', 'question'],
      ['perm', 'permission'],
      ['run', 'working']
    ])
  })

  it('treats a pending question as a question pet regardless of session status', () => {
    const pets = computePetTickets({
      tickets: [ticket({ id: 'q', current_session_id: 'sq' })],
      sessionStatuses: { sq: status('working') },
      pendingQuestionCountBySession: new Map([['sq', 2]])
    })
    expect(pets[0]).toMatchObject({ ticketId: 'q', state: 'question' })
  })

  it('caps the pet list at MAX_PET_TICKETS', () => {
    const tickets = Array.from({ length: MAX_PET_TICKETS + 5 }, (_, i) =>
      ticket({ id: `t${i}`, current_session_id: `s${i}` })
    )
    const sessionStatuses: Record<string, SessionStatusEntry | null> = {}
    tickets.forEach((t) => {
      if (t.current_session_id) sessionStatuses[t.current_session_id] = status('working')
    })
    const pets = computePetTickets({
      tickets,
      sessionStatuses,
      pendingQuestionCountBySession: new Map()
    })
    expect(pets).toHaveLength(MAX_PET_TICKETS)
  })
})
