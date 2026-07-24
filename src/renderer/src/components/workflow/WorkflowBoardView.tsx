import { useEffect, useState } from 'react'
import { LocateFixed, Locate, Workflow as WorkflowIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useKanbanStore, type TicketRef } from '@/stores/useKanbanStore'
import { KanbanTicketModal } from '@/components/kanban/KanbanTicketModal'
import { WorkflowGraph } from './WorkflowGraph'
import { WorkflowLegend } from './WorkflowLegend'
import { useBoardGraph } from './hooks/useBoardGraph'

/**
 * Board-level "Workflow" pane: every ticket chain rendered as its own DAG lane,
 * colored by live status and auto-following the running node. Double-clicking a
 * node opens the ticket detail (`<KanbanTicketModal/>`, mounted here so this pane
 * shares the board's modal behavior without the board being mounted).
 */
export function WorkflowBoardView({ projectId }: { projectId: string }): React.ReactElement {
  const { nodes, edges, activeNodeId } = useBoardGraph(projectId)
  const [follow, setFollow] = useState(true)
  const setSelectedTicketRef = useKanbanStore((s) => s.setSelectedTicketRef)
  const loadTickets = useKanbanStore((s) => s.loadTickets)
  const loadDependencies = useKanbanStore((s) => s.loadDependencies)

  // Ensure tickets + dependencies for this project are loaded even when the user
  // jumps straight to the Workflow view without ever opening the board.
  useEffect(() => {
    if (!projectId) return
    void loadTickets(projectId)
    void loadDependencies(projectId)
  }, [projectId, loadTickets, loadDependencies])

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="workflow-board-view">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <WorkflowIcon className="h-4 w-4" />
          Workflow
        </div>
        <WorkflowLegend />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setFollow((v) => !v)}
          aria-pressed={follow}
          title={follow ? 'Auto-follow the running node (on)' : 'Auto-follow the running node (off)'}
          data-testid="workflow-follow-toggle"
          className={cn('ml-auto gap-1.5', follow && 'bg-accent text-accent-foreground')}
        >
          {follow ? <LocateFixed className="h-4 w-4" /> : <Locate className="h-4 w-4" />}
          Follow
        </Button>
      </header>

      <WorkflowGraph
        nodes={nodes}
        edges={edges}
        activeNodeId={activeNodeId}
        follow={follow}
        showMiniMap
        onNodeOpen={(ref: TicketRef) => setSelectedTicketRef(ref)}
        className="min-h-0 flex-1"
      />

      <KanbanTicketModal />
    </div>
  )
}
