// @vitest-environment node
//
// Pure-logic tests for the shipped `hive-ticket` CLI (resources/cli/hive-ticket.mjs).
// Only the deterministic, side-effect-free helpers are exercised — discovery, auth,
// and RPC need a live Hive and are covered end-to-end by running the app.
import { describe, expect, it, vi } from 'vitest'
import {
  COLUMNS,
  buildGateConfig,
  describeInstance,
  isContextMatch,
  mapBatchDraft,
  parseArgs,
  parseColumn,
  selectInstance,
  splitList
  // @ts-expect-error — plain .mjs sibling, no type declarations
} from '../../resources/cli/hive-ticket.mjs'

describe('parseArgs', () => {
  it('splits flags with values, boolean flags, and positionals', () => {
    const { flags, positional } = parseArgs([
      'create',
      'Title',
      '--column',
      'review',
      '--gate',
      '--project',
      'my-app'
    ])
    expect(positional).toEqual(['create', 'Title'])
    expect(flags).toEqual({ column: 'review', gate: true, project: 'my-app' })
  })

  it('treats a flag immediately followed by another flag as boolean', () => {
    const { flags } = parseArgs(['--gate', '--gate-auto-done'])
    expect(flags).toEqual({ gate: true, 'gate-auto-done': true })
  })
})

describe('parseColumn', () => {
  it('defaults to todo and accepts every valid column', () => {
    expect(parseColumn(undefined, 'ctx')).toBe('todo')
    for (const c of COLUMNS) expect(parseColumn(c, 'ctx')).toBe(c)
  })

  it('calls onFail for an unknown column', () => {
    const onFail = vi.fn()
    parseColumn('nope', 'create', onFail)
    expect(onFail).toHaveBeenCalledOnce()
    expect(onFail.mock.calls[0][0]).toContain('bad column "nope"')
  })
})

describe('splitList', () => {
  it('parses a comma list, trims, and drops empties', () => {
    expect(splitList('a, b ,,c')).toEqual(['a', 'b', 'c'])
  })
  it('returns [] for empty / boolean-true input', () => {
    expect(splitList(undefined)).toEqual([])
    expect(splitList(true)).toEqual([])
  })
})

describe('buildGateConfig', () => {
  it('marks review as a two-stage gate and drops empty/placeholder keys', () => {
    const cfg = buildGateConfig({
      'gate-max': '3',
      'gate-provider': 'anthropic',
      'gate-model': '',
      'gate-auto-done': true
    })
    expect(cfg.enabled).toBe(true)
    const action = cfg.states.review.during[0]
    expect(action).toMatchObject({ id: 'condition-gate-evaluate', type: 'evaluate' })
    // '' model dropped; boolean-true auto-done dropped from config; maxRounds coerced.
    expect(action.config).toEqual({ maxRounds: 3, provider: 'anthropic' })
  })

  it('produces an empty config object when no gate flags are given', () => {
    const cfg = buildGateConfig({})
    expect(cfg.states.review.during[0].config).toEqual({})
  })
})

describe('mapBatchDraft', () => {
  it('maps camelCase + snake_case aliases into the createBatch draft shape', () => {
    const draft = mapBatchDraft(
      { title: 'T', description: 'D', column: 'in_progress', draftKey: 'k', dependsOn: ['x'] },
      2,
      'proj-1',
      undefined
    )
    expect(draft).toMatchObject({
      draft_key: 'k',
      project_id: 'proj-1',
      title: 'T',
      description: 'D',
      column: 'in_progress',
      depends_on: ['x']
    })
  })

  it('defaults draft_key by index and description to null', () => {
    const draft = mapBatchDraft({ title: 'T' }, 5, 'proj-1', undefined)
    expect(draft.draft_key).toBe('draft-5')
    expect(draft.description).toBeNull()
  })

  it('uses the fallback worktree id when the item omits one', () => {
    const draft = mapBatchDraft({ title: 'T' }, 0, 'proj-1', 'wt-fallback')
    expect(draft.worktree_id).toBe('wt-fallback')
  })

  it('serializes an object launchConfig into pending_launch_config JSON', () => {
    const draft = mapBatchDraft({ title: 'T', launchConfig: { mode: 'build' } }, 0, 'proj-1')
    expect(draft.pending_launch_config).toBe('{"mode":"build"}')
  })

  it('expands gate:true into a condition-gate lifecycle config', () => {
    const draft = mapBatchDraft({ title: 'T', gate: true }, 0, 'proj-1')
    expect(draft.lifecycle_callbacks.enabled).toBe(true)
  })

  it('calls onFail for an item missing a title', () => {
    const onFail = vi.fn()
    mapBatchDraft({}, 3, 'proj-1', undefined, onFail)
    expect(onFail).toHaveBeenCalledOnce()
    expect(onFail.mock.calls[0][0]).toContain('Batch item 3 is missing "title"')
  })
})

describe('instance selection', () => {
  const prod = { port: 3773, instanceKind: 'production', label: 'production' }
  const dev = { port: 3800, instanceKind: 'development', label: 'my-worktree', repoRoot: '/repo/wt' }
  const other = { port: 3801, instanceKind: 'development', label: 'other', repoRoot: '/repo/other' }

  it('honors an explicit --port', () => {
    const onFail = vi.fn()
    expect(selectInstance([prod, dev], { wantPort: 3800 }, onFail)).toBe(dev)
    expect(onFail).not.toHaveBeenCalled()
  })

  it('picks the sole instance when only one is running', () => {
    expect(selectInstance([dev], {}, vi.fn())).toBe(dev)
  })

  it('refuses to implicitly target production (safety guard)', () => {
    const onFail = vi.fn()
    selectInstance([prod], {}, onFail)
    expect(onFail).toHaveBeenCalled()
    expect(onFail.mock.calls[0][0]).toContain('PRODUCTION')
  })

  it('fails on ambiguity rather than guessing', () => {
    const onFail = vi.fn()
    selectInstance([dev, other], {}, onFail)
    expect(onFail).toHaveBeenCalled()
    expect(onFail.mock.calls[0][0]).toContain('Multiple Hive instances')
  })

  it('context auto-matches the instance for the repo the shell is in', () => {
    const ctx = { cwd: '/repo/wt/src', dataDir: '/nope', gitToplevel: '/repo/wt' }
    expect(selectInstance([dev, other], ctx, vi.fn())).toBe(dev)
  })
})

describe('isContextMatch', () => {
  it('matches on dataDir, gitToplevel, or cwd-under-repoRoot', () => {
    expect(isContextMatch({ dataDir: '/d' }, { dataDir: '/d', cwd: '/x' })).toBe(true)
    expect(
      isContextMatch({ repoRoot: '/repo' }, { cwd: '/repo/sub', gitToplevel: null })
    ).toBe(true)
    expect(isContextMatch({ repoRoot: '/repo' }, { cwd: '/elsewhere', gitToplevel: null })).toBe(
      false
    )
  })
})

describe('describeInstance', () => {
  it('renders label, kind, and port', () => {
    expect(describeInstance({ label: 'x', instanceKind: 'development', port: 3800 })).toContain(
      'x  [development · :3800]'
    )
  })
})
