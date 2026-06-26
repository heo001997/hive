import { useCallback } from 'react'
import type { KanbanTicket } from '../../../../main/db/types'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

/**
 * True when the Queue prompts feature is active for this ticket: Strict Verify +
 * its Reviewer sub-gate + the global queue toggle are on, and the ticket's
 * session is a Claude Code CLI session. Mirrors the store-side
 * `isClaudeCliQueueFeatureActive` so the UI and engine agree on gating.
 */
export function useClaudeCliQueueFeatureActive(ticket: KanbanTicket): boolean {
  const enabled = useSettingsStore(
    (s) =>
      s.kanbanStrictVerifyEnabled &&
      (s.kanbanStrictVerifyReviewerEnabled ?? true) &&
      s.kanbanQueuePromptsEnabled
  )
  const sessionId = ticket.current_session_id
  const isCli = useSessionStore(
    useCallback(
      (s) => {
        if (!sessionId) return false
        for (const sessions of s.sessionsByWorktree.values()) {
          const found = sessions.find((x) => x.id === sessionId)
          if (found) return found.agent_sdk === 'claude-code-cli'
        }
        return false
      },
      [sessionId]
    )
  )
  return enabled && !!sessionId && isCli
}
