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

/**
 * Returns every ticket key DOWNSTREAM of `rootKey` — i.e. every ticket that
 * transitively depends on `rootKey` — EXCLUDING `rootKey` itself.
 *
 * Dependency edges are directed (`dependent → blocker`). "Downstream" means the
 * tickets blocked by `rootKey`: we follow the edges in reverse (`blocker →
 * dependent`), so from `rootKey` we reach the tickets that list it as a blocker,
 * then the tickets that depend on those, and so on.
 *
 * Used when a ticket is moved back to To Do: the tickets that depended on it can
 * no longer proceed, so they are pulled back to To Do too.
 */
export function getDownstreamDependentKeys(
  dependencyMap: Map<TicketKey, Set<TicketKey>>,
  rootKey: TicketKey
): TicketKey[] {
  // Build a reverse adjacency list: blocker → set of dependents.
  const dependentsOf = new Map<TicketKey, Set<TicketKey>>()
  for (const [dependent, blockers] of dependencyMap) {
    for (const blocker of blockers) {
      const set = dependentsOf.get(blocker) ?? new Set<TicketKey>()
      set.add(dependent)
      dependentsOf.set(blocker, set)
    }
  }

  // BFS following reverse edges from the root.
  const visited = new Set<TicketKey>([rootKey])
  const queue: TicketKey[] = [rootKey]
  while (queue.length > 0) {
    const current = queue.shift() as TicketKey
    for (const next of dependentsOf.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next)
        queue.push(next)
      }
    }
  }

  visited.delete(rootKey)
  return [...visited]
}
