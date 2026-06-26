import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionTerminalView } from './SessionTerminalView'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'

// Capture the cwd the terminal is mounted with so we can assert resolution.
vi.mock('@/components/terminal/TerminalView', () => ({
  TerminalView: ({ terminalId, cwd }: { terminalId: string; cwd: string }) => (
    <div data-testid="terminal-view" data-terminal-id={terminalId} data-cwd={cwd} />
  )
}))

const worktreeGet = vi.fn()
vi.mock('@/api/db-api', () => ({
  dbApi: {
    worktree: {
      get: (id: string) => worktreeGet(id)
    }
  }
}))

const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialConnectionState = useConnectionStore.getState()

type TerminalSession = {
  id: string
  worktree_id: string | null
  connection_id: string | null
  agent_sdk: 'terminal'
}

function setStore(session: TerminalSession, worktreesByProject: Map<string, unknown[]>): void {
  useSessionStore.setState({
    sessionsByWorktree: new Map([['worktree-1', [session]]]) as never,
    sessionsByConnection: new Map()
  })
  useWorktreeStore.setState({ worktreesByProject: worktreesByProject as never })
  useConnectionStore.setState({ connections: [] as never })
}

afterEach(() => {
  cleanup()
  worktreeGet.mockReset()
  useSessionStore.setState(initialSessionState, true)
  useWorktreeStore.setState(initialWorktreeState, true)
  useConnectionStore.setState(initialConnectionState, true)
})

describe('SessionTerminalView cwd resolution', () => {
  it('falls back to the DB worktree path when the worktree is not in the store', async () => {
    // Ticket-detail scenario: the session's worktree isn't loaded into
    // worktreesByProject, so the in-store snapshot can't resolve a cwd.
    worktreeGet.mockResolvedValue({ id: 'worktree-1', path: '/db/resolved/path' })
    setStore(
      { id: 'session-1', worktree_id: 'worktree-1', connection_id: null, agent_sdk: 'terminal' },
      new Map()
    )

    render(<SessionTerminalView sessionId="session-1" />)

    // Initially stuck on the loading placeholder…
    expect(screen.getByText('Loading terminal...')).toBeTruthy()

    // …then the DB fallback resolves and the PTY mounts with that path.
    const terminal = await screen.findByTestId('terminal-view')
    expect(terminal.getAttribute('data-cwd')).toBe('/db/resolved/path')
    expect(worktreeGet).toHaveBeenCalledWith('worktree-1')
  })

  it('uses the in-store worktree path without hitting the DB', () => {
    setStore(
      { id: 'session-1', worktree_id: 'worktree-1', connection_id: null, agent_sdk: 'terminal' },
      new Map([['project-1', [{ id: 'worktree-1', path: '/store/path' }]]])
    )

    render(<SessionTerminalView sessionId="session-1" />)

    const terminal = screen.getByTestId('terminal-view')
    expect(terminal.getAttribute('data-cwd')).toBe('/store/path')
    expect(worktreeGet).not.toHaveBeenCalled()
  })
})
