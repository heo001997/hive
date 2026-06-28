import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { awaitWorktreeSetup, renderContextTemplate } from './worktree-context'
import { useScriptStore } from '@/stores/useScriptStore'

// Capture the setup-channel subscription so tests can drive `done`/`error` events.
const scriptApiHarness = vi.hoisted(() => ({
  cb: null as ((event: { type: string; command?: string }) => void) | null,
  unsub: vi.fn()
}))

vi.mock('@/api/script-api', () => ({
  scriptApi: {
    onOutput: vi.fn((_channel: string, cb: (event: { type: string }) => void) => {
      scriptApiHarness.cb = cb
      return () => {
        scriptApiHarness.cb = null
        scriptApiHarness.unsub()
      }
    }),
    getPort: vi.fn(async () => ({ port: null }))
  }
}))

const initialScriptState = useScriptStore.getState()

describe('renderContextTemplate', () => {
  it('substitutes every provided token', () => {
    const out = renderContextTemplate('branch={{BRANCH}} port={{PORT}} url={{DEV_URL}}', {
      BRANCH: 'feature',
      PORT: '3001',
      DEV_URL: 'http://localhost:3001'
    })
    expect(out).toBe('branch=feature port=3001 url=http://localhost:3001')
  })

  it('renders missing/unknown tokens as empty strings', () => {
    const out = renderContextTemplate('a={{PORT}}|b={{WORKTREE_CONTEXT}}|c={{NOPE}}', {
      PORT: '3001'
    })
    expect(out).toBe('a=3001|b=|c=')
  })

  it('leaves text with no tokens untouched', () => {
    expect(renderContextTemplate('plain text', {})).toBe('plain text')
  })
})

describe('awaitWorktreeSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scriptApiHarness.cb = null
    useScriptStore.setState(initialScriptState, true)
  })

  afterEach(() => {
    vi.useRealTimers()
    useScriptStore.setState(initialScriptState, true)
  })

  it('resolves done immediately when setup is not running', async () => {
    // Default script state has setupRunning=false → no subscription needed.
    await expect(awaitWorktreeSetup('worktree-1')).resolves.toEqual({ status: 'done' })
  })

  it('resolves error immediately when a finished setup recorded an error', async () => {
    useScriptStore.getState().setSetupError('worktree-1', 'boom')
    await expect(awaitWorktreeSetup('worktree-1')).resolves.toEqual({
      status: 'error',
      error: 'boom'
    })
  })

  it('resolves done when the setup channel emits done while running', async () => {
    useScriptStore.getState().setSetupRunning('worktree-1', true)
    const pending = awaitWorktreeSetup('worktree-1')
    // Flush the subscription callback registration.
    await Promise.resolve()
    useScriptStore.getState().setSetupRunning('worktree-1', false)
    scriptApiHarness.cb?.({ type: 'done' })
    await expect(pending).resolves.toEqual({ status: 'done' })
  })

  it('resolves error when the setup channel emits an error event', async () => {
    useScriptStore.getState().setSetupRunning('worktree-1', true)
    const pending = awaitWorktreeSetup('worktree-1')
    await Promise.resolve()
    useScriptStore.getState().setSetupError('worktree-1', 'setup blew up')
    scriptApiHarness.cb?.({ type: 'error', command: 'pnpm i' })
    await expect(pending).resolves.toEqual({ status: 'error', error: 'setup blew up' })
  })

  it('resolves timeout when setup never finishes within the deadline', async () => {
    vi.useFakeTimers()
    useScriptStore.getState().setSetupRunning('worktree-1', true)
    const pending = awaitWorktreeSetup('worktree-1', { timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toEqual({ status: 'timeout' })
  })
})
