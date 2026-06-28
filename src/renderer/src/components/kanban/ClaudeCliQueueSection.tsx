import { useCallback, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ListOrdered,
  Paperclip,
  Pencil,
  Send,
  Trash2,
  X
} from 'lucide-react'
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
import { useKanbanStore, ticketKey, type QueuedAttachment } from '@/stores/useKanbanStore'
import { useClaudeCliQueueFeatureActive } from './use-claude-cli-queue-feature'
import { AttachmentPreview, type FileAttachment } from '@/components/sessions/AttachmentPreview'
import { MAX_ATTACHMENTS } from '@/lib/file-attachment-utils'
import { useImagePaste } from '@/hooks/useImagePaste'
import { attachmentApi } from '@/api/attachment-api'
import { fileApi } from '@/api/file-api'

/** A composer-tray attachment; `materialized` images live in the attachments dir. */
type ComposerAttachment = QueuedAttachment & { materialized: boolean }

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}

function mimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

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
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const addAttachment = useCallback((att: ComposerAttachment) => {
    setAttachments((prev) => {
      if (prev.length >= MAX_ATTACHMENTS) {
        toast.error(`Maximum ${MAX_ATTACHMENTS} attachments allowed`)
        return prev
      }
      return [...prev, att]
    })
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id)
      // Pasted/dropped images were materialized into the attachments dir — drop
      // the orphaned file. Picked files reference the user's real path: leave them.
      if (removed?.materialized) attachmentApi.deleteImage(removed.filePath).catch(() => {})
      return prev.filter((a) => a.id !== id)
    })
  }, [])

  // Paste / drag-drop of images: materialize to disk, then reference by path.
  const { isDragOver, handlePaste, handleDragOver, handleDragEnter, handleDragLeave, handleDrop } =
    useImagePaste({
      maxAttachments: MAX_ATTACHMENTS,
      currentCount: attachments.length,
      onAttach: (img) =>
        addAttachment({
          id: crypto.randomUUID(),
          name: img.label,
          mime: mimeFromName(img.label),
          filePath: img.url,
          materialized: true
        })
    })

  // Explicit file picker: keep the user's real path (works for any file type).
  const handleFilesPicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files) {
        for (const file of Array.from(files)) {
          addAttachment({
            id: crypto.randomUUID(),
            name: file.name,
            mime: file.type || mimeFromName(file.name),
            filePath: fileApi.getPathForFile(file),
            materialized: false
          })
        }
      }
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [addAttachment]
  )

  const handleAdd = useCallback(() => {
    const value = text.trim()
    if (!value && attachments.length === 0) return
    const queued: QueuedAttachment[] = attachments.map((a) => ({
      id: a.id,
      name: a.name,
      mime: a.mime,
      filePath: a.filePath
    }))
    const store = useKanbanStore.getState()
    const busy = status === 'working' || status === 'planning'
    // Idle in-progress CLI session with an empty queue → start work now (the
    // first prompt). Otherwise enqueue; the drain enters it once verified.
    if (sessionId && !busy && queue.length === 0 && ticket.column === 'in_progress') {
      void store.startClaudeCliFollowup(projectId, ticketId, value, queued)
      toast.success('Prompt sent')
    } else {
      store.addQueuedPrompt(projectId, ticketId, value, queued)
      toast.success('Added to queue')
      void store.dispatchClaudeCliQueueIfReady(projectId, ticketId)
    }
    setText('')
    // The files now belong to the queued prompt — clear the tray without
    // deleting them (don't call removeAttachment, which would unlink images).
    setAttachments([])
  }, [text, attachments, status, sessionId, queue.length, ticket.column, projectId, ticketId])

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

  // Closing with attachments still in the tray (never added to the queue) leaves
  // materialized images orphaned on disk — unlink them on the way out.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && attachments.length > 0) {
        for (const a of attachments) {
          if (a.materialized) attachmentApi.deleteImage(a.filePath).catch(() => {})
        }
        setAttachments([])
      }
      onOpenChange(next)
    },
    [attachments, onOpenChange]
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-lg"
        data-testid="claude-cli-queue-dialog"
        onPaste={handlePaste}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-primary">
            Drop images to attach
          </div>
        )}
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
                    <div className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
                      {prompt.content && (
                        <span className="whitespace-pre-wrap break-words text-sm text-foreground/90">
                          {prompt.content}
                        </span>
                      )}
                      {prompt.attachments && prompt.attachments.length > 0 && (
                        <div
                          className="flex flex-wrap gap-1"
                          data-testid="claude-cli-queue-item-attachments"
                        >
                          {prompt.attachments.map((a) => (
                            <span
                              key={a.id}
                              title={a.filePath}
                              className="inline-flex max-w-[180px] items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                            >
                              <Paperclip className="h-3 w-3 shrink-0" />
                              <span className="truncate">{a.name}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
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
          {attachments.length > 0 && (
            <div className="rounded-md border border-border/60 bg-muted/10">
              <AttachmentPreview
                fileAttachments={attachments.map(
                  (a): FileAttachment => ({
                    kind: 'path',
                    id: a.id,
                    name: a.name,
                    mime: a.mime,
                    filePath: a.filePath
                  })
                )}
                onRemove={removeAttachment}
              />
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFilesPicked}
            data-testid="claude-cli-queue-file-input"
          />
          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={attachments.length >= MAX_ATTACHMENTS}
              onClick={() => fileInputRef.current?.click()}
              title="Attach file or image (or paste / drop an image)"
              aria-label="Attach file or image"
              data-testid="claude-cli-queue-attach"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              disabled={!text.trim() && attachments.length === 0}
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
