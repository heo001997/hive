import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// The module probes git at import time to auto-isolate a linked worktree. Mock
// spawnSync so the result is deterministic regardless of where the test runs
// (the test suite itself may execute inside a linked worktree). Shapes:
//   main checkout  -> git-dir === common-dir -> not isolated -> shared ~/.hive-dev
//   linked worktree-> git-dir !== common-dir -> auto-isolate to <root>/.hive-data
const { gitProbe } = vi.hoisted(() => ({ gitProbe: vi.fn() }))
vi.mock('node:child_process', () => ({ default: { spawnSync: gitProbe }, spawnSync: gitProbe }))

const mainCheckoutProbe = () => ({ status: 0, stdout: '/repo\n.git\n.git\n' })
const linkedWorktreeProbe = (root: string) => ({
  status: 0,
  stdout: `${root}\n/main/.git/worktrees/wt\n/main/.git\n`
})

describe('dev data setup', () => {
  beforeEach(() => {
    // Default every test to a plain main checkout (not isolated).
    gitProbe.mockReset()
    gitProbe.mockReturnValue(mainCheckoutProbe())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  test('exposes the fixed dev data + worktrees dirs', async () => {
    const { DEV_DATA_DIR, DEV_WORKTREES_DIR } = await import('../scripts/dev-data-setup.mjs')

    expect(DEV_DATA_DIR).toBe(resolve(homedir(), '.hive-dev'))
    expect(DEV_WORKTREES_DIR).toBe(resolve(homedir(), '.hive-dev-worktrees'))
  })

  test('auto-isolates a linked git worktree to <root>/.hive-data (no env needed)', async () => {
    gitProbe.mockReturnValue(linkedWorktreeProbe('/wt/auto'))
    vi.resetModules() // re-evaluate so the probe result is read at load
    const mod = await import('../scripts/dev-data-setup.mjs')

    expect(mod.DEV_DATA_DIR).toBe(join('/wt/auto', '.hive-data'))
    expect(mod.DEV_WORKTREES_DIR).toBe(resolve('/wt/auto/.hive-data-worktrees'))
    expect(mod.IS_ISOLATED_WORKTREE).toBe(true)
    // Still seeds from the shared dev sandbox, never production.
    expect(mod.SHARED_DEV_DATA_DIR).toBe(resolve(homedir(), '.hive-dev'))
  })

  test('explicit HIVE_DEV_DATA_DIR wins over worktree auto-detection', async () => {
    gitProbe.mockReturnValue(linkedWorktreeProbe('/wt/auto'))
    vi.stubEnv('HIVE_DEV_DATA_DIR', '/explicit/.hive-data')
    vi.resetModules()
    const { DEV_DATA_DIR } = await import('../scripts/dev-data-setup.mjs')

    expect(DEV_DATA_DIR).toBe('/explicit/.hive-data')
    // The override short-circuits detection — git is never probed.
    expect(gitProbe).not.toHaveBeenCalled()
  })

  test('HIVE_DEV_DATA_DIR relocates both dev dirs as siblings (per-worktree isolation)', async () => {
    vi.stubEnv('HIVE_DEV_DATA_DIR', '/wt/standalone/.hive-data')
    vi.resetModules() // re-evaluate the module so the env override is read at load
    const { DEV_DATA_DIR, DEV_WORKTREES_DIR } = await import('../scripts/dev-data-setup.mjs')

    expect(DEV_DATA_DIR).toBe('/wt/standalone/.hive-data')
    expect(DEV_WORKTREES_DIR).toBe('/wt/standalone/.hive-data-worktrees')
  })

  test('an isolated worktree seeds from the shared dev sandbox, never production', async () => {
    vi.stubEnv('HIVE_DEV_DATA_DIR', '/wt/standalone/.hive-data')
    vi.resetModules()
    const mod = await import('../scripts/dev-data-setup.mjs')

    // The clone SOURCE for an isolated worktree is the fixed shared-dev sandbox,
    // not the relocated target and not production (~/.hive).
    expect(mod.IS_ISOLATED_WORKTREE).toBe(true)
    expect(mod.SHARED_DEV_DATA_DIR).toBe(resolve(homedir(), '.hive-dev'))
    expect(mod.SHARED_DEV_DATA_DIR).not.toBe(mod.LEGACY_DATA_DIR)
  })

  test('the shared dev sandbox itself is not flagged isolated (clones from prod)', async () => {
    vi.resetModules()
    const mod = await import('../scripts/dev-data-setup.mjs')

    expect(mod.IS_ISOLATED_WORKTREE).toBe(false)
    expect(mod.LEGACY_DATA_DIR).toBe(resolve(homedir(), '.hive'))
  })

  test('a relative HIVE_DEV_DATA_DIR is resolved to an absolute path and trimmed', async () => {
    vi.stubEnv('HIVE_DEV_DATA_DIR', '  rel/.hive-data  ')
    vi.resetModules()
    const { DEV_DATA_DIR, DEV_WORKTREES_DIR } = await import('../scripts/dev-data-setup.mjs')

    expect(DEV_DATA_DIR).toBe(resolve('rel/.hive-data'))
    expect(DEV_WORKTREES_DIR).toBe(resolve('rel/.hive-data-worktrees'))
  })

  test('parses the clone-vs-fresh answer (empty defaults to sync)', async () => {
    const { parseSyncAnswer } = await import('../scripts/dev-data-setup.mjs')

    for (const fresh of ['f', 'F', 'fresh', 'FRESH', 'n', 'no', 'scratch', '  fresh  ']) {
      expect(parseSyncAnswer(fresh)).toBe('fresh')
    }
    for (const sync of ['', '  ', 's', 'S', 'sync', 'y', 'YES', 'huh?']) {
      expect(parseSyncAnswer(sync)).toBe('sync')
    }
    expect(parseSyncAnswer(undefined)).toBe('sync')
  })

  test('parses HIVE_DEV_DATA_SYNC into clone | fresh | null (unset/unknown -> null)', async () => {
    const { parseSyncMode } = await import('../scripts/dev-data-setup.mjs')

    for (const clone of ['clone', 'CLONE', 'sync', 's', 'y', 'yes', '  clone  ']) {
      expect(parseSyncMode(clone)).toBe('clone')
    }
    for (const fresh of ['fresh', 'F', 'n', 'no', 'scratch', '  fresh  ']) {
      expect(parseSyncMode(fresh)).toBe('fresh')
    }
    // Unset / blank / unrecognized fall back to the interactive prompt.
    for (const none of ['', '  ', 'huh?', undefined]) {
      expect(parseSyncMode(none)).toBeNull()
    }
  })

  test('parses the quit-official-app confirm (default No)', async () => {
    const { parseQuitAnswer } = await import('../scripts/dev-data-setup.mjs')

    for (const yes of ['y', 'Y', 'yes', 'YES', '  yes  ']) {
      expect(parseQuitAnswer(yes)).toBe(true)
    }
    for (const no of ['', '  ', 'n', 'no', 'nope', 'sync', undefined]) {
      expect(parseQuitAnswer(no)).toBe(false)
    }
  })

  test('maps a convention-path worktree to its dev twin keeping the full sub-path', async () => {
    const { mapWorktreeDevPath } = await import('../scripts/dev-data-setup.mjs')

    const legacyWorktreesDir = '/home/me/.hive-worktrees'
    const devWorktreesDir = '/home/me/.hive-dev-worktrees'
    const prodPath = `${legacyWorktreesDir}/my-proj/my-proj--golden-retriever`

    expect(
      mapWorktreeDevPath(prodPath, {
        legacyWorktreesDir,
        devWorktreesDir,
        projectName: 'my-proj'
      })
    ).toBe(`${devWorktreesDir}/my-proj/my-proj--golden-retriever`)
  })

  test('consolidates a foreign-path worktree under devWorktreesDir/<project>/<basename>', async () => {
    const { mapWorktreeDevPath } = await import('../scripts/dev-data-setup.mjs')

    const legacyWorktreesDir = '/home/me/.hive-worktrees'
    const devWorktreesDir = '/home/me/.hive-dev-worktrees'
    // A worktree the user created at a custom location (sibling of the repo).
    const prodPath = '/home/me/Personal/wellifiy-ror-standalone-1'

    expect(
      mapWorktreeDevPath(prodPath, {
        legacyWorktreesDir,
        devWorktreesDir,
        projectName: 'wellifiy-ror'
      })
    ).toBe(`${devWorktreesDir}/wellifiy-ror/wellifiy-ror-standalone-1`)
  })

  test('foreign-path mapping sanitizes the project segment and tolerates a missing name', async () => {
    const { mapWorktreeDevPath } = await import('../scripts/dev-data-setup.mjs')

    const legacyWorktreesDir = '/home/me/.hive-worktrees'
    const devWorktreesDir = '/home/me/.hive-dev-worktrees'
    const prodPath = '/tmp/custom/wt-foo'

    // A name containing separators / leading dots can't escape devWorktreesDir.
    expect(
      mapWorktreeDevPath(prodPath, {
        legacyWorktreesDir,
        devWorktreesDir,
        projectName: '../evil/name'
      })
    ).toBe(`${devWorktreesDir}/evil-name/wt-foo`)

    // No project name → fall back to devWorktreesDir/<basename>.
    expect(
      mapWorktreeDevPath(prodPath, { legacyWorktreesDir, devWorktreesDir, projectName: '' })
    ).toBe(`${devWorktreesDir}/wt-foo`)
  })

  test('prefixes cloned branches with hive-dev_, leaving detached unchanged', async () => {
    const { devBranchName } = await import('../scripts/dev-data-setup.mjs')

    expect(devBranchName('golden-retriever')).toBe('hive-dev_golden-retriever')
    expect(devBranchName('feature/x')).toBe('hive-dev_feature/x')
    expect(devBranchName('HEAD', { detached: true })).toBe('HEAD')
  })

  test('connection instructions embed the given (dev) connection + worktree paths', async () => {
    const { buildConnectionInstructions } = await import('../scripts/dev-data-setup.mjs')

    const content = buildConnectionInstructions('/Users/me/.hive-dev/connections/abc', [
      {
        symlinkName: 'web',
        projectName: 'Web',
        branchName: 'hive-dev_main',
        worktreePath: '/Users/me/.hive-dev-worktrees/web/web--main'
      }
    ])

    // The active path the agent is told to stay inside is the dev copy…
    expect(content).toContain('(`/Users/me/.hive-dev/connections/abc`)')
    expect(content).toContain('**Real path:** /Users/me/.hive-dev-worktrees/web/web--main')
    // …and never the official locations.
    expect(content).not.toContain('/.hive/connections/')
    expect(content).not.toContain('/.hive-worktrees/')
  })

  test('connection instructions render an empty Projects list with no members', async () => {
    const { buildConnectionInstructions } = await import('../scripts/dev-data-setup.mjs')

    const content = buildConnectionInstructions('/Users/me/.hive-dev/connections/abc', [])

    expect(content).toContain('## Projects')
    expect(content).not.toContain('**Real path:**')
  })
})
