import { describe, expect, it } from 'vitest'
import {
  actionsForSlot,
  branchesForState,
  buildDefaultLoopConfig,
  buildSpeckitGateConfig,
  combineVerdicts,
  decideBranch,
  DEFAULT_FIX_PROMPT_TEMPLATE,
  isLifecycleEnabled,
  isSpeckitGate,
  isSpeckitReviewDraft,
  parseSpeckitRound,
  renderTemplate,
  retryMaxForState,
  verdictToLifecycle
} from '../ticket-lifecycle'
import type { TicketLifecycleConfig } from '@shared/types/ticket-lifecycle'

describe('buildDefaultLoopConfig', () => {
  it('builds the canonical review↔fix loop', () => {
    const cfg = buildDefaultLoopConfig({ maxIterations: 3, fixPromptTemplate: 'do {{reason}}' })
    expect(cfg.enabled).toBe(true)
    // DURING(review) = the Reviewer
    expect(actionsForSlot(cfg, 'review', 'during')).toEqual([
      { id: 'review-during', type: 'review', config: {} }
    ])
    // branches = fail → in_progress; PASS has NO branch
    expect(branchesForState(cfg, 'review')).toEqual([{ when: 'fail', goto: 'in_progress' }])
    expect(branchesForState(cfg, 'review').some((b) => b.when === 'pass')).toBe(false)
    expect(retryMaxForState(cfg, 'review')).toBe(3)
    // RETRY(in_progress) = the fix prompt (NOT before — a plain entry never re-prompts)
    const retry = actionsForSlot(cfg, 'in_progress', 'retry')
    expect(retry).toHaveLength(1)
    expect(retry[0].type).toBe('prompt')
    expect(retry[0].config.template).toBe('do {{reason}}')
    expect(retry[0].runOn).toEqual(['retry'])
    // BEFORE(in_progress) is empty — the loop owns RETRY only
    expect(actionsForSlot(cfg, 'in_progress', 'before')).toEqual([])
  })

  it('survives a JSON round-trip unchanged', () => {
    const cfg = buildDefaultLoopConfig({ maxIterations: 2, fixPromptTemplate: '' })
    const roundTripped = JSON.parse(JSON.stringify(cfg)) as TicketLifecycleConfig
    expect(roundTripped).toEqual(cfg)
    // empty template falls back to the default
    expect(actionsForSlot(roundTripped, 'in_progress', 'retry')[0].config.template).toBe(
      DEFAULT_FIX_PROMPT_TEMPLATE
    )
  })

  it('clamps maxIterations to at least 1 and floors it', () => {
    expect(
      retryMaxForState(
        buildDefaultLoopConfig({ maxIterations: 0, fixPromptTemplate: 'x' }),
        'review'
      )
    ).toBe(1)
    expect(
      retryMaxForState(
        buildDefaultLoopConfig({ maxIterations: 2.9, fixPromptTemplate: 'x' }),
        'review'
      )
    ).toBe(2)
  })
})

describe('isLifecycleEnabled', () => {
  it('is false for null/undefined/disabled, true when enabled', () => {
    expect(isLifecycleEnabled(null)).toBe(false)
    expect(isLifecycleEnabled(undefined)).toBe(false)
    expect(isLifecycleEnabled({ enabled: false, states: {} })).toBe(false)
    expect(isLifecycleEnabled({ enabled: true, states: {} })).toBe(true)
  })
})

describe('actionsForSlot runOn filter', () => {
  const cfg: TicketLifecycleConfig = {
    enabled: true,
    states: {
      in_progress: {
        before: [
          { id: 'a', type: 'prompt', config: {}, runOn: ['initial'] },
          { id: 'b', type: 'prompt', config: {}, runOn: ['retry'] },
          { id: 'c', type: 'notify', config: {} } // no runOn → both
        ]
      }
    }
  }

  it('returns every action when no context is given', () => {
    expect(actionsForSlot(cfg, 'in_progress', 'before').map((a) => a.id)).toEqual(['a', 'b', 'c'])
  })
  it('keeps initial-only + unfiltered actions on an initial entry', () => {
    expect(actionsForSlot(cfg, 'in_progress', 'before', 'initial').map((a) => a.id)).toEqual([
      'a',
      'c'
    ])
  })
  it('keeps retry-only + unfiltered actions on a retry entry', () => {
    expect(actionsForSlot(cfg, 'in_progress', 'before', 'retry').map((a) => a.id)).toEqual([
      'b',
      'c'
    ])
  })
})

