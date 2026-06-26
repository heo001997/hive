import { useCallback, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArrowDown, ArrowUp, Check, ListOrdered, Pencil, Send, Trash2, X } from 'lucide-react'
import type { KanbanTicket } from '../../../../main/db/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/lib/toast'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useKanbanStore, ticketKey } from '@/stores/useKanbanStore'
import { useClaudeCliQueueFeatureActive } from './use-claude-cli-queue-feature'

/**
 * Queue prompts entry point (Claude CLI). Renders a compact button showing the
 * number of prompts queued; clicking it opens the full management dialog. Kept
 * tiny on purpose — the heavy CRUD UI lives in the popup so it doesn't crowd the
 * ticket modal. Renders nothing unless the feature is active for this ticket.
 */
export function ClaudeCliQueueSection({
  ticket
}: {
  ticket: KanbanTicket
}): React.JSX.Element | null {
  const active = useClaudeCliQueueFeatureActive(ticket)
  const count = useKanbanStore(
    useShallow((s) => (s.promptQueues[ticketKey(ticket.project_id, ticket.id)] ?? []).length)
  )
  const [open, setOpen] = useState(false)

  if (!active) return null

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={() => setOpen(true)}
        data-testid="claude-cli-queue-button"
      >
        <ListOrdered className="h-3.5 w-3.5" />
        <span>Prompt queue</span>
        <span
          className="ml-0.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-primary/15 px-1.5 py-0.5 text-[11px] font-semibold text-primary"
          data-testid="claude-cli-queue-count"
        >
          {count}
        </span>
      </Button>
      <ClaudeCliQueueDialog ticket={ticket} open={open} onOpenChange={setOpen} />
    </>
  )
}

/** The management popup: list (reorder / edit / delete) + composer + clear-all. */
function ClaudeCliQueueDialog({
  ticket,
  open,
  onOpenChange
}: {
  ticket: KanbanTicket
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const projectId = ticket.project_id
  const ticketId = ticket.id
  const sessionId = ticket.current_session_id
  const queue = useKanbanStore(
    useShallow((s) => s.promptQueues[ticketKey(projectId, ticketId)] ?? [])
  )
  const status = useWorktreeStatusStore((s) =>
    sessionId ? (s.sessionStatuses[sessionId]?.status ?? null) : null
  )
  const [text, setText] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const handleAdd = useCallback(() => {
    const value = text.trim()
    if (!value) return
    const store = useKanbanStore.getState()
    const busy = status === 'working' || status === 'planning'
    // Idle in-progress CLI session with an empty queue → start work now (the
    // first prompt). Otherwise enqueue; the drain enters it once verified.
    if (sessionId && !busy && queue.length === 0 && ticket.column === 'in_progress') {
      void store.startClaudeCliFollowup(projectId, ticketId, value)
      toast.success('Prompt sent')
    } else {
      store.addQueuedPrompt(projectId, ticketId, value)
      toast.success('Added to queue')
      void store.dispatchClaudeCliQueueIfReady(projectId, ticketId)
    }
    setText('')
  }, [text, status, sessionId, queue.length, ticket.column, projectId, ticketId])

  const startEdit = useCallback((id: string, content: string) => {
    setEditingId(id)
    setEditText(content)
  }, [])

  const saveEdit = useCallback(() => {
    if (!editingId) return
    useKanbanStore.getState().updateQueuedPrompt(projectId, ticketId, editingId, editText)
    setEditingId(null)
    setEditText('')
  }, [editingId, editText, projectId, ticketId])

  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setEditText('')
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="claude-cli-queue-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListOrdered className="h-4 w-4" />
            Prompt queue
            <span className="text-sm font-normal text-muted-foreground">({queue.length})</span>
          </DialogTitle>
          <DialogDescription>
            Prompts run one at a time — the next is entered after the current step is verified
            complete in Review. Reorder, edit, or remove them below.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[40vh] space-y-1.5 overflow-y-auto" data-testid="claude-cli-queue-list">
          {queue.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No prompts queued yet. Add one below.
            </p>
          ) : (
            queue.map((prompt, index) => (
              <div
                key={prompt.id}
                className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5"
              >
                <span className="mt-1.5 shrink-0 font-mono text-[10px] text-muted-foreground">
                  {index + 1}.
                </span>
                {editingId === prompt.id ? (
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          saveEdit()
                        }
                        if (e.key === 'Escape') cancelEdit()
                      }}
                      className="min-h-[56px] text-sm"
                      autoFocus
                      data-testid="claude-cli-queue-edit-input"
                    />
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={cancelEdit}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-6 gap-1 px-2 text-xs"
                        disabled={!editText.trim()}
                        onClick={saveEdit}
                        data-testid="claude-cli-queue-edit-save"
                      >
                        <Check className="h-3 w-3" />
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words py-0.5 text-sm text-foreground/90">
                      {prompt.content}
                    </span>
                    <div className="flex shrink-0 items-center">
                      <button
                        type="button"
                        onClick={() =>
                          useKanbanStore.getState().moveQueuedPrompt(projectId, ticketId, prompt.id, 'up')
                        }
                        disabled={index === 0}
                        className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                        aria-label="Move up"
                        data-testid="claude-cli-queue-move-up"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          useKanbanStore
                            .getState()
                            .moveQueuedPrompt(projectId, ticketId, prompt.id, 'down')
                        }
                        disabled={index === queue.length - 1}
                        className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                        aria-label="Move down"
                        data-testid="claude-cli-queue-move-down"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => startEdit(prompt.id, prompt.content)}
                        className="p-1 text-muted-foreground hover:text-foreground"
                        aria-label="Edit prompt"
                        data-testid="claude-cli-queue-edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          useKanbanStore.getState().removeQueuedPrompt(projectId, ticketId, prompt.id)
                        }
                        className="p-1 text-muted-foreground hover:text-destructive"
                        aria-label="Remove prompt"
                        data-testid="claude-cli-queue-remove"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        <div className="space-y-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleAdd()
              }
            }}
            placeholder="Add a prompt to the queue... (Enter to add, Shift+Enter for newline)"
            className="min-h-[60px] text-sm"
            data-testid="claude-cli-queue-input"
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              disabled={!text.trim()}
              onClick={handleAdd}
              data-testid="claude-cli-queue-add-btn"
            >
              <Send className="h-3.5 w-3.5" />
              {(status === 'working' || status === 'planning' || queue.length > 0) ||
              !sessionId ||
              ticket.column !== 'in_progress'
                ? 'Add to queue'
                : 'Send'}
            </Button>
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-destructive"
            disabled={queue.length === 0}
            onClick={() => useKanbanStore.getState().clearQueuedPrompts(projectId, ticketId)}
            data-testid="claude-cli-queue-clear"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear all
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
