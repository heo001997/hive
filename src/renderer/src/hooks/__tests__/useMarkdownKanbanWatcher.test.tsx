import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Regression guard for the launch-trigger relocation (ticket 2822 class): launch is
// now owned app-wide by useKanbanStore.initializeAutoLaunch(), NOT by this view hook.
// A KANBAN_TICKETS_CREATED handler here would be board-scoped (the bug) and would
// double-reload. These tests lock the hook to board-visibility concerns only.

type ChangedEvent = { projectId: string; paths: string[]; eventTypes: string[] }

const api = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue({ success: true }),
  stop: vi.fn().mockResolvedValue({ success: true }),
  onChanged: vi.fn<(cb: (e: ChangedEvent) => void) => () => void>(() => vi.fn()),
  onTicketsCreated: vi.fn<(cb: (e: unknown) => void) => () => void>(() => vi.fn())
}))

vi.mock('@/api/kanban-api', () => ({
  kanbanApi: {
    watch: {
      start: api.start,
      stop: api.stop,
      onChanged: api.onChanged,
      onTicketsCreated: api.onTicketsCreated
    }
  }
}))

const wc = vi.hoisted(() => ({ launchReadyCreatedTickets: vi.fn() }))
vi.mock('@/lib/worktree-concurrency', () => ({
  launchReadyCreatedTickets: wc.launchReadyCreatedTickets
}))

import { useMarkdownKanbanWatcher } from '../useMarkdownKanbanWatcher'

beforeEach(() => {
  vi.clearAllMocks()
  api.start.mockResolvedValue({ success: true })
  api.stop.mockResolvedValue({ success: true })
  api.onChanged.mockReturnValue(vi.fn())
  api.onTicketsCreated.mockReturnValue(vi.fn())
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useMarkdownKanbanWatcher', () => {
  it('never subscribes to or acts on KANBAN_TICKETS_CREATED (launch relocated out of the view)', () => {
    renderHook(() => useMarkdownKanbanWatcher(['p1'], vi.fn()))
    expect(api.onTicketsCreated).not.toHaveBeenCalled()
    expect(wc.launchReadyCreatedTickets).not.toHaveBeenCalled()
  })

  it('still reloads a watched project on an on-disk change', () => {
    let changedCb: ((e: { projectId: string; paths: string[]; eventTypes: string[] }) => void) | undefined
    api.onChanged.mockImplementation((cb) => {
      changedCb = cb
      return vi.fn()
    })
    const reload = vi.fn()

    renderHook(() => useMarkdownKanbanWatcher(['p1'], reload))
    expect(api.onChanged).toHaveBeenCalledTimes(1)

    act(() => {
      changedCb?.({ projectId: 'p1', paths: ['/tmp/p1/ticket.md'], eventTypes: ['change'] })
    })
    expect(reload).toHaveBeenCalledWith('p1')
  })

  it('ignores on-disk changes for a project it is not watching', () => {
    let changedCb: ((e: { projectId: string; paths: string[]; eventTypes: string[] }) => void) | undefined
    api.onChanged.mockImplementation((cb) => {
      changedCb = cb
      return vi.fn()
    })
    const reload = vi.fn()

    renderHook(() => useMarkdownKanbanWatcher(['p1'], reload))
    act(() => {
      changedCb?.({ projectId: 'other', paths: [], eventTypes: ['change'] })
    })
    expect(reload).not.toHaveBeenCalled()
  })
})
