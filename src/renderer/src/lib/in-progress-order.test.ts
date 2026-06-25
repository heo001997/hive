import { describe, test, expect } from 'vitest'
import { orderInProgressTickets } from './in-progress-order'
import type { KanbanTicket } from '../../../main/db/types'

// Minimal ticket factory — only the fields the predicate/ordering touch matter.
function ticket(id: string, sortOrder: number, sessionId: string | null = null): KanbanTicket {
  return {
    id,
    sort_order: sortOrder,
    current_session_id: sessionId
  } as unknown as KanbanTicket
}

const isRunning = (t: KanbanTicket): boolean => t.current_session_id !== null

describe('orderInProgressTickets', () => {
  test('lifts the running task to the top, keeping the rest in order', () => {
    const tickets = [
      ticket('a', 1), // queued (chain parent slot)
      ticket('b', 2, 'sess-b'), // running
      ticket('c', 3) // queued
    ]
    expect(orderInProgressTickets(tickets, isRunning).map((t) => t.id)).toEqual(['b', 'a', 'c'])
  })

  test('preserves chain order among the non-running tickets', () => {
    const tickets = [ticket('a', 1, 'sess-a'), ticket('b', 2), ticket('c', 3), ticket('d', 4)]
    // a is running → stays on top; b, c, d keep their first→last order.
    expect(orderInProgressTickets(tickets, isRunning).map((t) => t.id)).toEqual([
      'a',
      'b',
      'c',
      'd'
    ])
  })

  test('floats multiple running tasks above the queued ones, each group stable', () => {
    const tickets = [
      ticket('a', 1),
      ticket('b', 2, 'sess-b'),
      ticket('c', 3),
      ticket('d', 4, 'sess-d')
    ]
    expect(orderInProgressTickets(tickets, isRunning).map((t) => t.id)).toEqual([
      'b',
      'd',
      'a',
      'c'
    ])
  })

  test('returns the same reference when nothing is running', () => {
    const tickets = [ticket('a', 1), ticket('b', 2)]
    expect(orderInProgressTickets(tickets, isRunning)).toBe(tickets)
  })

  test('returns the same reference when everything is running', () => {
    const tickets = [ticket('a', 1, 'sess-a'), ticket('b', 2, 'sess-b')]
    expect(orderInProgressTickets(tickets, isRunning)).toBe(tickets)
  })

  test('handles an empty column', () => {
    expect(orderInProgressTickets([], isRunning)).toEqual([])
  })
})
