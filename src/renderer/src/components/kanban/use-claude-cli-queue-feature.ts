import { useCallback } from 'react'
import type { KanbanTicket } from '../../../../main/db/types'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

/**
 * True when the Queue prompts UI should show for this ticket: Strict Verify + its
 * Reviewer sub-gate + the global queue toggle are on, and the ticket either has
 * no session yet (Todo — SDK unknown, allow authoring a batch) or its session is
 * a Claude Code CLI session. The engine's drain gate
 * (`isClaudeCliQueueFeatureActive`) additionally requires a live CLI session, so
 * a queue authored on a non-CLI ticket simply never drains via this path.
 */
export function useClaudeCliQueueFeatureActive(ticket: KanbanTicket): boolean {
  const enabled = useSettingsStore(
    (s) =>
      s.kanbanStrictVerifyEnabled &&
      (s.kanbanStrictVerifyReviewerEnabled ?? true) &&
      s.kanbanQueuePromptsEnabled
  )
  const sessionId = ticket.current_session_id
  const sdkOk = useSessionStore(
    useCallback(
      (s) => {
        // No session yet (Todo): allow — we can't know the SDK until launch.
        if (!sessionId) return true
        for (const sessions of s.sessionsByWorktree.values()) {
          const found = sessions.find((x) => x.id === sessionId)
          if (found) return found.agent_sdk === 'claude-code-cli'
        }
        // Session id set but not loaded yet → hide until we know it's CLI.
        return false
      },
      [sessionId]
    )
  )
  return enabled && sdkOk
}
