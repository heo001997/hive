import { describe, test, expect } from 'vitest'
import { getChainTicketKeys } from './chain-utils'

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
