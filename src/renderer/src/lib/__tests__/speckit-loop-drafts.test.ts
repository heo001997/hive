import { describe, expect, it } from 'vitest'
import {
  buildSpeckitGateDescription,
  buildSpeckitLoopDrafts,
  parseSpeckitCardId
} from '../speckit-loop-drafts'

describe('parseSpeckitCardId', () => {
  it('reads the trailing — {id} from a base review title', () => {
    expect(parseSpeckitCardId('Speckit review (gate) — 2611')).toBe('2611')
  })

  it('reads a compound id from a loop-round title', () => {
    expect(parseSpeckitCardId('Speckit review (gate, round 3) — 2836-2')).toBe('2836-2')
  })

  it('returns null when there is no — {id} suffix', () => {
    expect(parseSpeckitCardId('Speckit review')).toBeNull()
    expect(parseSpeckitCardId('')).toBeNull()
    expect(parseSpeckitCardId(null)).toBeNull()
    expect(parseSpeckitCardId(undefined)).toBeNull()
  })
})

describe('buildSpeckitLoopDrafts', () => {
  it('builds the fix → review-plan → review triple wired in dependency order', () => {
    const drafts = buildSpeckitLoopDrafts('2611', 'proj-1', 1)
    expect(drafts.map((d) => d.draftKey)).toEqual(['fix-r1', 'review-plan-r1', 'review-r1'])

    const [fix, reviewPlan, review] = drafts
    expect(fix.dependsOn).toEqual([])
    expect(reviewPlan.dependsOn).toEqual(['fix-r1'])
    expect(review.dependsOn).toEqual(['review-plan-r1'])

    // Every draft belongs to the same project and carries the card id in its title.
    for (const d of drafts) {
      expect(d.projectId).toBe('proj-1')
      expect(d.title).toContain('— 2611')
    }
    // The review step's title matches what parseSpeckitRound keys off (round 1).
    expect(review.title).toBe('Speckit review (gate, round 1) — 2611')
    // The review step carries the JSON-contract gate description.
    expect(review.description).toBe(buildSpeckitGateDescription())
  })

  it('numbers the keys/titles by round so later rounds parse a higher round', () => {
    const drafts = buildSpeckitLoopDrafts('2836-2', 'proj-9', 4)
    expect(drafts.map((d) => d.draftKey)).toEqual(['fix-r4', 'review-plan-r4', 'review-r4'])
    expect(drafts[2].title).toBe('Speckit review (gate, round 4) — 2836-2')
  })

  it('folds the review findings into the fix ticket body so the fix agent has them', () => {
    const drafts = buildSpeckitLoopDrafts('2611', 'proj-1', 1, [
      'null-check the request handler',
      'add a regression test for the empty-list case'
    ])
    const fix = drafts[0]
    expect(fix.description).toContain('Findings to fix (from the review):')
    expect(fix.description).toContain('null-check the request handler')
    expect(fix.description).toContain('add a regression test for the empty-list case')
  })

  it('omits the findings block when no fixes are supplied', () => {
    const fix = buildSpeckitLoopDrafts('2611', 'proj-1', 1, [])[0]
    expect(fix.description).not.toContain('Findings to fix')
  })
})

describe('buildSpeckitGateDescription', () => {
  it('points the agent at the JSON contract and forbids the old paste/spawn protocol', () => {
    const desc = buildSpeckitGateDescription()
    expect(desc).toContain('/speckit-review')
    expect(desc).toContain('.hive/review-gate.json')
    expect(desc).toContain('do NOT create tickets')
    // The three routed outcomes are documented for the agent.
    expect(desc).toContain('"pass"')
    expect(desc).toContain('"fix"')
    expect(desc).toContain('"needs-human"')
  })
})
