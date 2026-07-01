import { describe, expect, it } from 'vitest'
import {
  actionsForSlot,
  branchesForState,
  buildConditionGateConfig,
  buildDefaultLoopConfig,
  buildFixRoundBatch,
  buildFixRoundPrompt,
  combineVerdicts,
  conditionGateConfigOf,
  decideBranch,
  decideConditionGate,
  DEFAULT_FIX_PROMPT_TEMPLATE,
  isConditionGate,
  isGateTicket,
  isLifecycleEnabled,
  isReviewGateDraft,
  parseGateRound,
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

describe('isReviewGateDraft', () => {
  it('matches the base review key and round keys', () => {
    expect(isReviewGateDraft({ draftKey: 'review' })).toBe(true)
    expect(isReviewGateDraft({ draftKey: 'review-r1' })).toBe(true)
    expect(isReviewGateDraft({ draftKey: 'REVIEW-R12' })).toBe(true)
  })
  it('does NOT match review-plan (anchored regex rejects it)', () => {
    expect(isReviewGateDraft({ draftKey: 'review-plan' })).toBe(false)
    expect(isReviewGateDraft({ draftKey: 'review-plan-r1' })).toBe(false)
    expect(isReviewGateDraft({ draftKey: 'fix-r1' })).toBe(false)
  })
  it('falls back to a /speckit-review reference in the description when the key is generic', () => {
    expect(
      isReviewGateDraft({ draftKey: 'draft-3', description: 'Run /speckit-review on the work' })
    ).toBe(true)
    // /speckit-review-plan must NOT match the review-gate fallback
    expect(
      isReviewGateDraft({ draftKey: 'draft-2', description: 'Run /speckit-review-plan first' })
    ).toBe(false)
  })

  it('mode "key" ignores the description; mode "word" ignores the draftKey', () => {
    // key-only: a matching description does not seed the gate
    expect(
      isReviewGateDraft(
        { draftKey: 'draft-3', description: 'Run /speckit-review' },
        { mode: 'key' }
      )
    ).toBe(false)
    expect(isReviewGateDraft({ draftKey: 'review' }, { mode: 'key' })).toBe(true)
    // word-only: a matching key does not seed the gate
    expect(isReviewGateDraft({ draftKey: 'review' }, { mode: 'word' })).toBe(false)
    expect(
      isReviewGateDraft(
        { draftKey: 'anything', description: 'Run /speckit-review' },
        { mode: 'word' }
      )
    ).toBe(true)
  })

  it('honors a custom key pattern', () => {
    const cfg = { mode: 'key' as const, keyPattern: '^qa(-r\\d+)?$' }
    expect(isReviewGateDraft({ draftKey: 'qa' }, cfg)).toBe(true)
    expect(isReviewGateDraft({ draftKey: 'qa-r2' }, cfg)).toBe(true)
    expect(isReviewGateDraft({ draftKey: 'review' }, cfg)).toBe(false)
  })

  it('honors a custom word pattern', () => {
    const cfg = { mode: 'word' as const, wordPattern: '/my-review-cmd' }
    expect(
      isReviewGateDraft({ draftKey: 'x', description: 'run /my-review-cmd now' }, cfg)
    ).toBe(true)
    expect(
      isReviewGateDraft({ draftKey: 'x', description: 'run /speckit-review' }, cfg)
    ).toBe(false)
  })

  it('falls back to the default pattern when a custom regex is invalid', () => {
    // '(' is an invalid regex — must not throw, and must keep matching via the default.
    expect(isReviewGateDraft({ draftKey: 'review' }, { mode: 'key', keyPattern: '(' })).toBe(true)
    expect(isReviewGateDraft({ draftKey: 'nope' }, { mode: 'key', keyPattern: '(' })).toBe(false)
  })

  it('empty pattern strings fall back to the defaults', () => {
    expect(
      isReviewGateDraft({ draftKey: 'review' }, { mode: 'both', keyPattern: '', wordPattern: '' })
    ).toBe(true)
  })
})

describe('parseGateRound', () => {
  it('is 0 for the base review (no round marker) and empty titles', () => {
    expect(parseGateRound('Review — 2611')).toBe(0)
    expect(parseGateRound('')).toBe(0)
    expect(parseGateRound(null)).toBe(0)
    expect(parseGateRound(undefined)).toBe(0)
  })
  it('parses (round R) and the (gate, round R) variant', () => {
    expect(parseGateRound('Review (round 3) — 2611')).toBe(3)
    expect(parseGateRound('Review (gate, round 12) — 2611')).toBe(12)
    expect(parseGateRound('x (ROUND 2)')).toBe(2)
  })
})

describe('buildConditionGateConfig', () => {
  it('builds an enabled config whose only review action is an evaluate', () => {
    const cfg = buildConditionGateConfig()
    expect(cfg.enabled).toBe(true)
    const during = actionsForSlot(cfg, 'review', 'during')
    expect(during).toHaveLength(1)
    expect(during[0].type).toBe('evaluate')
  })

  it('has NO review fail→in_progress branch (the internal bounce is disabled for gates)', () => {
    expect(branchesForState(buildConditionGateConfig(), 'review')).toEqual([])
  })

  it('drops undefined/empty config keys but keeps set ones', () => {
    const cfg = buildConditionGateConfig({
      provider: 'claude-code',
      model: '',
      maxRounds: 5,
      autoDone: true
    })
    const stored = actionsForSlot(cfg, 'review', 'during')[0].config
    expect(stored).toEqual({ provider: 'claude-code', maxRounds: 5, autoDone: true })
    expect('model' in stored).toBe(false)
  })

  it('survives a JSON round-trip unchanged', () => {
    const cfg = buildConditionGateConfig({ maxRounds: 3 })
    expect(JSON.parse(JSON.stringify(cfg))).toEqual(cfg)
  })
})

describe('isConditionGate', () => {
  it('is true for a built condition-gate config', () => {
    expect(isConditionGate(buildConditionGateConfig())).toBe(true)
  })
  it('is false for null/undefined/disabled', () => {
    expect(isConditionGate(null)).toBe(false)
    expect(isConditionGate(undefined)).toBe(false)
    expect(
      isConditionGate({
        enabled: false,
        states: { review: { during: [{ id: 'e', type: 'evaluate', config: {} }] } }
      })
    ).toBe(false)
  })
  it('is false for the plain review↔fix loop', () => {
    expect(
      isConditionGate(buildDefaultLoopConfig({ maxIterations: 3, fixPromptTemplate: 'x' }))
    ).toBe(false)
  })
})

describe('conditionGateConfigOf', () => {
  it('reads back typed fields from the stored evaluate action', () => {
    const cfg = buildConditionGateConfig({
      provider: 'codex',
      model: 'gpt-x',
      prompt: 'route it',
      maxRounds: 7,
      autoDone: true
    })
    expect(conditionGateConfigOf(cfg)).toEqual({
      provider: 'codex',
      model: 'gpt-x',
      prompt: 'route it',
      maxRounds: 7,
      autoDone: true
    })
  })
  it('returns undefined fields (autoDone false) for an empty gate', () => {
    expect(conditionGateConfigOf(buildConditionGateConfig())).toEqual({
      provider: undefined,
      model: undefined,
      prompt: undefined,
      maxRounds: undefined,
      autoDone: false
    })
  })
  it('ignores a non-numeric maxRounds', () => {
    const cfg = {
      enabled: true,
      states: {
        review: { during: [{ id: 'e', type: 'evaluate' as const, config: { maxRounds: 'nope' } }] }
      }
    }
    expect(conditionGateConfigOf(cfg).maxRounds).toBeUndefined()
  })
})

describe('isGateTicket', () => {
  it('is true for a condition gate, false otherwise', () => {
    expect(isGateTicket(buildConditionGateConfig())).toBe(true)
    expect(isGateTicket(buildDefaultLoopConfig({ maxIterations: 1, fixPromptTemplate: 'x' }))).toBe(
      false
    )
    expect(isGateTicket(null)).toBe(false)
  })
})

describe('decideConditionGate', () => {
  it('passes on a pass verdict', () => {
    expect(decideConditionGate({ verdict: 'pass' }, 0, 3)).toEqual({ kind: 'pass' })
  })
  it('opens the next round on fix under the cap', () => {
    expect(decideConditionGate({ verdict: 'fix' }, 0, 3)).toEqual({ kind: 'fix', round: 1 })
    expect(decideConditionGate({ verdict: 'fix' }, 2, 3)).toEqual({ kind: 'fix', round: 3 })
  })
  it('blocks on fix at/over the cap (loop ran too deep)', () => {
    expect(decideConditionGate({ verdict: 'fix' }, 3, 3).kind).toBe('block')
    expect(decideConditionGate({ verdict: 'fix' }, 5, 3).kind).toBe('block')
  })
  it('blocks on needs-human, carrying the reason', () => {
    expect(decideConditionGate({ verdict: 'needs-human', reason: 'ambiguous' }, 0, 3)).toEqual({
      kind: 'block',
      reason: 'ambiguous'
    })
  })
  it('blocks (never fails open) on an unknown verdict', () => {
    expect(decideConditionGate({ verdict: 'garbage' }, 0, 3).kind).toBe('block')
  })
})

describe('buildFixRoundBatch', () => {
  const params = {
    round: 2,
    worktreeId: 'wt-abc',
    reviewTitle: 'Review (gate, round 1) — Add login — 4210',
    verdict: { reason: 'tests fail', fixes: ['fix the token check', 'add a test'] }
  }

  it('emits exactly three linked tickets: fix → review-plan → review', () => {
    const batch = buildFixRoundBatch(params)
    expect(batch.map((t) => t.draftKey)).toEqual(['fix-r2', 'review-plan-r2', 'review-r2'])
    expect(batch[1].dependsOn).toEqual(['fix-r2'])
    expect(batch[2].dependsOn).toEqual(['review-plan-r2'])
    // Only the head has no blocker (so only it is launch-ready immediately).
    expect(batch[0].dependsOn).toBeUndefined()
  })

  it('derives a clean base label (strips the round suffix, id tail, review words)', () => {
    const batch = buildFixRoundBatch(params)
    expect(batch[0].title).toBe('Fix (round 2) — Add login')
    expect(batch[1].title).toBe('Review plan (round 2) — Add login')
    expect(batch[2].title).toBe('Review (gate, round 2) — Add login')
  })

  it('seeds ONLY the new review as a condition gate so the loop re-enters', () => {
    const batch = buildFixRoundBatch(params)
    expect(batch[0].gate).toBeUndefined()
    expect(batch[1].gate).toBeUndefined()
    expect(batch[2].gate).toBe(true)
  })

  it('threads the shared worktree with NO reuseBranchBase (one branch = one PR)', () => {
    for (const t of buildFixRoundBatch(params)) {
      expect(t.worktreeId).toBe('wt-abc')
      const launch = t.launchConfig as Record<string, unknown>
      expect(launch.worktree).toEqual({ type: 'existing', worktreeId: 'wt-abc' })
      expect(launch.sdk).toBe('claude-code-cli')
      expect(launch.reuseBranchBase).toBeUndefined()
      expect('reuseBranchBase' in launch).toBe(false)
    }
  })

  it('folds the verdict reason + fixes into the fix ticket body', () => {
    const fix = buildFixRoundBatch(params)[0]
    expect(fix.description).toContain('tests fail')
    expect(fix.description).toContain('fix the token check')
    expect(fix.description).toContain('add a test')
  })

  it('every ticket is a build ticket that auto-approves review and starts in todo', () => {
    for (const t of buildFixRoundBatch(params)) {
      expect(t.mode).toBe('build')
      expect(t.autoApproveReview).toBe(true)
      expect(t.column).toBe('todo')
    }
  })

  it('falls back to a "work" label when the title has nothing but review words', () => {
    const batch = buildFixRoundBatch({ ...params, reviewTitle: 'review-plan' })
    expect(batch[0].title).toBe('Fix (round 2) — work')
  })
})

describe('buildFixRoundPrompt', () => {
  const params = {
    round: 1,
    worktreeId: 'wt-1',
    reviewTitle: 'Review — Build API',
    verdict: { reason: 'missing error handling', fixes: ['wrap the handler'] }
  }

  it('embeds the exact batch JSON and the CLI batch command', () => {
    const prompt = buildFixRoundPrompt(params)
    expect(prompt).toContain('round-1.json')
    expect(prompt).toContain('node "$HIVE_TICKET_CLI" batch round-1.json')
    // The embedded JSON must be the same batch the store built (agent = dumb executor).
    expect(prompt).toContain(JSON.stringify(buildFixRoundBatch(params), null, 2))
  })

  it('instructs the agent to STOP after creating tickets (do not implement fixes)', () => {
    const prompt = buildFixRoundPrompt(params)
    expect(prompt).toMatch(/do NOT (fix|edit|implement)/i)
    expect(prompt).toContain('Created:')
  })
})
