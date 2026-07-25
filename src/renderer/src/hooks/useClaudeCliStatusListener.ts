import { useEffect } from 'react'
import { terminalApi } from '@/api/terminal-api'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { lastSendMode } from '@/lib/message-send-times'
import { notifyKanbanSessionSync } from '@/stores/store-coordination'
import { isPlanLike } from '@/lib/constants'

type ClaudeCliStatusMetadata = {
  reason?: string
  hookEventName?: string
  hookPath?: string
  toolName?: string
  plan?: string
}

function closeLinkedTicketModal(sessionId: string): void {
  const kanbanState = useKanbanStore.getState()
  const selectedTicketId = kanbanState.selectedTicketId
  if (!selectedTicketId) return

  for (const projectTickets of kanbanState.tickets.values()) {
    const selectedTicket = projectTickets.find((ticket) => ticket.id === selectedTicketId)
    if (!selectedTicket) continue
    if (selectedTicket.current_session_id === sessionId) {
      kanbanState.setSelectedTicketId(null)
    }
    return
  }
}

export function useClaudeCliStatusListener(): void {
  useEffect(() => {
    const handlePlanFollowup = (
      sessionId: string,
      metadata: ClaudeCliStatusMetadata = {
        reason: 'claude_cli_plan_followup'
      }
    ): void => {
      useSessionStore.getState().clearPendingPlan(sessionId)
      notifyKanbanSessionSync(sessionId, { type: 'plan_followup' })
      closeLinkedTicketModal(sessionId)
      lastSendMode.set(sessionId, 'plan')
      useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'planning', metadata)
    }

    const unsubscribe = terminalApi.onClaudeCliStatus(({ sessionId, status, metadata }) => {
      const worktreeStatus = useWorktreeStatusStore.getState()
      const sessionStore = useSessionStore.getState()
      const currentStatus = worktreeStatus.sessionStatuses[sessionId]?.status
      const currentMode = sessionStore.modeBySession.get(sessionId)

      if (metadata?.hookEventName === 'PostToolUse' && metadata.toolName === 'ExitPlanMode') {
        // Plan approved from the terminal (manually or via auto-approve), matching
        // the in-app implement action. The CLI has already left plan mode itself,
        // so persist the session mode to 'build' WITHOUT re-sending the Shift+Tab
        // keystroke (skipCliSync). Without this the session row stays mode='plan'
        // and reopening the ticket relaunches with `--permission-mode plan`,
        // dropping the resumed session back into planning instead of execution.
        sessionStore.clearPendingPlan(sessionId)
        if (isPlanLike(currentMode)) {
          void sessionStore.setSessionMode(sessionId, 'build', { skipCliSync: true })
        }
        notifyKanbanSessionSync(sessionId, { type: 'implement' })
        lastSendMode.set(sessionId, 'build')
        worktreeStatus.setSessionStatus(sessionId, 'working', metadata)
        return
      }

      if (
        status === 'plan_ready' &&
        metadata?.toolName === 'ExitPlanMode' &&
        typeof metadata.plan === 'string'
      ) {
        const syntheticId = `claude-cli:${sessionId}`
        sessionStore.setPendingPlan(sessionId, {
          requestId: syntheticId,
          planContent: metadata.plan,
          toolUseID: syntheticId
        })
      }

      if (
        status === 'planning' &&
        ((metadata?.hookEventName === 'UserPromptSubmit' && currentStatus === 'plan_ready') ||
          (metadata?.hookEventName === 'PostToolUseFailure' &&
            metadata.toolName === 'ExitPlanMode') ||
          metadata?.reason === 'claude_cli_plan_followup')
      ) {
        handlePlanFollowup(sessionId, metadata)
        return
      }

      if (
        status === 'working' &&
        metadata?.hookEventName === 'UserPromptSubmit' &&
        currentStatus === 'plan_ready'
      ) {
        lastSendMode.set(sessionId, 'build')
        worktreeStatus.setSessionStatus(sessionId, 'working', metadata)
        return
      }

      if (
        status === 'working' &&
        metadata?.hookEventName === 'UserPromptSubmit' &&
        isPlanLike(currentMode)
      ) {
        lastSendMode.set(sessionId, 'plan')
        worktreeStatus.setSessionStatus(sessionId, 'planning', metadata)
        return
      }

      // NOTE — a `SessionStart`-shaped 'completed' (the hook server maps a session
      // STARTING to the same value as a finished turn, legacy idle-badge semantics)
      // deliberately falls through to the generic tail below. It must still reach the
      // status store so the "Ready" badge is correct for a freshly spawned CLI; what
      // it must NOT do is arm the In Progress → Review promotion. That suppression
      // lives at the single choke point in `useWorktreeStatusStore`
      // (`isTurnEndCompletion`, which covers the `pty_start` sibling signal too) —
      // gating it here as well would cost the badge. Board-level regression: TC24 in
      // test/e2e/ticket-column-cli-scenarios.spec.ts.
      if (
        status === 'completed' &&
        metadata?.hookEventName === 'Stop' &&
        lastSendMode.get(sessionId) === 'plan'
      ) {
        worktreeStatus.setSessionStatus(sessionId, 'plan_ready', metadata)
        return
      }

      if (status === 'completed' && metadata?.hookEventName === 'StopFailure') {
        // The turn ended on an API error (rate limit / overload / auth), not a clean
        // finish. Reached both by a StopFailure that arrived with no sub-agent in
        // flight AND by one that was deferred behind a sub-agent and resolved at the
        // last SubagentStop (the hook server re-reports the deferred stop under its
        // original event name — see ClaudeCliHookOutcome.reportAs). The agent can't
        // proceed without the user → Human Require, not Review. Fire session_error (→
        // Human Require) and set a non-'completed' status so the
        // completed→session_completed→Review promotion does not also fire.
        notifyKanbanSessionSync(sessionId, { type: 'session_error' })
        worktreeStatus.setSessionStatus(sessionId, 'unread', metadata)
        return
      }

      worktreeStatus.setSessionStatus(sessionId, status, metadata)
    })

    return unsubscribe
  }, [])
}
