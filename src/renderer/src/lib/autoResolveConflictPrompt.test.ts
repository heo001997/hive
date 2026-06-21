import { describe, it, expect } from 'vitest'
import {
  DEFAULT_AUTO_RESOLVE_CONFLICT_PROMPT,
  buildAutoResolveConflictPrompt
} from './autoResolveConflictPrompt'

const ctx = { prNumber: 42, baseBranch: 'main', featureBranch: 'my-feature' }

describe('buildAutoResolveConflictPrompt', () => {
  it('substitutes every placeholder occurrence', () => {
    const out = buildAutoResolveConflictPrompt(DEFAULT_AUTO_RESOLVE_CONFLICT_PROMPT, ctx)
    expect(out).not.toContain('{prNumber}')
    expect(out).not.toContain('{baseBranch}')
    expect(out).not.toContain('{featureBranch}')
    expect(out).toContain('PR #42')
    expect(out).toContain('git fetch origin main')
    expect(out).toContain('my-feature')
  })

  it('replaces repeated placeholders, not just the first', () => {
    const out = buildAutoResolveConflictPrompt('{baseBranch} then {baseBranch}', ctx)
    expect(out).toBe('main then main')
  })

  it('falls back to the default template when the value is blank', () => {
    for (const blank of ['', '   ', null, undefined]) {
      const out = buildAutoResolveConflictPrompt(blank, ctx)
      expect(out).toContain('PR #42')
      expect(out).toContain('ask Tu')
    }
  })

  it('honours a custom template', () => {
    const out = buildAutoResolveConflictPrompt('Fix PR {prNumber} on {featureBranch}', ctx)
    expect(out).toBe('Fix PR 42 on my-feature')
  })
})
