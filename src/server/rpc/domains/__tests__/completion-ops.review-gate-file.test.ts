import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readReviewGateFile } from '../completion-ops'

/**
 * Part E — file-first verdict. `readReviewGateFile` reads
 * `<cwd>/.hive/review-gate.json`, returns the agent's own verdict + reason + fixes
 * (source `review-gate.json`) when valid, and returns null (→ LLM fallback) on a
 * missing cwd, missing/garbage file, or a schema mismatch.
 */
describe('readReviewGateFile', () => {
  let dir: string
  const writeGate = (contents: string): void => {
    mkdirSync(join(dir, '.hive'), { recursive: true })
    writeFileSync(join(dir, '.hive', 'review-gate.json'), contents, 'utf-8')
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-review-gate-'))
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
    expect(readReviewGateFile(dir)).toEqual({
      verdict: 'fix',
      reason: 'schema drifted',
      fixes: ['git checkout master -- db/schema.rb', 'pnpm test'],
      source: 'review-gate.json'
    })
  })

  it('synthesizes a reason when the file omits one, and tolerates extra keys', () => {
    writeGate(JSON.stringify({ verdict: 'pass', extra: 'ignored' }))
    expect(readReviewGateFile(dir)).toEqual({
      verdict: 'pass',
      reason: 'review-gate.json: pass',
      fixes: [],
      source: 'review-gate.json'
    })
  })

  it('returns null (→ LLM fallback) for an undefined cwd', () => {
    expect(readReviewGateFile(undefined)).toBeNull()
  })

  it('returns null (→ LLM fallback) when the file is missing', () => {
    expect(readReviewGateFile(dir)).toBeNull()
  })

  it('returns null (→ LLM fallback) for garbage JSON', () => {
    writeGate('{ not valid json')
    expect(readReviewGateFile(dir)).toBeNull()
  })

  it('returns null (→ LLM fallback) for an unknown verdict (schema mismatch)', () => {
    writeGate(JSON.stringify({ verdict: 'maybe' }))
    expect(readReviewGateFile(dir)).toBeNull()
  })
})
