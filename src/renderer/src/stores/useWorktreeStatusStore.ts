import { create } from 'zustand'
import { useSessionStore } from './useSessionStore'
import { useConnectionStore } from './useConnectionStore'
import { lastSendMode } from '@/lib/message-send-times'
import { notifyKanbanSessionSync } from './store-coordination'
import { isTurnEndCompletion } from '@/lib/session-completion'
import { logToMain } from '@/lib/renderer-log'
import { dbApi } from '@/api/db-api'
import type { SessionStatusType } from '@shared/types/session-status'

// Re-exported from the shared definition so existing importers keep working.
export type { SessionStatusType }

export interface SessionStatusEntry {
  status: SessionStatusType
  timestamp: number
  word?: string
  durationMs?: number
  tokenDelta?: number
  reason?: string
  hookEventName?: string
  hookPath?: string
  toolName?: string
  plan?: string
}

export type MergeConflictFlow =
  | { phase: 'starting' }
  | { phase: 'running'; sessionId: string; seenBusy: boolean }
  | { phase: 'refreshing' }

interface WorktreeStatusState {
  // sessionId → status info (null means no status / cleared)
  sessionStatuses: Record<string, SessionStatusEntry | null>
  // worktreeId → epoch ms of last message activity
  lastMessageTimeByWorktree: Record<string, number>
  // worktreeId → sessionId for active conflict-fix sessions
  mergeConflictSessionByWorktree: Record<string, string>
  // worktreeId → current conflict-fix flow phase
  mergeConflictFlowByWorktree: Record<string, MergeConflictFlow>
  // ticketId → worktreeId whose conflicts should be surfaced on that ticket
  mergeConflictWorktreeByTicket: Record<string, string>

  // Actions
  setSessionStatus: (
    sessionId: string,
    status: SessionStatusType | null,
    metadata?: {
      word?: string
      durationMs?: number
      tokenDelta?: number
      reason?: string
      hookEventName?: string
      hookPath?: string
      toolName?: string
      plan?: string
    }
  ) => void
  clearSessionStatus: (sessionId: string) => void
  clearWorktreeUnread: (worktreeId: string) => void
  getWorktreeStatus: (worktreeId: string) => SessionStatusType | null
  getConnectionStatus: (connectionId: string) => SessionStatusType | null
  getWorktreeCompletedEntry: (worktreeId: string) => SessionStatusEntry | null
  setLastMessageTime: (worktreeId: string, timestamp: number) => void
  getLastMessageTime: (worktreeId: string) => number | null
  setMergeConflictSession: (worktreeId: string, sessionId: string) => void
  clearMergeConflictSession: (worktreeId: string) => void
  setMergeConflictFlow: (worktreeId: string, flow: MergeConflictFlow | null) => void
  setMergeConflictWorktreeForTicket: (ticketId: string, worktreeId: string | null) => void
}

// Priority ranking for status aggregation (higher number = higher priority)
const STATUS_PRIORITY: Record<SessionStatusType, number> = {
  answering: 8,
  command_approval: 7,
  permission: 6,
  planning: 5,
  working: 4,
  plan_ready: 3,
  completed: 2,
  unread: 1
}

function higherPriority(
  a: SessionStatusType | null,
  b: SessionStatusType | null
): SessionStatusType | null {
  if (!a) return b
  if (!b) return a
  return STATUS_PRIORITY[a] >= STATUS_PRIORITY[b] ? a : b
}

