import { describe, expect, it } from 'vitest'

import { buildShardGateConfig, type ShardNextSpec } from '@shared/lib/condition-gate'
import { buildShardPhaseDraft, parseShardRun } from '../ticket-lifecycle'

describe('parseShardRun', () => {
  it('reads the run number from a numbered title', () => {
    expect(parseShardRun('E2E Execute (run 3)')).toBe(3)
    expect(parseShardRun('E2E Execute (run 12)')).toBe(12)
  })
  it('returns 0 for a base phase ticket (no run suffix)', () => {
    expect(parseShardRun('E2E Execute')).toBe(0)
    expect(parseShardRun('')).toBe(0)
    expect(parseShardRun(null)).toBe(0)
    expect(parseShardRun(undefined)).toBe(0)
  })
  it('does not confuse the gate round suffix for a run', () => {
    expect(parseShardRun('Review (gate, round 2) — 99')).toBe(0)
  })
})

describe('buildShardPhaseDraft', () => {
  const spec: ShardNextSpec = {
    command: '/speckit-e2e-execute',
    label: 'E2E Execute',
    key: 'e2e-execute',
    predicate: 'echo CONTINUE'
  }
  const gateConfig = buildShardGateConfig(spec)

  it('builds a base (unnumbered) phase draft that auto-launches in the shared worktree', () => {
    const d = buildShardPhaseDraft({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      round: 0,
      command: '/speckit-e2e-execute',
      label: 'E2E Execute',
      key: 'e2e-execute',
      gateConfig
    })
    expect(d.draft_key).toBe('e2e-execute')
    expect(d.title).toBe('E2E Execute')
    expect(d.column).toBe('todo')
    expect(d.worktree_id).toBe('wt-1')
    expect(d.project_id).toBe('proj-1')
    expect(d.lifecycle_callbacks).toBe(gateConfig)

    const launch = JSON.parse(d.pending_launch_config as string)
    expect(launch.prompt).toBe('/speckit-e2e-execute') // bare slash command, no <ticket> wrapper
    expect(launch.sdk).toBe('claude-code-cli')
    expect(launch.worktree).toEqual({ type: 'existing', worktreeId: 'wt-1' })
    expect(launch.injectContext).toBe(false)
  })

  it('numbers continuation runs in both the title and the draft key', () => {
    const d = buildShardPhaseDraft({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      round: 4,
      command: '/speckit-e2e-execute',
      label: 'E2E Execute',
      key: 'e2e-execute',
      gateConfig
    })
    expect(d.title).toBe('E2E Execute (run 4)')
    expect(d.draft_key).toBe('e2e-execute-r4')
    // the continuation still auto-launches the SAME command in the SAME worktree
    expect(JSON.parse(d.pending_launch_config as string).prompt).toBe('/speckit-e2e-execute')
  })
})
