import { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AlertCircle, Check, Loader2, TerminalSquare, X } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { useSessionStore } from '@/stores/useSessionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { isTerminalBacked, type AgentSdk } from '@shared/types/agent-sdk'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { CreateSessionMenu } from '@/components/sessions/CreateSessionMenu'
import type { KanbanTicket } from '../../../../main/db/types'

const SDK_LABEL: Record<AgentSdk, string> = {
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  'claude-code-cli': 'Claude CLI',
  codex: 'Codex',
  terminal: 'Terminal'
}

// The store keeps its own looser Session shape (no `pinned_to_board`); derive
// from the store rather than main/db's stricter type.
type WorktreeSession = NonNullable<
  ReturnType<ReturnType<typeof useSessionStore.getState>['getSessionById']>
>

const EMPTY_SESSIONS: WorktreeSession[] = []

interface TicketSessionTabProps {
  session: WorktreeSession
  isActive: boolean
  isPrimary: boolean
  onSelect: () => void
  onClose: (e: React.MouseEvent) => void
}

function TicketSessionTab({
  session,
  isActive,
  isPrimary,
  onSelect,
  onClose
}: TicketSessionTabProps): React.JSX.Element {
  const status = useWorktreeStatusStore((s) => s.sessionStatuses[session.id]?.status ?? null)
  const isTerminal = isTerminalBacked(session.agent_sdk)

  return (
    <div
      data-testid={`ticket-session-tab-${session.id}`}
      onClick={onSelect}
      onMouseDown={(e) => {
        if (e.button === 1) onClose(e)
      }}
      className={cn(
        'group relative flex items-center gap-1.5 px-3 py-1.5 text-sm cursor-pointer select-none',
        'border-r border-border transition-colors min-w-[110px] max-w-[200px]',
        isActive
          ? 'bg-background text-foreground'
          : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
      title={isPrimary ? `${session.name ?? 'Session'} — primary (drives ticket status)` : undefined}
    >
      {isTerminal ? (
        <TerminalSquare className="h-3 w-3 text-emerald-500 flex-shrink-0" />
      ) : status === 'working' || status === 'planning' ? (
        <Loader2
          className={cn(
            'h-3 w-3 animate-spin flex-shrink-0',
            status === 'planning' ? 'text-blue-400' : 'text-blue-500'
          )}
        />
      ) : status === 'answering' || status === 'permission' ? (
        <AlertCircle className="h-3 w-3 text-amber-500 flex-shrink-0" />
      ) : status === 'completed' ? (
        <Check className="h-3 w-3 text-green-500 flex-shrink-0" />
      ) : null}
      <span className="truncate flex-1">{session.name || 'Untitled'}</span>
      {isPrimary && (
        <span
          className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0"
          data-testid={`ticket-session-primary-${session.id}`}
        />
      )}
      <button
        onClick={onClose}
        className={cn(
          'p-0.5 rounded hover:bg-accent transition-opacity',
          isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        )}
        data-testid={`ticket-session-close-${session.id}`}
      >
        <X className="h-3 w-3" />
      </button>
      {isActive && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />}
    </div>
  )
}

interface TicketSessionTabsProps {
  ticket: KanbanTicket
  /** Which session the detail's pane is currently viewing (view-only). */
  activeViewSessionId: string | null
  /** Switch the viewed session (null clears it — e.g. the last session closed). */
  onSelectView: (sessionId: string | null) => void
  /** Called after a new session is spawned from the + menu. */
  onSpawned?: (sessionId: string) => void
  /** Optional control pinned to the right edge, kept visible while tabs scroll. */
  trailing?: React.ReactNode
}

/**
 * The ticket-detail terminal/session tab strip — the same multi-window control
 * the kanban board has, scoped to the ticket's worktree. Lists every session in
 * the worktree, marks the ticket's primary session, and spawns new ones via the
 * shared {@link CreateSessionMenu} (terminal + agents; no Board Assistant).
 *
 * Spawning here is view-only: new sessions skip kanban auto-attach and do NOT
 * steal the board's focus. The first session spawned for a session-less ticket
 * is promoted to the ticket's primary (`current_session_id`).
 */
export function TicketSessionTabs({
  ticket,
  activeViewSessionId,
  onSelectView,
  onSpawned,
  trailing
}: TicketSessionTabsProps): React.JSX.Element {
  const worktreeId = ticket.worktree_id

  const sessions = useSessionStore(
    useShallow((state) => {
      if (!worktreeId) return EMPTY_SESSIONS
      const list = state.sessionsByWorktree.get(worktreeId)
      if (!list) return EMPTY_SESSIONS
      return list.filter((s) => s.session_type !== 'board-assistant')
    })
  )

  // Proactively load sessions for session-less tickets (no primary session to
  // trigger the modal's own load flow). Skip when there's a primary — the modal
  // hydrates that path and a concurrent loadSessions could race it.
  const loadedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!worktreeId || !ticket.project_id) return
    if (ticket.current_session_id) return
    if (loadedRef.current === worktreeId) return
    loadedRef.current = worktreeId
    if (!useSessionStore.getState().sessionsByWorktree.has(worktreeId)) {
      void useSessionStore.getState().loadSessions(worktreeId, ticket.project_id)
    }
  }, [worktreeId, ticket.project_id, ticket.current_session_id])

  const handleSpawn = useCallback(
    async (sdk: AgentSdk) => {
      if (!worktreeId) {
        toast.error('Ticket has no workspace yet')
        return
      }
      const trimmed = ticket.title.trim()
      const shortTitle = trimmed.length > 24 ? `${trimmed.slice(0, 24).trim()}…` : trimmed
      const nameOverride = shortTitle ? `${shortTitle} · ${SDK_LABEL[sdk]}` : undefined
      const result = await useSessionStore
        .getState()
        .createSession(worktreeId, ticket.project_id, sdk, 'build', {
          skipKanbanAutoAttach: true,
          autoFocus: false,
          nameOverride
        })
      if (!result.success || !result.session) {
        toast.error(result.error || 'Failed to create session')
        return
      }
      const newId = result.session.id
      // First session for a session-less ticket becomes its primary. Re-read the
      // freshest primary from the store (not the possibly-stale closure) so two
      // rapid spawns don't both promote and clobber each other.
      const latestPrimary = useKanbanStore
        .getState()
        .tickets.get(ticket.project_id)
        ?.find((t) => t.id === ticket.id)?.current_session_id
      if (!latestPrimary) {
        await useKanbanStore
          .getState()
          .updateTicket(ticket.id, ticket.project_id, { current_session_id: newId })
      }
      onSpawned?.(newId)
    },
    [worktreeId, ticket.project_id, ticket.id, ticket.title, onSpawned]
  )

  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null)

  const doClose = useCallback(
    async (sessionId: string) => {
      const wasPrimary = sessionId === ticket.current_session_id
      const wasActive = sessionId === activeViewSessionId
      const remaining = (useSessionStore.getState().sessionsByWorktree.get(worktreeId ?? '') ?? [])
        .filter((s) => s.session_type !== 'board-assistant')
        .filter((s) => s.id !== sessionId)

      const result = await useSessionStore.getState().closeSession(sessionId)
      if (!result.success) {
        toast.error(result.error || 'Failed to close session')
        return
      }

      if (wasPrimary) {
        // Promote the next remaining session as primary, else clear it.
        const nextPrimary = remaining[0]?.id ?? null
        await useKanbanStore
          .getState()
          .updateTicket(ticket.id, ticket.project_id, { current_session_id: nextPrimary })
      }
      if (wasActive) {
        // Re-point the view at the next session, or clear it if none remain
        // (the pane then shows its empty state instead of a dead session id).
        onSelectView(remaining[0]?.id ?? null)
      }
    },
    [ticket.current_session_id, ticket.id, ticket.project_id, worktreeId, activeViewSessionId, onSelectView]
  )

  const handleCloseClick = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation()
      if (sessionId === ticket.current_session_id) {
        // Closing the primary affects ticket status — confirm first.
        setConfirmCloseId(sessionId)
        return
      }
      void doClose(sessionId)
    },
    [ticket.current_session_id, doClose]
  )

  return (
    <div
      className="shrink-0 flex items-stretch border-b border-border bg-muted/30"
      data-testid="ticket-session-tabs"
    >
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        <CreateSessionMenu
          onDefaultCreate={() => void handleSpawn('terminal')}
          onCreate={(sdk) => void handleSpawn(sdk)}
          triggerTitle="New session (right-click for options)"
          data-testid="ticket-create-session"
        />
        {sessions.length === 0 ? (
          <span className="flex items-center px-3 py-1.5 text-xs text-muted-foreground">
            No sessions yet — use + to start one
          </span>
        ) : (
          sessions.map((session) => (
            <TicketSessionTab
              key={session.id}
              session={session}
              isActive={session.id === activeViewSessionId}
              isPrimary={session.id === ticket.current_session_id}
              onSelect={() => onSelectView(session.id)}
              onClose={(e) => handleCloseClick(e, session.id)}
            />
          ))
        )}
      </div>
      {trailing}

      <AlertDialog
        open={confirmCloseId !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmCloseId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close the primary session?</AlertDialogTitle>
            <AlertDialogDescription>
              This session drives the ticket&apos;s status. Closing it will hand the primary role
              to another open session, or detach the ticket if none remain. The session stays in
              history and can be reopened.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep session</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const id = confirmCloseId
                setConfirmCloseId(null)
                if (id) void doClose(id)
              }}
            >
              Close session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
