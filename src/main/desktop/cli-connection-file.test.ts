import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cliConnectionFilePath,
  removeCliConnectionFile,
  writeCliConnectionFile
} from './cli-connection-file'

describe('cli connection file', () => {
  it('writes a versioned connection file into the instance data dir', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'hive-cli-conn-'))
    writeCliConnectionFile(baseDir, {
      port: 3777,
      bootstrapToken: 'a'.repeat(48),
      pid: 4242,
      startedAt: '2026-06-23T00:00:00.000Z'
    })

    const path = cliConnectionFilePath(baseDir)
    expect(path).toBe(join(baseDir, 'cli.json'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      port: 3777,
      bootstrapToken: 'a'.repeat(48),
      pid: 4242,
      startedAt: '2026-06-23T00:00:00.000Z'
    })
  })

  it('writes the file owner-only (0600) on POSIX', () => {
    if (process.platform === 'win32') return
    const baseDir = mkdtempSync(join(tmpdir(), 'hive-cli-conn-'))
    writeCliConnectionFile(baseDir, {
      port: 3777,
      bootstrapToken: 'b'.repeat(48),
      pid: 1,
      startedAt: '2026-06-23T00:00:00.000Z'
    })

    expect(statSync(cliConnectionFilePath(baseDir)).mode & 0o777).toBe(0o600)
  })

  it('overwrites an existing file atomically and leaves no temp file', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'hive-cli-conn-'))
    writeCliConnectionFile(baseDir, {
      port: 3777,
      bootstrapToken: 'a'.repeat(48),
      pid: 1,
      startedAt: '2026-06-23T00:00:00.000Z'
    })
    writeCliConnectionFile(baseDir, {
      port: 3801,
      bootstrapToken: 'c'.repeat(48),
      pid: 2,
      startedAt: '2026-06-23T01:00:00.000Z'
    })

    const path = cliConnectionFilePath(baseDir)
    expect(JSON.parse(readFileSync(path, 'utf8')).port).toBe(3801)
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('removes the connection file and is a no-op when absent', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'hive-cli-conn-'))
    writeCliConnectionFile(baseDir, {
      port: 3777,
      bootstrapToken: 'a'.repeat(48),
      pid: 1,
      startedAt: '2026-06-23T00:00:00.000Z'
    })

    removeCliConnectionFile(baseDir)
    expect(existsSync(cliConnectionFilePath(baseDir))).toBe(false)
    expect(() => removeCliConnectionFile(baseDir)).not.toThrow()
  })
})
