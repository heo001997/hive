import { useState } from 'react'
import { Locate, LocateFixed } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useKanbanStore, type TicketRef } from '@/stores/useKanbanStore'
import { WorkflowGraph } from './WorkflowGraph'
import { WorkflowLegend } from './WorkflowLegend'
import { useChainGraph } from './hooks/useChainGraph'

/**
 * Per-chain focus modal: a big DAG of the worktree-unioned chain containing the
 * focused ticket. Opened from `KanbanTicketModal`'s "View workflow" action via the
 * store's `workflowChainFocus`. Mounted once in `AppLayout` so any surface can open
 * it. Mirrors `KanbanTicketModal`'s large-dialog shell.
 */
export function WorkflowChainModal(): React.ReactElement | null {
  const focus = useKanbanStore((s) => s.workflowChainFocus)
  const setFocus = useKanbanStore((s) => s.setWorkflowChainFocus)
  const setSelectedTicketRef = useKanbanStore((s) => s.setSelectedTicketRef)
  const focusedTitle = useKanbanStore((s) =>
    focus
      ? (s.tickets.get(focus.projectId)?.find((t) => t.id === focus.ticketId)?.title ?? null)
      : null
  )
  const { nodes, edges, activeNodeId } = useChainGraph(focus)
  const [follow, setFollow] = useState(true)

  if (!focus) return null

  const openTicket = (ref: TicketRef): void => {
    setFocus(null)
    setSelectedTicketRef(ref)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) setFocus(null)
      }}
    >
      <DialogContent
        data-testid="workflow-chain-modal"
        className="flex h-[90vh] w-[96vw] max-w-[1920px] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="flex shrink-0 flex-row flex-wrap items-center gap-x-4 gap-y-2 space-y-0 border-b border-border/60 px-4 py-3 pr-12 text-left">
          <DialogTitle className="truncate text-sm">
            Workflow{focusedTitle ? ` — ${focusedTitle}` : ''}
          </DialogTitle>
          <WorkflowLegend />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFollow((v) => !v)}
            aria-pressed={follow}
            title={follow ? 'Auto-follow the running node (on)' : 'Auto-follow the running node (off)'}
            data-testid="workflow-chain-follow-toggle"
            className={cn('ml-auto gap-1.5', follow && 'bg-accent text-accent-foreground')}
          >
            {follow ? <LocateFixed className="h-4 w-4" /> : <Locate className="h-4 w-4" />}
            Follow
          </Button>
        </DialogHeader>

        <div className="relative min-h-0 flex-1">
          <WorkflowGraph
            nodes={nodes}
            edges={edges}
            activeNodeId={activeNodeId}
            follow={follow}
            showMiniMap
            onNodeOpen={openTicket}
            className="h-full w-full"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
