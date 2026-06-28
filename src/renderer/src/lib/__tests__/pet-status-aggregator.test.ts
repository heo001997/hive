import { describe, expect, it } from 'vitest'
import { MAX_PET_TICKETS } from '@shared/types/pet'
import type { StoredCompletionVerdict } from '@shared/types/completion'
import type { SessionStatusEntry, SessionStatusType } from '@/stores/useWorktreeStatusStore'
import { computePetTickets, petVerdictKey, type PetTicketInput } from '../pet-status-aggregator'

function ticket(overrides: Partial<PetTicketInput> & { id: string }): PetTicketInput {
  return {
    project_id: 'proj',
    worktree_id: 'wt',
    current_session_id: `${overrides.id}-sess`,
    column: 'in_progress',
    title: overrides.id,
    archived_at: null,
    review_seen_at: null,
    ...overrides
  }
}

function status(type: SessionStatusType): SessionStatusEntry {
  return { status: type, timestamp: 0 }
}

function verdict(overrides: Partial<StoredCompletionVerdict> & { sessionId: string }): StoredCompletionVerdict {
  return {
    complete: true,
    needsInput: false,
    confidence: 0.9,
    reason: 'ok',
    checkedAt: 0,
    movedBack: false,
    ...overrides
  }
}

/** Build the per-ticket verdict map the aggregator reads, keyed for `t`. */
function verdicts(t: PetTicketInput, v: StoredCompletionVerdict): Map<string, StoredCompletionVerdict> {
  return new Map([[petVerdictKey(t.project_id, t.id), v]])
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

  it('surfaces an unopened Review-column ticket as a question pet', () => {
    const pets = computePetTickets({
      tickets: [
        ticket({ id: 'r', column: 'review', current_session_id: null, review_seen_at: null })
      ],
      sessionStatuses: {},
      pendingQuestionCountBySession: new Map()
    })
    expect(pets).toEqual([
      expect.objectContaining({ ticketId: 'r', state: 'question' })
    ])
  })

  it('does not give a pet to a Review ticket the user has already opened', () => {
    const pets = computePetTickets({
      tickets: [
        ticket({
          id: 'r',
          column: 'review',
          current_session_id: null,
          review_seen_at: '2026-06-28T00:00:00.000Z'
        })
      ],
      sessionStatuses: {},
      pendingQuestionCountBySession: new Map()
    })
    expect(pets).toHaveLength(0)
  })

  it('drops the pet for an unopened Review ticket that PASSED Strict Verify', () => {
    // complete && !movedBack for the current session = AI-confirmed done; it
    // auto-advances or awaits a merge, so it should not nag as a question.
    const t = ticket({ id: 'r', column: 'review', current_session_id: 'sr', review_seen_at: null })
    const pets = computePetTickets({
      tickets: [t],
      sessionStatuses: { sr: status('completed') },
      pendingQuestionCountBySession: new Map(),
      completionVerdicts: verdicts(t, verdict({ sessionId: 'sr', complete: true, movedBack: false }))
    })
    expect(pets).toHaveLength(0)
  })

  it('keeps the question pet for an unopened Review ticket whose verdict did NOT pass', () => {
    // movedBack verdict = bounced / not confirmed → still needs a human look.
    const t = ticket({ id: 'r', column: 'review', current_session_id: 'sr', review_seen_at: null })
    const pets = computePetTickets({
      tickets: [t],
      sessionStatuses: { sr: status('completed') },
      pendingQuestionCountBySession: new Map(),
      completionVerdicts: verdicts(
        t,
        verdict({ sessionId: 'sr', complete: false, movedBack: true })
      )
    })
    expect(pets[0]).toMatchObject({ ticketId: 'r', state: 'question' })
  })

  it('ignores a passing verdict left over from a different session', () => {
    // The verdict judged an old session; the ticket now points at a new one, so
    // the pass must not hide the still-unverified Review ticket.
    const t = ticket({ id: 'r', column: 'review', current_session_id: 'new', review_seen_at: null })
    const pets = computePetTickets({
      tickets: [t],
      sessionStatuses: {},
      pendingQuestionCountBySession: new Map(),
      completionVerdicts: verdicts(t, verdict({ sessionId: 'old', complete: true, movedBack: false }))
    })
    expect(pets[0]).toMatchObject({ ticketId: 'r', state: 'question' })
  })

  it('raises a question pet for a needsInput verdict on an In Progress ticket', () => {
    // A "waiting on you" verdict bounces the ticket to In Progress (movedBack).
    // Without the verdict it would read as a plain working pet — wire it through.
    const t = ticket({ id: 'w', column: 'in_progress', current_session_id: 'sw' })
    const pets = computePetTickets({
      tickets: [t],
      sessionStatuses: { sw: status('completed') },
      pendingQuestionCountBySession: new Map(),
      completionVerdicts: verdicts(
        t,
        verdict({ sessionId: 'sw', complete: false, needsInput: true, movedBack: true })
      )
    })
    expect(pets[0]).toMatchObject({ ticketId: 'w', state: 'question' })
  })

  it('keeps a question pet for an opened Review ticket that still needs an answer', () => {
    // review_seen_at is set, but the session is actively asking — needs-input
    // wins over the "already seen" gate.
    const pets = computePetTickets({
      tickets: [
        ticket({
          id: 'r',
          column: 'review',
          current_session_id: 'sr',
          review_seen_at: '2026-06-28T00:00:00.000Z'
        })
      ],
      sessionStatuses: { sr: status('answering') },
      pendingQuestionCountBySession: new Map()
    })
    expect(pets[0]).toMatchObject({ ticketId: 'r', state: 'question' })
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
