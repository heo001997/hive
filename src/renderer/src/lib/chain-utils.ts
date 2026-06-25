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
 * Returns every ticket key in the dependency chain (connected component)
 * containing `rootKey` — INCLUDING `rootKey` — ordered so that blockers come
 * before the tickets that depend on them. This is the chain's execution order:
 * "first task (chain parent) → last task".
 *
 * For a linear chain A → B → C (B depends on A, C depends on B) the result is
 * [A, B, C]. The order is a topological sort of the connected component, so it
 * also handles diamonds / fan-outs (every blocker precedes its dependents).
 *
 * Cycles (which the dependency UI tries to prevent) are tolerated: a node whose
 * blockers are still on the recursion stack is simply not re-entered, so the
 * function always terminates and emits every component member exactly once.
 */
export function getChainExecutionOrder(
  dependencyMap: Map<TicketKey, Set<TicketKey>>,
  rootKey: TicketKey
): TicketKey[] {
  // The whole undirected component, including the root.
  const component = new Set<TicketKey>([rootKey, ...getChainTicketKeys(dependencyMap, rootKey)])

  const ordered: TicketKey[] = []
  const visited = new Set<TicketKey>()
  const onStack = new Set<TicketKey>()

  const visit = (key: TicketKey): void => {
    if (visited.has(key) || onStack.has(key)) return
    onStack.add(key)
    // Emit this ticket's blockers first so they land ahead of it.
    for (const blocker of dependencyMap.get(key) ?? []) {
      if (component.has(blocker)) visit(blocker)
    }
    onStack.delete(key)
    visited.add(key)
    ordered.push(key)
  }

  // Start from the root for deterministic ordering, then sweep any remaining
  // component members (downstream dependents, diamond branches) not reached by
  // following the root's own blockers.
  visit(rootKey)
  for (const key of component) visit(key)
  return ordered
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
