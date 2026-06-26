import { useCallback, useEffect, useRef, useState } from 'react'
import { TerminalSquare } from 'lucide-react'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useClaudeCliSessionPortal } from '@/contexts/ClaudeCliSessionPortalContext'
import { isTerminalBacked } from '@shared/types/agent-sdk'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { dbApi } from '@/api/db-api'
import { opencodeApi } from '@/api/opencode-api'
import { SessionStreamPanel } from './SessionStreamPanel'
import type { Session, Worktree } from '../../../../main/db/types'

/**
 * Portal target for a terminal-backed session (plain `terminal` or
 * `claude-code-cli`). The session itself stays permanently mounted in MainPane
 * (to preserve PTY state); this slot just registers a DOM target and requests a
 * mount so MainPane portals the live terminal into the ticket detail.
 */
function SessionMountPortalSlot({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { registerTarget } = useClaudeCliSessionPortal()
  const requestSessionMount = useSessionStore((s) => s.requestSessionMount)
  const releaseSessionMount = useSessionStore((s) => s.releaseSessionMount)
  const targetRef = useRef<HTMLDivElement | null>(null)

  const setTargetRef = useCallback(
    (el: HTMLDivElement | null) => {
      targetRef.current = el
      registerTarget(sessionId, el)
    },
    [registerTarget, sessionId]
  )

  useEffect(() => {
    requestSessionMount(sessionId)
    if (targetRef.current) {
      registerTarget(sessionId, targetRef.current)
    }
    return () => {
      registerTarget(sessionId, null)
      releaseSessionMount(sessionId)
    }
  }, [registerTarget, releaseSessionMount, requestSessionMount, sessionId])

  return (
    <div
      ref={setTargetRef}
      className="flex-1 flex flex-col min-h-0"
      data-testid={`ticket-session-portal-${sessionId}`}
    />
  )
}

interface TicketSessionPaneProps {
  /** The session to render. When null/unresolved, an empty state is shown. */
  sessionId: string | null
  /** Header title (defaults to the session name). */
  title?: string
  /** Optional header action rendered on the right of the stream header. */
  headerAction?: React.ReactNode
  /** When true, hides the left border (full-width layout). */
  fullWidth?: boolean
}

/**
 * Renders a single session inside the ticket detail's tab strip — the view-only
 * counterpart to the board's SessionView. Self-contained: it resolves the
 * session record, its worktree/connection path and opencode id, pre-warms the
 * message cache, then routes terminal-backed sessions to the keepalive portal
 * and agent sessions to {@link SessionStreamPanel}.
 *
 * Unlike the modal's primary-session path, this never sends followups or drives
 * ticket status — it only displays whichever tab the user is viewing.
 */
export function TicketSessionPane({
  sessionId,
  title,
  headerAction,
  fullWidth = false
}: TicketSessionPaneProps): React.JSX.Element {
  const session = useSessionStore(
    useCallback(
      (state) => {
        if (!sessionId) return null
        for (const sessions of state.sessionsByWorktree.values()) {
          const found = sessions.find((s) => s.id === sessionId)
          if (found) return found
        }
        for (const sessions of state.sessionsByConnection.values()) {
          const found = sessions.find((s) => s.id === sessionId)
          if (found) return found
        }
        return null
      },
      [sessionId]
    )
  )

  const agentSdk = session?.agent_sdk ?? null
  const isTerminal = isTerminalBacked(agentSdk)

  // ── Worktree / connection path resolution ─────────────────────────
  const storeWorktreePath = useWorktreeStore(
    useCallback(
      (state) => {
        if (!session?.worktree_id) return null
        for (const worktrees of state.worktreesByProject.values()) {
          const wt = worktrees.find((w) => w.id === session.worktree_id)
          if (wt) return wt.path
        }
        return null
      },
      [session?.worktree_id]
    )
  )
  const connectionPath = useConnectionStore(
    useCallback(
      (state) =>
        session?.connection_id
          ? (state.connections.find((c) => c.id === session.connection_id)?.path ?? null)
          : null,
      [session?.connection_id]
    )
  )

  // Worktree not in the in-memory store (project not loaded) — load its path from DB.
  const [dbWorktreePath, setDbWorktreePath] = useState<string | null>(null)
  useEffect(() => {
    if (!session?.worktree_id || storeWorktreePath) {
      setDbWorktreePath(null)
      return
    }
    let cancelled = false
    dbApi.worktree.get<Worktree>(session.worktree_id).then((wt) => {
      if (!cancelled) setDbWorktreePath(wt?.path ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [session?.worktree_id, storeWorktreePath])

  const worktreePath = storeWorktreePath ?? connectionPath ?? dbWorktreePath

  // ── opencode session id (resolve placeholder pending:: ids from DB) ──
  const storeOpcSessionId = session?.opencode_session_id ?? null
  const [resolvedOpcSessionId, setResolvedOpcSessionId] = useState<string | null>(null)
  useEffect(() => {
    if (!storeOpcSessionId || !storeOpcSessionId.startsWith('pending::') || !sessionId) {
      setResolvedOpcSessionId(null)
      return
    }
    let cancelled = false
    dbApi.session
      .get<Pick<Session, 'opencode_session_id'>>(sessionId)
      .then((dbSess: { opencode_session_id?: string | null } | null) => {
        if (cancelled) return
        const dbId = dbSess?.opencode_session_id ?? null
        if (dbId && !dbId.startsWith('pending::')) {
          useSessionStore.getState().setOpenCodeSessionId(sessionId, dbId)
          setResolvedOpcSessionId(dbId)
        }
      })
    return () => {
      cancelled = true
    }
  }, [storeOpcSessionId, sessionId])

  const opcSessionId = resolvedOpcSessionId ?? storeOpcSessionId
  const hasStream = !!(
    sessionId &&
    worktreePath &&
    opcSessionId &&
    !opcSessionId.startsWith('pending::')
  )

  // ── Pre-warm the backend message cache (mirrors the modal's primary path) ──
  const [sessionReady, setSessionReady] = useState(false)
  useEffect(() => {
    if (isTerminal || !worktreePath || !opcSessionId || !sessionId) {
      setSessionReady(false)
      return
    }
    let cancelled = false
    setSessionReady(false)
    ;(async () => {
      try {
        unwrapEnvelope(await opencodeApi.reconnect(worktreePath, opcSessionId, sessionId))
      } catch {
        // reconnect failure is non-fatal — still try to show messages
      }
      try {
        unwrapEnvelope(await opencodeApi.getMessages(worktreePath, opcSessionId))
      } catch {
        // pre-warm failure is non-fatal
      }
      if (!cancelled) setSessionReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [isTerminal, worktreePath, opcSessionId, sessionId])

  const spinner = (
    <div className="flex-1 flex items-center justify-center text-muted-foreground">
      <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent" />
    </div>
  )

  // ── Empty state: no session selected / resolvable ──────────────────
  if (!sessionId || !session) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground"
        data-testid="ticket-session-empty"
      >
        <TerminalSquare className="h-8 w-8 opacity-40" />
        <p className="text-sm font-medium">No session yet</p>
        <p className="text-xs">Use the + above to start a terminal or agent.</p>
      </div>
    )
  }

  // ── Terminal-backed: portal the keepalive terminal in ──────────────
  if (isTerminal) {
    return (
      <div className="flex flex-col h-full bg-background flex-1 min-w-0">
        <div className="shrink-0 px-4 py-3 border-b border-border/60 flex items-center gap-2">
          <TerminalSquare className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
          <span className="text-sm font-medium text-foreground truncate">
            {title ?? session.name ?? 'Terminal'}
          </span>
          {headerAction && <div className="ml-auto shrink-0">{headerAction}</div>}
        </div>
        <SessionMountPortalSlot sessionId={sessionId} />
      </div>
    )
  }

  // ── Agent session: streaming view ──────────────────────────────────
  if (hasStream && sessionReady) {
    return (
      <SessionStreamPanel
        sessionId={sessionId}
        worktreePath={worktreePath!}
        opencodeSessionId={opcSessionId!}
        title={title ?? session.name ?? 'Session'}
        headerAction={headerAction}
        fullWidth={fullWidth}
      />
    )
  }

  return spinner
}
