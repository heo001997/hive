import { describe, expect, it } from 'vitest'

import {
  buildShardGateConfig,
  conditionGateConfigOf,
  decideShardGate,
  isConditionGate,
  isShardGate,
  type ShardNextSpec
} from '../condition-gate'

/**
 * The DETERMINISTIC shard loop (`mode: 'shard'`) — pure routing + config round-trip.
 * The engine that consumes these (`useKanbanStore.runShardGate`) is exercised by a
 * live board; here we lock the pure decisions the store depends on.
 */
describe('decideShardGate', () => {
  it('advances on DONE', () => {
    expect(decideShardGate('DONE', 3, 50)).toEqual({ kind: 'advance' })
  })

  it('continues to the next run on CONTINUE under the cap', () => {
    expect(decideShardGate('CONTINUE', 2, 50)).toEqual({ kind: 'continue', round: 3 })
    expect(decideShardGate('CONTINUE', 0, 50)).toEqual({ kind: 'continue', round: 1 })
  })

  it('blocks (never loops forever) when CONTINUE hits the cap', () => {
    const d = decideShardGate('CONTINUE', 50, 50)
    expect(d.kind).toBe('block')
    if (d.kind === 'block') expect(d.reason).toMatch(/cap reached/i)
  })

  it('reads only the LAST token so a predicate may echo diagnostics first', () => {
    expect(decideShardGate('resolved FEATURE_DIR=.hive-e2e/x\n0 PENDING\nDONE', 1, 50)).toEqual({
      kind: 'advance'
    })
    expect(decideShardGate('checking...\nCONTINUE\n', 1, 50)).toEqual({ kind: 'continue', round: 2 })
  })

  it('is case-insensitive on the verdict token', () => {
    expect(decideShardGate('done', 1, 50)).toEqual({ kind: 'advance' })
    expect(decideShardGate('Continue', 1, 50)).toEqual({ kind: 'continue', round: 2 })
  })

  it('tolerates trailing diagnostics/punctuation after the verdict (scans for a known token)', () => {
    expect(decideShardGate('DONE (0 pending)', 1, 50)).toEqual({ kind: 'advance' })
    expect(decideShardGate('CONTINUE # 3 files left', 1, 50)).toEqual({ kind: 'continue', round: 2 })
    // last RECOGNIZED verdict wins even if a non-verdict token trails it
    expect(decideShardGate('CONTINUE\nDONE\nok', 1, 50)).toEqual({ kind: 'advance' })
  })

  it('never fails open — BLOCK, junk, and empty all block', () => {
    expect(decideShardGate('BLOCK', 1, 50).kind).toBe('block')
    expect(decideShardGate('wat', 1, 50).kind).toBe('block')
    expect(decideShardGate('', 1, 50).kind).toBe('block')
    expect(decideShardGate('   \n  ', 1, 50).kind).toBe('block')
  })
})

describe('buildShardGateConfig + conditionGateConfigOf round-trip', () => {
  const reportSpec: ShardNextSpec = {
    command: '/speckit-e2e-report',
    label: 'E2E Report',
    key: 'e2e-report',
    predicate: 'echo DONE'
  }
  const executeSpec: ShardNextSpec = {
    command: '/speckit-e2e-execute',
    label: 'E2E Execute',
    key: 'e2e-execute',
    predicate: 'grep -c PENDING x || true',
    maxRounds: 40,
    next: reportSpec
  }

  it('produces a config that reads as a condition gate AND a shard gate', () => {
    const cfg = buildShardGateConfig(executeSpec)
    expect(isConditionGate(cfg)).toBe(true)
    expect(isShardGate(cfg)).toBe(true)
  })

  it('round-trips every shard field, including the recursively-nested next phase', () => {
    const cfg = buildShardGateConfig(executeSpec)
    const read = conditionGateConfigOf(cfg)
    expect(read.mode).toBe('shard')
    expect(read.command).toBe('/speckit-e2e-execute')
    expect(read.label).toBe('E2E Execute')
    expect(read.key).toBe('e2e-execute')
    expect(read.predicate).toBe('grep -c PENDING x || true')
    expect(read.maxRounds).toBe(40)
    // The whole tail nests: execute → report, so the chain self-extends on DONE.
    expect(read.next?.command).toBe('/speckit-e2e-report')
    expect(read.next?.key).toBe('e2e-report')
    expect(read.next?.next).toBeUndefined() // report is terminal
  })

  it('omits next on a terminal phase', () => {
    const read = conditionGateConfigOf(buildShardGateConfig(reportSpec))
    expect(read.mode).toBe('shard')
    expect(read.next).toBeUndefined()
  })

  it('is NOT mistaken for a judge gate — a judge gate reads mode undefined', () => {
    // A plain (judge) gate has no mode; isShardGate must be false for it.
    const read = conditionGateConfigOf({
      enabled: true,
      states: { review: { during: [{ id: 'g', type: 'evaluate', config: {} }] } }
    })
    expect(read.mode).toBeUndefined()
    expect(isShardGate({
      enabled: true,
      states: { review: { during: [{ id: 'g', type: 'evaluate', config: {} }] } }
    })).toBe(false)
  })
})
