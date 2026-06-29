import { useEffect, useMemo, useState } from 'react'
import { TerminalView } from '@/components/terminal/TerminalView'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { dbApi } from '@/api/db-api'
import type { Worktree } from '../../../../main/db/types'

interface SessionTerminalViewProps {
  sessionId: string
  /** Whether this terminal is currently visible (not hidden by CSS). Controls fit/focus and Ghostty frame sync. */
  isVisible?: boolean
  /** Reparent marker forwarded to TerminalView; changes when moved in/out of the ticket modal. */
  mountToken?: string | number
}

/**
 * Renders a full-size terminal for "terminal" agent_sdk sessions.
 * Uses the session ID as the PTY key (not worktree ID) to avoid
 * conflicts with the bottom-panel terminal.
 */
export function SessionTerminalView({
  sessionId,
  isVisible = true,
  mountToken
}: SessionTerminalViewProps): React.JSX.Element {
  // Look up the session to find its worktree_id or connection_id
  const session = useSessionStore((state) => {
    for (const sessions of state.sessionsByWorktree.values()) {
      const found = sessions.find((s) => s.id === sessionId)
      if (found) return found
    }
    for (const sessions of state.sessionsByConnection.values()) {
      const found = sessions.find((s) => s.id === sessionId)
      if (found) return found
    }
    return null
  })

  // Resolve the working directory from the session's worktree
  const resolvedCwd = useMemo(() => {
    if (!session) return null

    // Direct worktree session
    if (session.worktree_id) {
      const worktreesByProject = useWorktreeStore.getState().worktreesByProject
      for (const worktrees of worktreesByProject.values()) {
        const wt = worktrees.find((w) => w.id === session.worktree_id)
        if (wt?.path) return wt.path
      }
    }

    // Connection session — use the first member's worktree path
    if (session.connection_id) {
      const connections = useConnectionStore.getState().connections
      const connection = connections.find((c) => c.id === session.connection_id)
      if (connection?.members?.[0]) {
        const worktreesByProject = useWorktreeStore.getState().worktreesByProject
        for (const worktrees of worktreesByProject.values()) {
          const wt = worktrees.find((w) => w.id === connection.members[0].worktree_id)
          if (wt?.path) return wt.path
        }
      }
    }

    return null
  }, [session])

  const [lastKnownCwd, setLastKnownCwd] = useState<string | null>(null)

  useEffect(() => {
    if (!resolvedCwd) return
    setLastKnownCwd((current) => (current === resolvedCwd ? current : resolvedCwd))
  }, [resolvedCwd])

  // The in-store resolution above reads a non-reactive snapshot of
  // `worktreesByProject`. When this terminal is portaled into a surface whose
  // project worktrees aren't loaded (e.g. a ticket detail opened from the board),
  // that snapshot is empty and never recomputes — leaving the terminal stuck on
  // "Loading terminal...". Fall back to the worktree's DB path so the PTY can
  // still spawn (mirrors SessionView / TicketSessionPane).
  const [dbCwd, setDbCwd] = useState<string | null>(null)
  useEffect(() => {
    if (resolvedCwd || !session?.worktree_id) {
      setDbCwd(null)
      return
    }
    let cancelled = false
    dbApi.worktree.get<Worktree>(session.worktree_id).then((wt) => {
      if (!cancelled) setDbCwd(wt?.path ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [resolvedCwd, session?.worktree_id])

  const cwd = resolvedCwd || lastKnownCwd || dbCwd

  if (!cwd) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <p className="text-sm">Loading terminal...</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="session-terminal-view">
      <TerminalView terminalId={sessionId} cwd={cwd} isVisible={isVisible} mountToken={mountToken} />
    </div>
  )
}
