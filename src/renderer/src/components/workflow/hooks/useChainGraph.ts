import { useMemo } from 'react'
import { ticketKey, useKanbanStore, type TicketRef } from '@/stores/useKanbanStore'
import { buildChainGraph, type ChainGraphResult } from '../lib/workflow-graph'

const EMPTY: ChainGraphResult = { nodes: [], edges: [], activeNodeId: null, rootKey: null }

/**
 * Workflow graph for the single chain (worktree-unioned connected component) that
 * contains `ref`. Memoized on the root key + tickets + dependency map so live moves
 * re-render without extra wiring.
 */
export function useChainGraph(ref: TicketRef | null): ChainGraphResult {
  const projectId = ref?.projectId
  const projectTickets = useKanbanStore((s) => (projectId ? s.tickets.get(projectId) : undefined))
  const dependencyMap = useKanbanStore((s) => s.dependencyMap)
  const rootKey = ref ? ticketKey(ref.projectId, ref.ticketId) : null
  return useMemo(
    () => (rootKey ? buildChainGraph(rootKey, projectTickets ?? [], dependencyMap) : EMPTY),
    [rootKey, projectTickets, dependencyMap]
  )
}
