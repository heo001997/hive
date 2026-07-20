import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readReviewGateFile, reviewGateFilePath } from '../completion-ops'

/**
 * Part E — file-first verdict. `readReviewGateFile` reads the verdict file at the
 * absolute path it is given (the Hive-owned, OUT-OF-REPO path from
 * `reviewGateFilePath`), returns the agent's own verdict + reason + fixes (source
 * `review-gate.json`) when valid, and returns null (→ fallback) on a missing path,
 * missing/garbage file, or a schema mismatch.
 */
describe('readReviewGateFile', () => {
  let dir: string
  let gatePath: string
  const writeGate = (contents: string): void => {
    mkdirSync(dirname(gatePath), { recursive: true })
    writeFileSync(gatePath, contents, 'utf-8')
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-review-gate-'))
    gatePath = reviewGateFilePath(dir, 't1')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the verdict + reason + trimmed fixes for a valid file', () => {
    writeGate(
      JSON.stringify({
        verdict: 'fix',
        reason: 'schema drifted',
        fixes: ['  git checkout master -- db/schema.rb  ', '', '  pnpm test  ']
      })
    )
    expect(readReviewGateFile(gatePath)).toEqual({
      verdict: 'fix',
      reason: 'schema drifted',
      fixes: ['git checkout master -- db/schema.rb', 'pnpm test'],
      source: 'review-gate.json'
    })
  })

  it('synthesizes a reason when the file omits one, and tolerates extra keys', () => {
    writeGate(JSON.stringify({ verdict: 'pass', extra: 'ignored' }))
    expect(readReviewGateFile(gatePath)).toEqual({
      verdict: 'pass',
      reason: 'review-gate.json: pass',
      fixes: [],
      source: 'review-gate.json'
    })
  })

  it('returns null (→ fallback) for an undefined path', () => {
    expect(readReviewGateFile(undefined)).toBeNull()
  })

  it('returns null (→ fallback) when the file is missing', () => {
    expect(readReviewGateFile(gatePath)).toBeNull()
  })

  it('returns null (→ fallback) for garbage JSON', () => {
    writeGate('{ not valid json')
    expect(readReviewGateFile(gatePath)).toBeNull()
  })

  it('returns null (→ fallback) for an unknown verdict (schema mismatch)', () => {
    writeGate(JSON.stringify({ verdict: 'maybe' }))
    expect(readReviewGateFile(gatePath)).toBeNull()
  })
})

/**
 * The Hive-owned verdict path is OUTSIDE the reviewed repo (under the data dir),
 * keyed by ticket id, and sanitizes unsafe id characters into a single path segment.
 */
describe('reviewGateFilePath', () => {
  it('nests review-gates/<ticketId>/review-gate.json under the data dir', () => {
    expect(reviewGateFilePath('/home/u/.hive', 't1')).toBe(
      join('/home/u/.hive', 'review-gates', 't1', 'review-gate.json')
    )
  })

  it('sanitizes path-unsafe characters in the ticket id (no traversal / nesting)', () => {
    const p = reviewGateFilePath('/data', '../weird/id 2822')
    expect(p).toBe(join('/data', 'review-gates', '.._weird_id_2822', 'review-gate.json'))
    expect(p).not.toContain('..' + '/weird')
  })
})
