import { afterEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../useSessionStore'

const initialSessionState = useSessionStore.getState()

describe('useSessionStore ticket active view (ticket-detail tab strip)', () => {
  afterEach(() => {
    useSessionStore.setState(initialSessionState, true)
  })

  it('records the viewed session per ticket', () => {
    const store = useSessionStore.getState()

    store.setTicketActiveView('ticket-1', 'session-a')
    store.setTicketActiveView('ticket-2', 'session-b')

    expect(useSessionStore.getState().activeViewByTicket).toEqual({
      'ticket-1': 'session-a',
      'ticket-2': 'session-b'
    })
  })

  it('overwrites the viewed session when a different tab is selected', () => {
    const store = useSessionStore.getState()

    store.setTicketActiveView('ticket-1', 'session-a')
    store.setTicketActiveView('ticket-1', 'session-c')

    expect(useSessionStore.getState().activeViewByTicket).toEqual({
      'ticket-1': 'session-c'
    })
  })

  it('clears the entry when the viewed session is null (e.g. last session closed)', () => {
    const store = useSessionStore.getState()

    store.setTicketActiveView('ticket-1', 'session-a')
    store.setTicketActiveView('ticket-2', 'session-b')
    store.setTicketActiveView('ticket-1', null)

    expect(useSessionStore.getState().activeViewByTicket).toEqual({
      'ticket-2': 'session-b'
    })
    expect('ticket-1' in useSessionStore.getState().activeViewByTicket).toBe(false)
  })

  it('does not touch the primary active session (view is independent)', () => {
    const store = useSessionStore.getState()
    const activeBefore = useSessionStore.getState().activeSessionId

    store.setTicketActiveView('ticket-1', 'session-a')

    // Switching the ticket-detail view must never change the global/primary active session.
    expect(useSessionStore.getState().activeSessionId).toBe(activeBefore)
  })
})
