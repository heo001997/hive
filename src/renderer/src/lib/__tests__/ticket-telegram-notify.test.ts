import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendNotification = vi.fn()
const getSettingsState = vi.fn()
const getKanbanState = vi.fn()

vi.mock('@/api/telegram-api', () => ({
  telegramApi: { sendNotification: (text: string) => sendNotification(text) }
}))
vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: { getState: () => getSettingsState() }
}))
vi.mock('@/stores/useKanbanStore', () => ({
  useKanbanStore: { getState: () => getKanbanState() }
}))

import {
  notifyTicketColumnChange,
  notifyTicketEvent,
  notifyTicketQuestion,
  resetTicketNotifyStateForTests
} from '../ticket-telegram-notify'

const allOn = {
  kanbanTelegramNotifyEnabled: true,
  kanbanTelegramNotifyOnStart: true,
  kanbanTelegramNotifyOnQuestion: true,
  kanbanTelegramNotifyOnStuckReview: true,
  kanbanTelegramNotifyOnDone: true
}

describe('ticket-telegram-notify', () => {
  beforeEach(() => {
    resetTicketNotifyStateForTests()
    sendNotification.mockReset().mockResolvedValue({ ok: true })
    getSettingsState.mockReset().mockReturnValue({ ...allOn })
    getKanbanState.mockReset()
  })

  it('sends a formatted message for an enabled event', async () => {
    await notifyTicketEvent('started', { ticketId: 't-send', title: 'Fix login' })
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(sendNotification.mock.calls[0][0]).toContain('Fix login')
    expect(sendNotification.mock.calls[0][0]).toContain('In Progress')
  })

  it('no-ops when the master toggle is off', async () => {
    getSettingsState.mockReturnValue({ ...allOn, kanbanTelegramNotifyEnabled: false })
    await notifyTicketEvent('done', { ticketId: 't-master', title: 'X' })
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('no-ops when the per-event toggle is off', async () => {
    getSettingsState.mockReturnValue({ ...allOn, kanbanTelegramNotifyOnDone: false })
    await notifyTicketEvent('done', { ticketId: 't-perevent', title: 'X' })
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('dedupes repeat events for the same ticket', async () => {
    await notifyTicketEvent('done', { ticketId: 't-dedupe', title: 'X' })
    await notifyTicketEvent('done', { ticketId: 't-dedupe', title: 'X' })
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })

  it('frees the dedupe slot when delivery reports not-configured so it can retry', async () => {
    sendNotification.mockResolvedValueOnce({ ok: false, error: 'Telegram is not configured' })
    await notifyTicketEvent('started', { ticketId: 't-retry', title: 'X' })
    await notifyTicketEvent('started', { ticketId: 't-retry', title: 'X' })
    expect(sendNotification).toHaveBeenCalledTimes(2)
  })

  it('resolves the ticket owning a session for question events', async () => {
    getKanbanState.mockReturnValue({
      tickets: new Map([
        ['proj-1', [{ id: 't-q', title: 'Add OAuth', current_session_id: 'sess-9' }]]
      ])
    })
    await notifyTicketQuestion('sess-9', 'req-1')
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(sendNotification.mock.calls[0][0]).toContain('Add OAuth')
  })

  it('does not touch the kanban store when the question toggle is off', async () => {
    getSettingsState.mockReturnValue({ ...allOn, kanbanTelegramNotifyOnQuestion: false })
    await notifyTicketQuestion('sess-x', 'req-2')
    expect(getKanbanState).not.toHaveBeenCalled()
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('skips a question for a ticket already in Done', async () => {
    getKanbanState.mockReturnValue({
      tickets: new Map([
        ['proj-1', [{ id: 't-done', title: 'Closed', current_session_id: 'sess-d', column: 'done' }]]
      ])
    })
    await notifyTicketQuestion('sess-d', 'req-3')
    expect(sendNotification).not.toHaveBeenCalled()
  })

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('fires "started" on a Todo → In Progress transition', async () => {
    notifyTicketColumnChange({ ticketId: 't-c1', title: 'Build', prevColumn: 'todo', column: 'in_progress' })
    await flush()
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(sendNotification.mock.calls[0][0]).toContain('In Progress')
  })

  it('does not fire "done" when the prior column is unknown', async () => {
    notifyTicketColumnChange({ ticketId: 't-c2', title: 'X', prevColumn: undefined, column: 'done' })
    await flush()
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('re-notifies "done" after a ticket leaves Done and completes again', async () => {
    notifyTicketColumnChange({ ticketId: 't-c3', title: 'Loop', prevColumn: 'review', column: 'done' })
    await flush()
    expect(sendNotification).toHaveBeenCalledTimes(1)
    // Reopened: leaving Done frees the dedupe slot.
    notifyTicketColumnChange({ ticketId: 't-c3', title: 'Loop', prevColumn: 'done', column: 'in_progress' })
    notifyTicketColumnChange({ ticketId: 't-c3', title: 'Loop', prevColumn: 'review', column: 'done' })
    await flush()
    expect(sendNotification).toHaveBeenCalledTimes(2)
  })
})
