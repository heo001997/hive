import { useMemo } from 'react'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { buildBoardGraph, type WorkflowGraphResult } from '../lib/workflow-graph'

/**
 * Board-level workflow graph for one project. Subscribes to the store's tickets +
 * dependency map; the build is O(N+E) and memoized on those two references. Optimistic
 * ticket moves replace the project's ticket array reference, so the memo recomputes
 * for free — no extra plumbing.
 */
export function useBoardGraph(projectId: string): WorkflowGraphResult {
  const projectTickets = useKanbanStore((s) => s.tickets.get(projectId))
  const dependencyMap = useKanbanStore((s) => s.dependencyMap)
  return useMemo(
    () => buildBoardGraph(projectTickets ?? [], dependencyMap),
    [projectTickets, dependencyMap]
  )
}
