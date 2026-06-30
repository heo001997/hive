import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendNotification = vi.fn()
const startForwarding = vi.fn()
const setStatus = vi.fn()
const getSettingsState = vi.fn()
const getKanbanState = vi.fn()
const getTelegramState = vi.fn()

vi.mock('@/api/telegram-api', () => ({
  telegramApi: {
    sendNotification: (text: string) => sendNotification(text),
    startForwarding: (params: unknown) => startForwarding(params)
  }
}))
vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: { getState: () => getSettingsState() }
}))
vi.mock('@/stores/useKanbanStore', () => ({
  useKanbanStore: { getState: () => getKanbanState() }
}))
vi.mock('@/stores/useTelegramStore', () => ({
  useTelegramStore: { getState: () => getTelegramState() }
}))

import {
  autoForwardTicketForUserAction,
  notifyTicketColumnChange,
  notifyTicketEvent,
  notifyTicketQuestion,
  resetTicketNotifyStateForTests
} from '../ticket-telegram-notify'

const allOn = {
  kanbanTelegramNotifyEnabled: true,
  kanbanTelegramNotifyOnStart: true,
  kanbanTelegramNotifyOnQuestion: true,
  kanbanTelegramNotifyOnReview: true,
  kanbanTelegramNotifyOnStuckReview: true,
  kanbanTelegramNotifyOnDone: true
}
const autoOn = { ...allOn, kanbanTelegramAutoForwardOnUserAction: true }

describe('ticket-telegram-notify', () => {
  beforeEach(() => {
    resetTicketNotifyStateForTests()
    sendNotification.mockReset().mockResolvedValue({ ok: true })
    startForwarding.mockReset().mockResolvedValue({ ok: true, status: { active: true } })
    setStatus.mockReset()
    getSettingsState.mockReset().mockReturnValue({ ...allOn })
    getKanbanState.mockReset()
    getTelegramState.mockReset().mockReturnValue({ activeForwardingSessionId: null, setStatus })
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

  it('fires "review" on a genuine transition into Review', async () => {
    notifyTicketColumnChange({ ticketId: 't-r1', title: 'Ship it', prevColumn: 'in_progress', column: 'review' })
    await flush()
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(sendNotification.mock.calls[0][0]).toContain('Review')
    expect(sendNotification.mock.calls[0][0]).toContain('Ship it')
  })

  it('does not fire "review" when the prior column is unknown (already in Review on load)', async () => {
    notifyTicketColumnChange({ ticketId: 't-r2', title: 'X', prevColumn: undefined, column: 'review' })
    await flush()
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('fires "review" only once across review↔fix iterate-loop bounces', async () => {
    // Reaches Review → notifies.
    notifyTicketColumnChange({ ticketId: 't-loop', title: 'Loop', prevColumn: 'in_progress', column: 'review' })
    // Reviewer bounces it back to In Progress, agent re-enters Review — must NOT re-notify.
    notifyTicketColumnChange({ ticketId: 't-loop', title: 'Loop', prevColumn: 'review', column: 'in_progress' })
    notifyTicketColumnChange({ ticketId: 't-loop', title: 'Loop', prevColumn: 'in_progress', column: 'review' })
    await flush()
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })

  it('re-notifies "review" after a ticket finishes and is reopened', async () => {
    notifyTicketColumnChange({ ticketId: 't-r3', title: 'Again', prevColumn: 'in_progress', column: 'review' })
    await flush()
    expect(sendNotification).toHaveBeenCalledTimes(1)
    // Lands in Done — frees the Review dedupe slot.
    notifyTicketColumnChange({ ticketId: 't-r3', title: 'Again', prevColumn: 'review', column: 'done' })
    // Reopened and re-reviewed.
    notifyTicketColumnChange({ ticketId: 't-r3', title: 'Again', prevColumn: 'done', column: 'in_progress' })
    notifyTicketColumnChange({ ticketId: 't-r3', title: 'Again', prevColumn: 'in_progress', column: 'review' })
    await flush()
    // +1 done, +1 review = 3 total sends.
    expect(sendNotification).toHaveBeenCalledTimes(3)
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

  describe('auto-forward on user action', () => {
    it('starts forwarding the session in all mode when enabled', async () => {
      getSettingsState.mockReturnValue({ ...autoOn })
      await autoForwardTicketForUserAction({ sessionId: 's1', worktreeId: 'wt1', connectionId: null })
      expect(startForwarding).toHaveBeenCalledTimes(1)
      expect(startForwarding.mock.calls[0][0]).toMatchObject({
        sessionId: 's1',
        worktreeId: 'wt1',
        connectionId: null,
        mode: 'all'
      })
      expect(setStatus).toHaveBeenCalledTimes(1)
    })

    it('no-ops when the auto-forward toggle is off', async () => {
      await autoForwardTicketForUserAction({ sessionId: 's2', worktreeId: 'wt2', connectionId: null })
      expect(startForwarding).not.toHaveBeenCalled()
    })

    it('no-ops when the master toggle is off', async () => {
      getSettingsState.mockReturnValue({ ...autoOn, kanbanTelegramNotifyEnabled: false })
      await autoForwardTicketForUserAction({ sessionId: 's2b', worktreeId: 'wt2', connectionId: null })
      expect(startForwarding).not.toHaveBeenCalled()
    })

    it('does not steal an active forward for a different session', async () => {
      getSettingsState.mockReturnValue({ ...autoOn })
      getTelegramState.mockReturnValue({ activeForwardingSessionId: 'other', setStatus })
      await autoForwardTicketForUserAction({ sessionId: 's3', worktreeId: 'wt3', connectionId: null })
      expect(startForwarding).not.toHaveBeenCalled()
    })

    it('does not re-forward a session that is already being forwarded', async () => {
      getSettingsState.mockReturnValue({ ...autoOn })
      getTelegramState.mockReturnValue({ activeForwardingSessionId: 's4', setStatus })
      await autoForwardTicketForUserAction({ sessionId: 's4', worktreeId: 'wt4', connectionId: null })
      expect(startForwarding).not.toHaveBeenCalled()
    })

    it('no-ops without a single forwarding target (neither / both)', async () => {
      getSettingsState.mockReturnValue({ ...autoOn })
      await autoForwardTicketForUserAction({ sessionId: 's5', worktreeId: null, connectionId: null })
      await autoForwardTicketForUserAction({ sessionId: 's5', worktreeId: 'wt5', connectionId: 'cx5' })
      expect(startForwarding).not.toHaveBeenCalled()
    })

    it('auto-forwards on a question, resolving the ticket worktree', async () => {
      getSettingsState.mockReturnValue({ ...autoOn })
      getKanbanState.mockReturnValue({
        tickets: new Map([
          ['p', [{ id: 'tq', title: 'Q', current_session_id: 'sq', worktree_id: 'wq' }]]
        ])
      })
      await notifyTicketQuestion('sq', 'r1')
      expect(startForwarding).toHaveBeenCalledTimes(1)
      expect(startForwarding.mock.calls[0][0]).toMatchObject({
        sessionId: 'sq',
        worktreeId: 'wq',
        mode: 'all'
      })
    })
  })
})
