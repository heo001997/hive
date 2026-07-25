import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The status → kanban-event bridge in `setSessionStatus` is the single translation
// point from a live session status to a column-moving KanbanSessionEvent. This suite
// pins EVERY mapping so the Human Require routing (permission / command-approval /
// answering → session_human_required) can't silently regress.

const mocks = vi.hoisted(() => ({
  notifyKanbanSessionSync: vi.fn(),
  lastSendMode: new Map<string, 'plan' | 'build'>()
}))

vi.mock('./store-coordination', () => ({
  notifyKanbanSessionSync: mocks.notifyKanbanSessionSync
}))
vi.mock('@/lib/renderer-log', () => ({ logToMain: vi.fn() }))
vi.mock('@/lib/message-send-times', () => ({ lastSendMode: mocks.lastSendMode }))
// Peripheral stores/apis touched by the module but not by setSessionStatus's bridge.
vi.mock('./useSessionStore', () => ({
  useSessionStore: { getState: () => ({ sessionsByWorktree: new Map() }) }
}))
vi.mock('./useConnectionStore', () => ({ useConnectionStore: { getState: () => ({}) } }))
vi.mock('@/api/db-api', () => ({ dbApi: {} }))

import { useWorktreeStatusStore } from './useWorktreeStatusStore'
import type { SessionStatusType } from '@shared/types/session-status'

const SESSION_ID = 'sess-bridge'

function setStatus(
  status: SessionStatusType | null,
  metadata?: { reason?: string; hookEventName?: string }
): void {
  useWorktreeStatusStore.getState().setSessionStatus(SESSION_ID, status, metadata)
}

describe('useWorktreeStatusStore — status → kanban-event bridge', () => {
  beforeEach(() => {
    mocks.notifyKanbanSessionSync.mockClear()
    mocks.lastSendMode.clear()
    useWorktreeStatusStore.setState({ sessionStatuses: {} })
  })
  afterEach(() => {
    useWorktreeStatusStore.setState({ sessionStatuses: {} })
  })

  it.each<[SessionStatusType, string]>([
    ['permission', 'session_human_required'],
    ['command_approval', 'session_human_required'],
    ['answering', 'session_human_required']
  ])('%s → %s (Human Require)', (status, eventType) => {
    setStatus(status)
    expect(mocks.notifyKanbanSessionSync).toHaveBeenCalledWith(SESSION_ID, { type: eventType })
  })

  it('completed → session_completed', () => {
    setStatus('completed')
    expect(mocks.notifyKanbanSessionSync).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ type: 'session_completed' })
    )
  })

  // A CLI session reports 'completed' the moment its terminal spawns — `pty_start`
  // (promptless PTY) and the `SessionStart` hook. No turn has run, so these must set
  // the badge WITHOUT arming the In Progress → Review promotion; otherwise a ticket
  // jumps to Review on its very first run, before the agent has done anything.
  it.each<[string, { reason?: string; hookEventName?: string }]>([
    ['pty_start', { reason: 'pty_start' }],
    ['SessionStart hook', { hookEventName: 'SessionStart' }]
  ])('completed from %s → badge only, no session_completed', (_label, metadata) => {
    setStatus('completed', metadata)
    expect(mocks.notifyKanbanSessionSync).not.toHaveBeenCalled()
    expect(useWorktreeStatusStore.getState().sessionStatuses[SESSION_ID]?.status).toBe('completed')
  })

  it.each<[string, { reason?: string; hookEventName?: string }]>([
    ['Stop hook', { hookEventName: 'Stop' }],
    ['pty_exit', { reason: 'pty_exit' }],
    ['user_interrupt', { reason: 'user_interrupt' }]
  ])('completed from %s → session_completed (genuine turn end)', (_label, metadata) => {
    setStatus('completed', metadata)
    expect(mocks.notifyKanbanSessionSync).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ type: 'session_completed' })
    )
  })

  it('plan_ready → plan_ready', () => {
    setStatus('plan_ready')
    expect(mocks.notifyKanbanSessionSync).toHaveBeenCalledWith(SESSION_ID, { type: 'plan_ready' })
  })

  it.each<SessionStatusType>(['working', 'planning'])(
    '%s → session_working (resume / active)',
    (status) => {
      setStatus(status)
      expect(mocks.notifyKanbanSessionSync).toHaveBeenCalledWith(SESSION_ID, {
        type: 'session_working'
      })
    }
  )

  it('unread → no kanban event (errored badge only; session_error is fired elsewhere)', () => {
    setStatus('unread')
    expect(mocks.notifyKanbanSessionSync).not.toHaveBeenCalled()
  })
})