describe('verdictToLifecycle', () => {
  it('needsInput wins over everything', () => {
    expect(verdictToLifecycle({ complete: true, needsInput: true, confidence: 0.99 }, 0.6)).toBe(
      'needsInput'
    )
  })
  it('confident complete is a pass', () => {
    expect(verdictToLifecycle({ complete: true, needsInput: false, confidence: 0.8 }, 0.6)).toBe(
      'pass'
    )
  })
  it('low-confidence complete is a fail', () => {
    expect(verdictToLifecycle({ complete: true, needsInput: false, confidence: 0.4 }, 0.6)).toBe(
      'fail'
    )
  })
  it('incomplete is a fail', () => {
    expect(verdictToLifecycle({ complete: false, needsInput: false, confidence: 0.9 }, 0.6)).toBe(
      'fail'
    )
  })
})

describe('combineVerdicts', () => {
  it('is pass for an empty list', () => {
    expect(combineVerdicts([])).toBe('pass')
  })
  it('is pass when all pass', () => {
    expect(combineVerdicts(['pass', 'pass'])).toBe('pass')
  })
  it('returns the first non-pass verdict', () => {
    expect(combineVerdicts(['pass', 'fail', 'needsInput'])).toBe('fail')
    expect(combineVerdicts(['pass', 'needsInput', 'fail'])).toBe('needsInput')
  })
})

describe('decideBranch', () => {
  const cfg = buildDefaultLoopConfig({ maxIterations: 2, fixPromptTemplate: 'fix {{reason}}' })

  it('advances on pass', () => {
    expect(decideBranch(cfg, 'review', 'pass', 5)).toEqual({ kind: 'advance' })
  })

  it('goes to the branch destination under the cap', () => {
    expect(decideBranch(cfg, 'review', 'fail', 1)).toEqual({ kind: 'goto', state: 'in_progress' })
  })

  it('is stuck at/over the cap', () => {
    expect(decideBranch(cfg, 'review', 'fail', 2)).toEqual({ kind: 'stuck' })
    expect(decideBranch(cfg, 'review', 'fail', 3)).toEqual({ kind: 'stuck' })
  })

  it('advances a verdict with no matching branch (defer to default)', () => {
    expect(decideBranch(cfg, 'review', 'needsInput', 1)).toEqual({ kind: 'advance' })
  })

  it('advances on goto:end (loop stops)', () => {
    const ended: TicketLifecycleConfig = {
      enabled: true,
      states: { review: { branches: [{ when: 'fail', goto: 'end' }], retryMax: 5 } }
    }
    expect(decideBranch(ended, 'review', 'fail', 1)).toEqual({ kind: 'advance' })
  })

  it('never caps when retryMax is undefined (no limit)', () => {
    const uncapped: TicketLifecycleConfig = {
      enabled: true,
      states: { review: { branches: [{ when: 'fail', goto: 'in_progress' }] } }
    }
    expect(decideBranch(uncapped, 'review', 'fail', 999)).toEqual({
      kind: 'goto',
      state: 'in_progress'
    })
  })
})

describe('renderTemplate', () => {
  it('substitutes every {{reason}} placeholder', () => {
    expect(renderTemplate('A {{reason}} B {{reason}}', { reason: 'X' })).toBe('A X B X')
  })
  it('substitutes {{title}} and {{iteration}}', () => {
    expect(
      renderTemplate('{{title}} #{{iteration}}: {{reason}}', {
        title: 'Build',
        iteration: 2,
        reason: 'tests fail'
      })
    ).toBe('Build #2: tests fail')
  })
  it('appends the reason when there is no placeholder', () => {
    expect(renderTemplate('Fix the work.', { reason: 'tests fail' })).toBe(
      'Fix the work.\n\ntests fail'
    )
  })
  it('leaves a placeholder-less template untouched when there is no reason', () => {
    expect(renderTemplate('Fix the work.', {})).toBe('Fix the work.')
  })
  it('substitutes an empty string when reason is missing but a placeholder exists', () => {
    expect(renderTemplate('before {{reason}} after', {})).toBe('before  after')
  })
})

