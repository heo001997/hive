import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Controllable doubles for the PTY API, status store, and bookkeeping maps the
// dispatcher touches. The real `unwrapEnvelope` runs against these envelope shapes.
const h = vi.hoisted(() => ({
  sendClaudeCliPrompt: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  createClaudeCli: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  setSessionMode: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
  setSessionStatus: vi.fn(),
  clearSessionStatus: vi.fn(),
  snapshotTokenBaseline: vi.fn(),
  messageSendTimes: new Map<string, number>(),
  userExplicitSendTimes: new Map<string, number>(),
  lastSendMode: new Map<string, string>()
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: {
    sendClaudeCliPrompt: (...args: unknown[]) => h.sendClaudeCliPrompt(...args),
    createClaudeCli: (...args: unknown[]) => h.createClaudeCli(...args)
  }
}))

vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: { getState: () => ({ setSessionMode: h.setSessionMode }) }
}))

vi.mock('@/stores/useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: {
    getState: () => ({
      setSessionStatus: h.setSessionStatus,
      clearSessionStatus: h.clearSessionStatus
    })
  }
}))

vi.mock('@/lib/message-send-times', () => ({
  messageSendTimes: h.messageSendTimes,
  userExplicitSendTimes: h.userExplicitSendTimes,
  lastSendMode: h.lastSendMode
}))

vi.mock('@/lib/token-baselines', () => ({ snapshotTokenBaseline: h.snapshotTokenBaseline }))

import { dispatchClaudeCliFollowup } from './claude-cli-followup'

const SESSION_ID = 'sess-1'

beforeEach(() => {
  vi.clearAllMocks()
  h.messageSendTimes.clear()
  h.userExplicitSendTimes.clear()
  h.lastSendMode.clear()
  h.setSessionMode.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('dispatchClaudeCliFollowup', () => {
  it('delivers to a live PTY: marks the session busy and does not relaunch', async () => {
    h.sendClaudeCliPrompt.mockResolvedValue({ success: true, value: { delivered: true } })

    const ok = await dispatchClaudeCliFollowup(SESSION_ID, 'do the next thing')

    expect(ok).toBe(true)
    expect(h.sendClaudeCliPrompt).toHaveBeenCalledWith(SESSION_ID, 'do the next thing')
    expect(h.createClaudeCli).not.toHaveBeenCalled()
    // Busy bookkeeping mirrors the modal's send path.
    expect(h.setSessionMode).toHaveBeenCalledWith(SESSION_ID, 'build')
    expect(h.setSessionStatus).toHaveBeenCalledWith(SESSION_ID, 'working')
    expect(h.snapshotTokenBaseline).toHaveBeenCalledWith(SESSION_ID)
    expect(h.lastSendMode.get(SESSION_ID)).toBe('build')
    expect(h.messageSendTimes.has(SESSION_ID)).toBe(true)
    expect(h.userExplicitSendTimes.has(SESSION_ID)).toBe(true)
    expect(h.clearSessionStatus).not.toHaveBeenCalled()
  })

  it('falls back to relaunching the CLI with the prompt pending when no live PTY', async () => {
    h.sendClaudeCliPrompt.mockResolvedValue({ success: true, value: { delivered: false } })
    h.createClaudeCli.mockResolvedValue({ success: true, value: { success: true } })

    const ok = await dispatchClaudeCliFollowup(SESSION_ID, 'resume')

    expect(ok).toBe(true)
    expect(h.createClaudeCli).toHaveBeenCalledWith(SESSION_ID, { pendingPrompt: 'resume' })
    expect(h.clearSessionStatus).not.toHaveBeenCalled()
  })

  it('clears the optimistic busy status and returns false when relaunch also fails', async () => {
    h.sendClaudeCliPrompt.mockResolvedValue({ success: true, value: { delivered: false } })
    h.createClaudeCli.mockResolvedValue({ success: true, value: { success: false } })

    const ok = await dispatchClaudeCliFollowup(SESSION_ID, 'nope')

    expect(ok).toBe(false)
    expect(h.clearSessionStatus).toHaveBeenCalledWith(SESSION_ID)
  })

  it('returns false and clears status when the PTY write throws', async () => {
    h.sendClaudeCliPrompt.mockRejectedValue(new Error('pty gone'))

    const ok = await dispatchClaudeCliFollowup(SESSION_ID, 'boom')

    expect(ok).toBe(false)
    expect(h.createClaudeCli).not.toHaveBeenCalled()
    expect(h.clearSessionStatus).toHaveBeenCalledWith(SESSION_ID)
  })
})
