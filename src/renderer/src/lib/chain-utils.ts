import type { TicketKey } from '@/stores/useKanbanStore'

/**
 * Returns every ticket key in the dependency chain (connected component)
 * containing `rootKey`, EXCLUDING `rootKey` itself.
 *
 * Dependency edges are directed (`dependent → blocker`), but a "chain" is the
 * undirected connected component: starting from one ticket we want to reach
 * both the tickets it blocks and the tickets that block it, transitively.
 */
export function getChainTicketKeys(
  dependencyMap: Map<TicketKey, Set<TicketKey>>,
  rootKey: TicketKey
): TicketKey[] {
  // Build an undirected adjacency list from the directed dependency edges.
  const adjacency = new Map<TicketKey, Set<TicketKey>>()
  const link = (a: TicketKey, b: TicketKey): void => {
    const set = adjacency.get(a) ?? new Set<TicketKey>()
    set.add(b)
    adjacency.set(a, set)
  }
  for (const [dependent, blockers] of dependencyMap) {
    for (const blocker of blockers) {
      link(dependent, blocker)
      link(blocker, dependent)
    }
  }

  // BFS over the undirected graph from the root.
  const visited = new Set<TicketKey>([rootKey])
  const queue: TicketKey[] = [rootKey]
  while (queue.length > 0) {
    const current = queue.shift() as TicketKey
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next)
        queue.push(next)
      }
    }
  }

  visited.delete(rootKey)
  return [...visited]
}