export const useWorktreeStatusStore = create<WorktreeStatusState>((set, get) => ({
  sessionStatuses: {},
  lastMessageTimeByWorktree: {},
  mergeConflictSessionByWorktree: {},
  mergeConflictFlowByWorktree: {},
  mergeConflictWorktreeByTicket: {},

  setSessionStatus: (
    sessionId: string,
    status: SessionStatusType | null,
    metadata?: {
      word?: string
      durationMs?: number
      tokenDelta?: number
      reason?: string
      hookEventName?: string
      hookPath?: string
      toolName?: string
      plan?: string
    }
  ) => {
    const prevStatus = get().sessionStatuses[sessionId]?.status ?? null

    set((state) => {
      const next: Partial<WorktreeStatusState> = {
        sessionStatuses: {
          ...state.sessionStatuses,
          [sessionId]: status ? { status, timestamp: Date.now(), ...metadata } : null
        }
      }

      return next
    })

    // Durable trace of the session-status choreography (see renderer-log.ts). Only
    // on an actual change so idle re-emits don't spam the log. This is the signal
    // that decides a ticket's column, so it must be reconstructable from the log.
    if (prevStatus !== status) {
      logToMain('info', 'SessionStatus', `session ${sessionId}: ${prevStatus ?? 'none'} → ${status ?? 'none'}`, {
        sessionId,
        from: prevStatus,
        to: status,
        reason: metadata?.reason,
        hookEventName: metadata?.hookEventName,
        toolName: metadata?.toolName
      })
    }

    // ── Kanban coordination: notify kanban store of relevant status changes ──
    if (status === 'completed') {
      // Only a genuine turn end may drive the column. A spawn-time 'completed'
      // (`pty_start` / the `SessionStart` hook) sets the badge but must NOT arm the
      // In Progress → Review promotion — see `isTurnEndCompletion`.
      if (isTurnEndCompletion(metadata)) {
        const mode = lastSendMode.get(sessionId) as 'build' | 'plan' | undefined
        notifyKanbanSessionSync(sessionId, {
          type: 'session_completed',
          sessionMode: mode,
          tokenDelta: metadata?.tokenDelta
        })
      }
    } else if (status === 'plan_ready') {
      notifyKanbanSessionSync(sessionId, { type: 'plan_ready' })
    } else if (status === 'working' || status === 'planning') {
      notifyKanbanSessionSync(sessionId, { type: 'session_working' })
    } else if (
      status === 'permission' ||
      status === 'command_approval' ||
      status === 'answering'
    ) {
      // The agent is BLOCKED awaiting the user — a permission / command-approval
      // prompt, an MCP elicitation (`permission`), or a structured question
      // (`answering`, the CLI AskUserQuestion path). Route to the Human Require
      // column. (SDK structured Q&A also fires the more specific `session_question`
      // from the OpenCode listener; both target the same column, so it's idempotent.)
      // A reply flips the status back to working/planning → `session_working` →
      // In Progress.
      notifyKanbanSessionSync(sessionId, { type: 'session_human_required' })
    }
  },

  clearSessionStatus: (sessionId: string) => {
    set((state) => ({
      sessionStatuses: {
        ...state.sessionStatuses,
        [sessionId]: null
      }
    }))
  },

  clearWorktreeUnread: (worktreeId: string) => {
    const { sessionStatuses } = get()
    const sessionStore = useSessionStore.getState()
    const sessions = sessionStore.sessionsByWorktree.get(worktreeId) || []

    const updates: Record<string, null> = {}
    for (const s of sessions) {
      const st = sessionStatuses[s.id]?.status
      if (st === 'unread' || st === 'completed') {
        updates[s.id] = null
      }
    }

    if (Object.keys(updates).length > 0) {
      set((state) => ({
        sessionStatuses: { ...state.sessionStatuses, ...updates }
      }))
    }
  },

  getWorktreeStatus: (worktreeId: string): SessionStatusType | null => {
    const { sessionStatuses } = get()

    // ── Connection status (takes priority over worktree's own sessions) ──
    const connections = useConnectionStore.getState().connections
    const parentConnectionIds = connections
      .filter((c) => c.members.some((m) => m.worktree_id === worktreeId))
      .map((c) => c.id)

    if (parentConnectionIds.length > 0) {
      let bestConnectionStatus: SessionStatusType | null = null
      for (const connId of parentConnectionIds) {
        const connStatus = get().getConnectionStatus(connId)
        if (connStatus) {
          bestConnectionStatus = higherPriority(bestConnectionStatus, connStatus)
        }
      }
      if (bestConnectionStatus !== null) return bestConnectionStatus
    }

    // ── Worktree's own session status (fallback) ──
    const sessionStore = useSessionStore.getState()
    const sessions = sessionStore.sessionsByWorktree.get(worktreeId) || []
    const sessionIds = sessions.map((s) => s.id)

    let hasPlanning = false
    let hasWorking = false
    let hasPlanReady = false
    let hasCompleted = false
    let latestUnread: SessionStatusEntry | null = null

    for (const id of sessionIds) {
      const entry = sessionStatuses[id]
      if (!entry) continue

      // answering/command_approval/permission have the highest priority — return immediately
      if (
        entry.status === 'answering' ||
        entry.status === 'command_approval' ||
        entry.status === 'permission'
      )
        return entry.status
      if (entry.status === 'planning') hasPlanning = true
      if (entry.status === 'working') hasWorking = true
      if (entry.status === 'plan_ready') hasPlanReady = true
      if (entry.status === 'completed') hasCompleted = true

      // Track the latest unread
      if (entry.status === 'unread') {
        if (!latestUnread || entry.timestamp > latestUnread.timestamp) {
          latestUnread = entry
        }
      }
    }

    // Priority: answering > planning > working > plan_ready > completed > unread > null
    if (hasPlanning) return 'planning'
    if (hasWorking) return 'working'
    if (hasPlanReady) return 'plan_ready'

    // Derive plan_ready from the mode the user last sent a message in.
    // If the last message was sent in plan mode and the session completed,
    // show "Plan ready". Otherwise show normal "Ready".
    if (hasCompleted) {
      const completedInPlan = sessions.some(
        (s) => sessionStatuses[s.id]?.status === 'completed' && lastSendMode.get(s.id) === 'plan'
      )
      return completedInPlan ? 'plan_ready' : 'completed'
    }

    return latestUnread ? 'unread' : null
  },

  getConnectionStatus: (connectionId: string): SessionStatusType | null => {
    const { sessionStatuses } = get()
    const sessionStore = useSessionStore.getState()
    const sessions = sessionStore.sessionsByConnection.get(connectionId) || []
    const sessionIds = sessions.map((s) => s.id)

    let hasPlanning = false
    let hasWorking = false
    let hasPlanReady = false
    let hasCompleted = false
    let latestUnread: SessionStatusEntry | null = null

    for (const id of sessionIds) {
      const entry = sessionStatuses[id]
      if (!entry) continue

      if (
        entry.status === 'answering' ||
        entry.status === 'command_approval' ||
        entry.status === 'permission'
      )
        return entry.status
      if (entry.status === 'planning') hasPlanning = true
      if (entry.status === 'working') hasWorking = true
      if (entry.status === 'plan_ready') hasPlanReady = true
      if (entry.status === 'completed') hasCompleted = true

      if (entry.status === 'unread') {
        if (!latestUnread || entry.timestamp > latestUnread.timestamp) {
          latestUnread = entry
        }
      }
    }

    if (hasPlanning) return 'planning'
    if (hasWorking) return 'working'
    if (hasPlanReady) return 'plan_ready'

    if (hasCompleted) {
      const completedInPlan = sessions.some(
        (s) => sessionStatuses[s.id]?.status === 'completed' && lastSendMode.get(s.id) === 'plan'
      )
      return completedInPlan ? 'plan_ready' : 'completed'
    }

    return latestUnread ? 'unread' : null
  },

  getWorktreeCompletedEntry: (worktreeId: string): SessionStatusEntry | null => {
    const { sessionStatuses } = get()
    const sessionStore = useSessionStore.getState()
    const sessions = sessionStore.sessionsByWorktree.get(worktreeId) || []

    for (const s of sessions) {
      const entry = sessionStatuses[s.id]
      if (entry?.status === 'completed') return entry
    }
    return null
  },

  setLastMessageTime: (worktreeId: string, timestamp: number) => {
    const prev = get().lastMessageTimeByWorktree[worktreeId] ?? 0
    const next = Math.max(prev, timestamp)
    if (next === prev && prev !== 0) return // no change

    set((state) => ({
      lastMessageTimeByWorktree: {
        ...state.lastMessageTimeByWorktree,
        [worktreeId]: next
      }
    }))

    // Persist to SQLite (fire-and-forget)
    dbApi.worktree.update(worktreeId, { last_message_at: next }).catch(() => {})
  },

  getLastMessageTime: (worktreeId: string) => {
    return get().lastMessageTimeByWorktree[worktreeId] ?? null
  },

  setMergeConflictSession: (worktreeId: string, sessionId: string) => {
    set((state) => ({
      mergeConflictSessionByWorktree: {
        ...state.mergeConflictSessionByWorktree,
        [worktreeId]: sessionId
      }
    }))
  },

  clearMergeConflictSession: (worktreeId: string) => {
    set((state) => {
      const { [worktreeId]: _, ...rest } = state.mergeConflictSessionByWorktree
      return { mergeConflictSessionByWorktree: rest }
    })
  },

  setMergeConflictFlow: (worktreeId: string, flow: MergeConflictFlow | null) => {
    set((state) => {
      if (!flow) {
        const { [worktreeId]: _, ...rest } = state.mergeConflictFlowByWorktree
        return { mergeConflictFlowByWorktree: rest }
      }
      return {
        mergeConflictFlowByWorktree: {
          ...state.mergeConflictFlowByWorktree,
          [worktreeId]: flow
        }
      }
    })
  },

  setMergeConflictWorktreeForTicket: (ticketId: string, worktreeId: string | null) => {
    set((state) => {
      if (!worktreeId) {
        const { [ticketId]: _, ...rest } = state.mergeConflictWorktreeByTicket
        return { mergeConflictWorktreeByTicket: rest }
      }
      return {
        mergeConflictWorktreeByTicket: {
          ...state.mergeConflictWorktreeByTicket,
          [ticketId]: worktreeId
        }
      }
    })
  }
}))

declare global {
  interface Window {
    __hive_useWorktreeStatusStore__?: typeof useWorktreeStatusStore
  }
}

const importMeta = import.meta as ImportMeta & { env?: { DEV?: boolean } }

if (importMeta.env?.DEV && typeof window !== 'undefined') {
  window.__hive_useWorktreeStatusStore__ = useWorktreeStatusStore
}
