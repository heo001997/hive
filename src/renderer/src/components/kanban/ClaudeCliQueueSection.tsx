import { useCallback, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ListOrdered, Send, X } from 'lucide-react'
import type { KanbanTicket } from '../../../../main/db/types'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useClaudeCliQueueFeatureActive } from './use-claude-cli-queue-feature'

/**
 * Prompt-queue UI for a Claude Code CLI ticket (Queue prompts feature). Shows the
 * pending follow-up queue (count + each prompt, with remove) and, when
 * `showComposer` is set, a composer to add more.
 *
 * Sending logic mirrors the engine's contract:
 *  - idle session + empty queue → send the prompt now (the first prompt starts work)
 *  - otherwise → enqueue it (auto-queue while busy); it runs after the ticket
 *    reaches Review and is verified complete by Strict Verify, one step at a time.
 *
 * Renders nothing unless the feature is active. With no composer and an empty
 * queue it also renders nothing (e.g. the Review view before anything is queued).
 */
export function ClaudeCliQueueSection({
  ticket,
  showComposer = false
}: {
  ticket: KanbanTicket
  showComposer?: boolean
}): React.JSX.Element | null {
  const active = useClaudeCliQueueFeatureActive(ticket)
  const sessionId = ticket.current_session_id
  const queue = useSessionStore(
    useShallow((s) => (sessionId ? (s.pendingFollowUpMessages.get(sessionId) ?? []) : []))
  )
  const status = useWorktreeStatusStore((s) =>
    sessionId ? (s.sessionStatuses[sessionId]?.status ?? null) : null
  )
  const [text, setText] = useState('')

  const handleSend = useCallback(() => {
    const value = text.trim()
    if (!value || !sessionId) return
    const sessions = useSessionStore.getState()
    const current = sessions.pendingFollowUpMessages.get(sessionId) ?? []
    const busy = status === 'working' || status === 'planning'
    if (!busy && current.length === 0) {
      void useKanbanStore.getState().startClaudeCliFollowup(ticket.project_id, ticket.id, value)
      toast.success('Prompt sent')
    } else {
      sessions.enqueueFollowUpMessage(sessionId, value)
      toast.success('Prompt queued — runs after this step verifies complete')
      void useKanbanStore.getState().dispatchClaudeCliQueueIfReady(ticket.project_id, ticket.id)
    }
    setText('')
  }, [text, sessionId, status, ticket.project_id, ticket.id])

  const handleRemove = useCallback(
    (index: number) => {
      if (!sessionId) return
      const sessions = useSessionStore.getState()
      const current = sessions.pendingFollowUpMessages.get(sessionId) ?? []
      sessions.setPendingFollowUpMessages(
        sessionId,
        current.filter((_, i) => i !== index)
      )
    },
    [sessionId]
  )

  if (!active || !sessionId) return null
  if (!showComposer && queue.length === 0) return null

  return (
    <div className="flex-shrink-0 space-y-2 rounded-md border border-border bg-muted/20 p-3" data-testid="claude-cli-queue-section">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ListOrdered className="h-3.5 w-3.5" />
        <span>Prompt queue</span>
        {queue.length > 0 && (
          <span
            className="ml-0.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-primary/15 px-1.5 py-0.5 text-[11px] font-semibold text-primary"
            data-testid="claude-cli-queue-count"
          >
            {queue.length}
          </span>
        )}
      </div>

      {queue.length > 0 && (
        <ul className="space-y-1" data-testid="claude-cli-queue-list">
          {queue.map((prompt, index) => (
            <li
              key={`${index}-${prompt.slice(0, 16)}`}
              className="flex items-start gap-2 rounded-md bg-background/60 px-2 py-1.5 text-xs"
            >
              <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted-foreground">
                {index + 1}.
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground/90 line-clamp-3">
                {prompt}
              </span>
              <button
                type="button"
                onClick={() => handleRemove(index)}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Remove queued prompt"
                data-testid="claude-cli-queue-remove"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {showComposer && (
        <div className="space-y-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="Queue another prompt... (Enter to add, Shift+Enter for newline)"
            className="min-h-[60px] text-sm"
            data-testid="claude-cli-queue-input"
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              className={cn('gap-1.5')}
              disabled={!text.trim()}
              onClick={handleSend}
              data-testid="claude-cli-queue-add-btn"
            >
              <Send className="h-3.5 w-3.5" />
              {status === 'working' || status === 'planning' || queue.length > 0
                ? 'Add to queue'
                : 'Send'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
