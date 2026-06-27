import { useCallback } from 'react'
import { CheckCheck } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { KanbanTicket } from '../../../../main/db/types'

/**
 * Per-ticket "auto-approve plan" switch. Reads/writes the ticket's
 * `auto_approve_plan` flag and, when the ticket has a live session, mirrors the
 * choice into the in-memory per-session override so the runtime effect in
 * ClaudeCliSessionView picks it up immediately (no reload needed).
 *
 * Writes are immediate (not draft-gated) to match the live session-header
 * toggle — a switch that persists on flip. Applies to `claude-code-cli`
 * plan-mode sessions only; the hint says so since other surfaces (e.g. the Edit
 * modal for a TODO ticket) don't yet know which backend will run.
 */
export function AutoApprovePlanToggle({
  ticket,
  className
}: {
  ticket: KanbanTicket
  className?: string
}): React.JSX.Element {
  const updateTicket = useKanbanStore((s) => s.updateTicket)
  const defaultOn = useSettingsStore((s) => s.autoApprovePlanEnabled)
  const enabled = ticket.auto_approve_plan === true

  const handleChange = useCallback(
    (next: boolean) => {
      void updateTicket(ticket.id, ticket.project_id, { auto_approve_plan: next })
      if (ticket.current_session_id) {
        useSessionStore.getState().setAutoApprovePlan(ticket.current_session_id, next)
      }
    },
    [updateTicket, ticket.id, ticket.project_id, ticket.current_session_id]
  )

  return (
    <div
      className={cn(
        'space-y-1.5 rounded-md border border-border/50 bg-muted/20 px-3 py-2.5',
        className
      )}
      data-testid="ticket-auto-approve-plan-row"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <CheckCheck className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
          Auto-approve plan
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={handleChange}
          data-testid="ticket-auto-approve-plan-toggle"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Claude CLI only. When a plan-mode session finishes planning, auto-pick the menu option
        matching your Settings match text
        {defaultOn ? '' : ' (set one in Settings → General)'}.
      </p>
    </div>
  )
}
