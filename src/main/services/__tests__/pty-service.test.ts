import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectDescendants, ptyService } from '../pty-service'

const nodePtyMocks = vi.hoisted(() => ({
  spawn: vi.fn()
}))

vi.mock('node-pty', () => ({
  spawn: nodePtyMocks.spawn
}))

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

function makeFakePty(): Record<string, unknown> {
  return {
    cols: 80,
    rows: 24,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn()
  }
}

function spawnedEnv(): Record<string, string> {
  const call = nodePtyMocks.spawn.mock.calls.at(-1)
  return call?.[2].env as Record<string, string>
}

describe('ptyService.create spawn environment', () => {
  const savedEnv: Record<string, string | undefined> = {}
  const touchedKeys = ['COLUMNS', 'LINES', 'TERM', 'COLORTERM'] as const
  let nextId = 0

  beforeEach(() => {
    for (const key of touchedKeys) savedEnv[key] = process.env[key]
    nodePtyMocks.spawn.mockImplementation(() => makeFakePty())
  })

  afterEach(() => {
    for (const key of touchedKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    vi.clearAllMocks()
  })

  function create(opts: Record<string, unknown> = {}): void {
    ptyService.create(`pty-env-test-${nextId++}`, { cwd: '/tmp', ...opts })
  }

  it('strips COLUMNS and LINES inherited from the login shell env', () => {
    process.env.COLUMNS = '80'
    process.env.LINES = '24'

    create()

    expect(spawnedEnv().COLUMNS).toBeUndefined()
    expect(spawnedEnv().LINES).toBeUndefined()
  })

  it('forces TERM and COLORTERM regardless of the inherited values', () => {
    process.env.TERM = 'dumb'
    process.env.COLORTERM = ''

    create()

    expect(spawnedEnv().TERM).toBe('xterm-256color')
    expect(spawnedEnv().COLORTERM).toBe('truecolor')
  })

  it('keeps explicit caller env overrides, including COLUMNS', () => {
    process.env.COLUMNS = '80'

    create({ env: { COLUMNS: '120', HIVE_TEST_VAR: 'yes' } })

    expect(spawnedEnv().COLUMNS).toBe('120')
    expect(spawnedEnv().HIVE_TEST_VAR).toBe('yes')
  })
})

describe('collectDescendants', () => {
  it('walks the whole subtree, not just direct children', () => {
    // 100 (leader) -> 200 (claude) -> 300 (mcp wrapper) -> 400 (mcp node child)
    const rows = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
      { pid: 400, ppid: 300 },
      { pid: 999, ppid: 1 } // unrelated sibling tree
    ]
    expect(collectDescendants(rows, 100).sort((a, b) => a - b)).toEqual([200, 300, 400])
  })

  it('reaches a grandchild that setsid\'d into its own group', () => {
    // The setsid'd child still lists its real ppid in `ps`, so the tree walk
    // finds it even though a kill(-pgid) on the leader never would.
    const rows = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 555, ppid: 200 } // own pgid, but ppid still points at the leader's child
    ]
    expect(collectDescendants(rows, 100)).toContain(555)
  })

  it('excludes the root itself and returns empty for a childless leader', () => {
    expect(collectDescendants([{ pid: 100, ppid: 1 }], 100)).toEqual([])
  })

  it('does not loop forever on a malformed cyclic listing', () => {
    const rows = [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 100, ppid: 200 } // bogus cycle back to the root
    ]
    expect(collectDescendants(rows, 100)).toEqual([200])
  })
})
