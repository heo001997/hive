// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildHiveCliEnv,
  resolveHiveTicketCliPath,
  setHiveCliConnection
} from './hive-cli-connection'

let tmp: string
const savedEnv = process.env.HIVE_TICKET_CLI

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hive-cli-conn-'))
  delete process.env.HIVE_TICKET_CLI
})

afterEach(() => {
  setHiveCliConnection(null)
  rmSync(tmp, { recursive: true, force: true })
  if (savedEnv === undefined) delete process.env.HIVE_TICKET_CLI
  else process.env.HIVE_TICKET_CLI = savedEnv
})

describe('resolveHiveTicketCliPath', () => {
  it('prefers an existing HIVE_TICKET_CLI override over every search dir', () => {
    const override = join(tmp, 'override.mjs')
    writeFileSync(override, '// override')
    const searchDir = join(tmp, 'cli')
    writeFileSync(join(tmp, 'cli-dummy'), '') // ensure tmp exists; searchDir has no file
    process.env.HIVE_TICKET_CLI = override
    expect(resolveHiveTicketCliPath([searchDir])).toBe(override)
  })

  it('ignores a HIVE_TICKET_CLI override that does not exist and falls to a search dir', () => {
    process.env.HIVE_TICKET_CLI = join(tmp, 'does-not-exist.mjs')
    const bundled = join(tmp, 'hive-ticket.mjs')
    writeFileSync(bundled, '// bundled')
    expect(resolveHiveTicketCliPath([tmp])).toBe(bundled)
  })

  it('resolves the bundled hive-ticket.mjs from the first search dir that has it', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'hive-cli-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'hive-cli-b-'))
    const bundledB = join(dirB, 'hive-ticket.mjs')
    writeFileSync(bundledB, '// bundled')
    try {
      // dirA has no file → skip; dirB wins (proves bundled beats the global skill).
      expect(resolveHiveTicketCliPath([dirA, dirB])).toBe(bundledB)
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })
})

describe('buildHiveCliEnv', () => {
  it('returns an empty env when no connection is set', () => {
    setHiveCliConnection(null)
    expect(buildHiveCliEnv({})).toEqual({})
  })

  it('injects the connection details plus the setup-resolved ticketCliPath', () => {
    setHiveCliConnection({
      host: '127.0.0.1',
      port: 3800,
      bootstrapToken: 'boot-tok',
      baseDir: '/data/dir',
      ticketCliPath: '/opt/hive/cli/hive-ticket.mjs'
    })
    const env = buildHiveCliEnv({ projectId: 'proj-1', worktreeId: 'wt-1' })
    expect(env).toMatchObject({
      HIVE_HOST: '127.0.0.1',
      HIVE_PORT: '3800',
      HIVE_DATA_DIR: '/data/dir',
      HIVE_DESKTOP_BOOTSTRAP_TOKEN: 'boot-tok',
      HIVE_PROJECT_ID: 'proj-1',
      HIVE_WORKTREE_ID: 'wt-1',
      HIVE_TICKET_CLI: '/opt/hive/cli/hive-ticket.mjs'
    })
  })

  it('omits HIVE_PROJECT_ID / HIVE_WORKTREE_ID when the context lacks them', () => {
    setHiveCliConnection({
      host: '127.0.0.1',
      port: 3800,
      bootstrapToken: 'boot-tok',
      baseDir: '/data/dir',
      ticketCliPath: null
    })
    const env = buildHiveCliEnv({})
    expect(env.HIVE_PROJECT_ID).toBeUndefined()
    expect(env.HIVE_WORKTREE_ID).toBeUndefined()
  })

  it('falls back to env-based resolution when ticketCliPath is null', () => {
    const override = join(tmp, 'fallback.mjs')
    writeFileSync(override, '// fallback')
    process.env.HIVE_TICKET_CLI = override
    setHiveCliConnection({
      host: '127.0.0.1',
      port: 3800,
      bootstrapToken: 'boot-tok',
      baseDir: '/data/dir',
      ticketCliPath: null
    })
    expect(buildHiveCliEnv({}).HIVE_TICKET_CLI).toBe(override)
  })
})
