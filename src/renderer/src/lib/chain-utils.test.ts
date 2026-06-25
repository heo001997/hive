import { describe, test, expect } from 'vitest'
import {
  getChainTicketKeys,
  getChainExecutionOrder,
  getDownstreamDependentKeys
} from './chain-utils'

// dependencyMap is Map<dependentKey, Set<blockerKey>> — "dependent depends on blocker".
function makeMap(edges: Array<[string, string]>): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const [dependent, blocker] of edges) {
    const set = map.get(dependent) ?? new Set<string>()
    set.add(blocker)
    map.set(dependent, set)
  }
  return map
}

describe('getChainTicketKeys', () => {
  test('returns empty for a ticket with no dependencies', () => {
    const map = makeMap([['b', 'a']])
    expect(getChainTicketKeys(map, 'standalone')).toEqual([])
  })

  test('finds downstream tickets that depend on the root', () => {
    // a → b → c  (b depends on a, c depends on b). Root = a.
    const map = makeMap([
      ['b', 'a'],
      ['c', 'b']
    ])
    expect(getChainTicketKeys(map, 'a').sort()).toEqual(['b', 'c'])
  })

  test('finds upstream blockers too (traversal is undirected)', () => {
    const map = makeMap([
      ['b', 'a'],
      ['c', 'b']
    ])
    // Root = c reaches b and a through blocker edges.
    expect(getChainTicketKeys(map, 'c').sort()).toEqual(['a', 'b'])
  })

  test('reaches the whole connected component from a middle node', () => {
    const map = makeMap([
      ['b', 'a'],
      ['c', 'b'],
      ['d', 'c']
    ])
    expect(getChainTicketKeys(map, 'b').sort()).toEqual(['a', 'c', 'd'])
  })

  test('excludes the root itself', () => {
    const map = makeMap([['b', 'a']])
    expect(getChainTicketKeys(map, 'a')).not.toContain('a')
  })

  test('does not cross into a separate chain', () => {
    const map = makeMap([
      ['b', 'a'], // chain 1
      ['y', 'x'] // chain 2
    ])
    expect(getChainTicketKeys(map, 'a')).toEqual(['b'])
  })

  test('handles a diamond / shared blocker without duplicates', () => {
    // c depends on both a and b. Root = a reaches c, then c's other blocker b.
    const map = makeMap([
      ['c', 'a'],
      ['c', 'b']
    ])
    expect(getChainTicketKeys(map, 'a').sort()).toEqual(['b', 'c'])
  })
})

describe('getChainExecutionOrder', () => {
  test('returns just the root for a ticket with no dependencies', () => {
    const map = makeMap([['b', 'a']])
    expect(getChainExecutionOrder(map, 'standalone')).toEqual(['standalone'])
  })

  test('orders a linear chain first task → last task (blockers before dependents)', () => {
    // a → b → c (b depends on a, c depends on b). Parent a runs first.
    const map = makeMap([
      ['b', 'a'],
      ['c', 'b']
    ])
    expect(getChainExecutionOrder(map, 'a')).toEqual(['a', 'b', 'c'])
  })

  test('produces a topological order even when starting from the middle', () => {
    const map = makeMap([
      ['b', 'a'],
      ['c', 'b'],
      ['d', 'c']
    ])
    expect(getChainExecutionOrder(map, 'b')).toEqual(['a', 'b', 'c', 'd'])
  })

  test('includes the root', () => {
    const map = makeMap([['b', 'a']])
    expect(getChainExecutionOrder(map, 'a')).toContain('a')
  })

  test('keeps every blocker ahead of its dependent in a diamond', () => {
    // c depends on both a and b.
    const map = makeMap([
      ['c', 'a'],
      ['c', 'b']
    ])
    const order = getChainExecutionOrder(map, 'a')
    expect(order.sort()).toEqual(['a', 'b', 'c'])
    expect(order.indexOf('c')).toBeGreaterThan(order.indexOf('a'))
    expect(order.indexOf('c')).toBeGreaterThan(order.indexOf('b'))
  })

  test('does not cross into a separate chain', () => {
    const map = makeMap([
      ['b', 'a'],
      ['y', 'x']
    ])
    expect(getChainExecutionOrder(map, 'a')).toEqual(['a', 'b'])
  })

  test('terminates and emits each member once when a cycle exists', () => {
    // a → b → a (mutual). Should not loop forever; each appears once.
    const map = makeMap([
      ['b', 'a'],
      ['a', 'b']
    ])
    expect(getChainExecutionOrder(map, 'a').sort()).toEqual(['a', 'b'])
  })
})

describe('getDownstreamDependentKeys', () => {
  // "X link to Y" means Y depends on X, i.e. edge [dependent=Y, blocker=X].
  // Chain 1→2→3→4→5: 2 dep 1, 3 dep 2, 4 dep 3, 5 dep 4.
  const chain = makeMap([
    ['2', '1'],
    ['3', '2'],
    ['4', '3'],
    ['5', '4']
  ])

  test('returns empty for a ticket nothing depends on', () => {
    expect(getDownstreamDependentKeys(chain, '5')).toEqual([])
  })

  test('returns the whole downstream from the chain head', () => {
    expect(getDownstreamDependentKeys(chain, '1').sort()).toEqual(['2', '3', '4', '5'])
  })

  test('returns only downstream, not upstream blockers', () => {
    // Root = 3 reaches 4 and 5 (depend on it) but NOT 1 or 2 (it depends on them).
    expect(getDownstreamDependentKeys(chain, '3').sort()).toEqual(['4', '5'])
  })

  test('excludes the root itself', () => {
    expect(getDownstreamDependentKeys(chain, '1')).not.toContain('1')
  })

  test('does not cross into a separate chain', () => {
    const map = makeMap([
      ['b', 'a'], // chain 1
      ['y', 'x'] // chain 2
    ])
    expect(getDownstreamDependentKeys(map, 'a')).toEqual(['b'])
  })

  test('handles fan-out (one blocker, many dependents) without duplicates', () => {
    // b and c both depend on a; d depends on both b and c.
    const map = makeMap([
      ['b', 'a'],
      ['c', 'a'],
      ['d', 'b'],
      ['d', 'c']
    ])
    expect(getDownstreamDependentKeys(map, 'a').sort()).toEqual(['b', 'c', 'd'])
  })
})