describe('buildSpeckitGateConfig', () => {
  it('builds an enabled config whose only review action is a spawn', () => {
    const cfg = buildSpeckitGateConfig()
    expect(cfg.enabled).toBe(true)
    const during = actionsForSlot(cfg, 'review', 'during')
    expect(during).toHaveLength(1)
    expect(during[0].type).toBe('spawn')
  })

  it('has NO review fail→in_progress branch (the #110 internal bounce is disabled)', () => {
    expect(branchesForState(buildSpeckitGateConfig(), 'review')).toEqual([])
  })

  it('survives a JSON round-trip unchanged', () => {
    const cfg = buildSpeckitGateConfig()
    expect(JSON.parse(JSON.stringify(cfg))).toEqual(cfg)
  })
})

describe('isSpeckitGate', () => {
  it('is true for a built gate config', () => {
    expect(isSpeckitGate(buildSpeckitGateConfig())).toBe(true)
  })
  it('is false for null/undefined/disabled', () => {
    expect(isSpeckitGate(null)).toBe(false)
    expect(isSpeckitGate(undefined)).toBe(false)
    expect(
      isSpeckitGate({
        enabled: false,
        states: { review: { during: [{ id: 's', type: 'spawn', config: {} }] } }
      })
    ).toBe(false)
  })
  it('is false for the review↔fix loop (review action is type review, not spawn)', () => {
    expect(
      isSpeckitGate(buildDefaultLoopConfig({ maxIterations: 3, fixPromptTemplate: 'x' }))
    ).toBe(false)
  })
})

describe('isSpeckitReviewDraft', () => {
  it('matches the base review key and round keys', () => {
    expect(isSpeckitReviewDraft({ draftKey: 'review' })).toBe(true)
    expect(isSpeckitReviewDraft({ draftKey: 'review-r1' })).toBe(true)
    expect(isSpeckitReviewDraft({ draftKey: 'REVIEW-R12' })).toBe(true)
  })
  it('does NOT match review-plan (anchored regex rejects it)', () => {
    expect(isSpeckitReviewDraft({ draftKey: 'review-plan' })).toBe(false)
    expect(isSpeckitReviewDraft({ draftKey: 'review-plan-r1' })).toBe(false)
    expect(isSpeckitReviewDraft({ draftKey: 'fix-r1' })).toBe(false)
  })
  it('falls back to a /speckit-review reference in the description when the key is generic', () => {
    expect(
      isSpeckitReviewDraft({ draftKey: 'draft-3', description: 'Run /speckit-review on the work' })
    ).toBe(true)
    // /speckit-review-plan must NOT match the review-gate fallback
    expect(
      isSpeckitReviewDraft({ draftKey: 'draft-2', description: 'Run /speckit-review-plan first' })
    ).toBe(false)
  })
})

describe('parseSpeckitRound', () => {
  it('is 0 for the base review (no round marker) and empty titles', () => {
    expect(parseSpeckitRound('Speckit review — 2611')).toBe(0)
    expect(parseSpeckitRound('')).toBe(0)
    expect(parseSpeckitRound(null)).toBe(0)
    expect(parseSpeckitRound(undefined)).toBe(0)
  })
  it('parses (round R) and the (gate, round R) variant', () => {
    expect(parseSpeckitRound('Speckit review (round 3) — 2611')).toBe(3)
    expect(parseSpeckitRound('Speckit review (gate, round 12) — 2611')).toBe(12)
    expect(parseSpeckitRound('x (ROUND 2)')).toBe(2)
  })
})
