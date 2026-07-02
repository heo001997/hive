import { describe, expect, it } from 'vitest'

import {
  buildConditionGateConfig,
  isConditionGate,
  seedConditionGateOnTarget,
  type ConditionGateSeedInput,
  type ConditionGateSeedTarget
} from '../condition-gate'

/**
 * Part A — server-side auto-arm. `seedConditionGateOnTarget` is the pure core the
 * create RPC (`kanban.ts`) runs on every incoming ticket/draft. It seeds a gate config
 * ONLY when the gate is enabled AND `lifecycle_callbacks` is null/absent AND the draft
 * matches the review pattern — and never clobbers a caller-provided config.
 */
const ENABLED: ConditionGateSeedInput = {
  enabled: true,
  maxRounds: 4,
  provider: 'claude-code',
  model: '',
  prompt: 'route it',
  autoDone: true,
  matchMode: 'both'
}

describe('seedConditionGateOnTarget', () => {
  it('seeds a gate on a matching review draft when enabled', () => {
    const target: ConditionGateSeedTarget = { description: null }
    expect(seedConditionGateOnTarget(target, 'review', ENABLED)).toBe(true)
    expect(isConditionGate(target.lifecycle_callbacks ?? null)).toBe(true)
    expect(target.lifecycle_state).toBe('todo')
  })

  it('carries the settings into the seeded config (empty model → provider default)', () => {
    const target: ConditionGateSeedTarget = { description: null }
    seedConditionGateOnTarget(target, 'review-r2', ENABLED)
    expect(target.lifecycle_callbacks).toEqual(
      buildConditionGateConfig({
        maxRounds: 4,
        provider: 'claude-code',
        prompt: 'route it',
        autoDone: true
      })
    )
  })

  it('matches a Speckit review draft by description word', () => {
    const target: ConditionGateSeedTarget = {
      description: 'Run /speckit-review on the diff and report'
    }
    expect(seedConditionGateOnTarget(target, 'draft-3', ENABLED)).toBe(true)
  })

  it('does NOT seed when the gate is disabled', () => {
    const target: ConditionGateSeedTarget = { description: null }
    expect(seedConditionGateOnTarget(target, 'review', { ...ENABLED, enabled: false })).toBe(false)
    expect(target.lifecycle_callbacks).toBeUndefined()
    expect(target.lifecycle_state).toBeUndefined()
  })

  it('does NOT seed a non-review draft', () => {
    const target: ConditionGateSeedTarget = { description: 'just build the feature' }
    expect(seedConditionGateOnTarget(target, 'review-plan', ENABLED)).toBe(false)
    expect(seedConditionGateOnTarget({ description: null }, 'fix-r1', ENABLED)).toBe(false)
  })

  it('never clobbers a caller-provided lifecycle_callbacks', () => {
    const existing = buildConditionGateConfig({ maxRounds: 99 })
    const target: ConditionGateSeedTarget = { description: null, lifecycle_callbacks: existing }
    expect(seedConditionGateOnTarget(target, 'review', ENABLED)).toBe(false)
    expect(target.lifecycle_callbacks).toBe(existing)
  })

  it('respects a key-only match mode', () => {
    const target: ConditionGateSeedTarget = {
      description: 'mentions /speckit-review but keyed oddly'
    }
    expect(
      seedConditionGateOnTarget(target, 'qa', { ...ENABLED, matchMode: 'key' })
    ).toBe(false)
  })
})
