import { useCallback, useEffect, useState } from 'react'
import { Archive, Trash2, X } from 'lucide-react'
import { parseTicketKey, useKanbanStore } from '@/stores/useKanbanStore'
import { Button } from '@/components/ui/button'
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
import { toast } from '@/lib/toast'

// Run an action over every selected ticket, tolerating per-ticket failures, and
// report a single aggregate toast. Returns the number that succeeded.
async function runBulk(
  keys: Set<string>,
  action: (ticketId: string, projectId: string) => Promise<unknown>
): Promise<number> {
  const results = await Promise.allSettled(
    Array.from(keys, (key) => {
      const { projectId, ticketId } = parseTicketKey(key)
      return action(ticketId, projectId)
    })
  )
  return results.filter((r) => r.status === 'fulfilled').length
}

/**
 * Floating action bar shown while one or more tickets are multi-selected
 * (via marquee drag). Offers bulk archive / delete and a clear button.
 */
export function KanbanSelectionBar() {
  const selectedKeys = useKanbanStore((s) => s.selectedTicketKeys)
  const clearSelection = useKanbanStore((s) => s.clearSelectedTicketKeys)
  const archiveTicket = useKanbanStore((s) => s.archiveTicket)
  const deleteTicket = useKanbanStore((s) => s.deleteTicket)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  const count = selectedKeys.size

  // Escape clears the selection (only while something is selected).
  useEffect(() => {
    if (count === 0) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showDeleteConfirm) clearSelection()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [count, showDeleteConfirm, clearSelection])

  const handleArchive = useCallback(async () => {
    setBusy(true)
    const keys = new Set(useKanbanStore.getState().selectedTicketKeys)
    const ok = await runBulk(keys, archiveTicket)
    setBusy(false)
    clearSelection()
    if (ok > 0) toast.success(`Archived ${ok} ticket${ok === 1 ? '' : 's'}`)
    if (ok < keys.size) toast.error(`Failed to archive ${keys.size - ok} ticket(s)`)
  }, [archiveTicket, clearSelection])

  const handleDelete = useCallback(async () => {
    setShowDeleteConfirm(false)
    setBusy(true)
    const keys = new Set(useKanbanStore.getState().selectedTicketKeys)
    const ok = await runBulk(keys, deleteTicket)
    setBusy(false)
    clearSelection()
    if (ok > 0) toast.success(`Deleted ${ok} ticket${ok === 1 ? '' : 's'}`)
    if (ok < keys.size) toast.error(`Failed to delete ${keys.size - ok} ticket(s)`)
  }, [deleteTicket, clearSelection])

  if (count === 0) return null

  return (
    <>
      <div
        data-testid="kanban-selection-bar"
        className="pointer-events-auto fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-lg"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <span className="text-sm font-medium">
          {count} selected
        </span>
        <div className="mx-1 h-5 w-px bg-border" />
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={handleArchive}
          data-testid="selection-archive-btn"
        >
          <Archive className="h-4 w-4 mr-1.5" />
          Archive
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setShowDeleteConfirm(true)}
          data-testid="selection-delete-btn"
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="h-4 w-4 mr-1.5" />
          Delete
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={clearSelection}
          data-testid="selection-clear-btn"
          aria-label="Clear selection"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent data-testid="selection-delete-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {count} ticket{count === 1 ? '' : 's'}</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the selected ticket{count === 1 ? '' : 's'} and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
